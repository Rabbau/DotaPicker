/*
 * Собирает модель оценки драфта для режима «Пик-трейнинг» → draft-model.js
 *   npm run build:model                 (полная сборка, ~20–30 минут)
 *   npm run build:model -- --refit      (только пересчитать веса по уже скачанным данным, без токена и интернета)
 *
 * Источники:
 *   STRATZ API  — сила героев (в целом и на каждой позиции 1–5), синергии, контрпики, роли героев,
 *                 а также реальные позиции игроков в проверочных матчах.
 *                 Нужен токен: файл .stratz-token в корне проекта или переменная STRATZ_TOKEN.
 *   OpenDota    — список недавних рейтинговых матчей с исходами (в STRATZ API нет выборки матчей по рангу).
 *                 На этих матчах (с позициями из STRATZ) подбираются веса и проверяется точность.
 *
 * Модель — логистическая регрессия:
 *   перевес = сторона + kГ·(сила героев) + kС·(синергии) + kК·(контрпики)
 *           + kП·(сила героев на своих позициях) + kН·(непривычные позиции) + Σ kᵢ·(роли)
 *   шанс Radiant = 1 / (1 + e^(−перевес))
 * На сайте сторона в шанс не входит — оценивается только драфт.
 * Скачанные данные сохраняются в data/model-cache/ (папка хранится в репозитории).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const HEROES = require('../heroes.js');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'model-cache');
const OUT = path.join(ROOT, 'draft-model.js');
const REFIT = process.argv.includes('--refit');

// Основная группа (base) — на ней подбираются все веса. На низких рангах среди публичных матчей OpenDota
// почти всё турбо, а рейтинговых игр лишь 6–9%, поэтому там подстраиваются только сторона и общий масштаб.
const BRACKETS = [
  { key: 'divine_immortal', label: 'Divine – Immortal', stratz: 'DIVINE_IMMORTAL', od: '&min_rank=70', target: 18000, base: true },
  { key: 'legend_ancient', label: 'Legend – Ancient', stratz: 'LEGEND_ANCIENT', od: '&min_rank=50&max_rank=65', target: 4500 },
  { key: 'all', label: 'Все ранги', stratz: null, od: '&min_rank=10', target: 4500 },
];
const RANKED_MODES = new Set([22, 2, 16, 3, 1]); // All Pick ranked, CM, CD, Random Draft, All Pick
const SHRINK_PAIR = 200;   // сколько «нейтральных» игр добавлять к паре героев (защита от малых выборок)
const SHRINK_HERO = 1000;  // то же для винрейта героя
const SHRINK_POS = 300;    // винрейт на позиции сглаживается к общему винрейту героя
const ROLE_NAMES = ['Carry', 'Support', 'Nuker', 'Disabler', 'Initiator', 'Durable', 'Escape', 'Pusher'];
const COMP_FEATURES = [...ROLE_NAMES.map((r) => ({ key: r, label: r })), { key: 'Melee', label: 'Melee' }];
const MATCHES_PER_QUERY = 50; // STRATZ: пакетный matches() только для админов, поэтому 50 запросов match() с псевдонимами

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ---------- Загрузка с повторами и кешем ---------- */

async function fetchJson(url, opts = {}, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) }); // зависшие соединения обрываем
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`), { fatal: true });
      return JSON.parse(text);
    } catch (e) {
      if (e.fatal || i >= tries - 1) throw e;
      await sleep(1500 * 2 ** i);
    }
  }
}

function cached(name, fn) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (REFIT) throw new Error(`Нет кеша ${name} — запустите полную сборку без --refit`);
  return fn().then((data) => {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  });
}

function stratzToken() {
  if (process.env.STRATZ_TOKEN) return process.env.STRATZ_TOKEN.trim();
  const f = path.join(ROOT, '.stratz-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

async function stratz(query) {
  const token = stratzToken();
  if (!token) throw new Error('Нет токена STRATZ: положите его в файл .stratz-token или в переменную STRATZ_TOKEN');
  const d = await fetchJson('https://api.stratz.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' },
    body: JSON.stringify({ query }),
  });
  if (d.errors && !d.data) throw new Error('STRATZ: ' + JSON.stringify(d.errors).slice(0, 300));
  return d.data;
}

/* ---------- Данные STRATZ ---------- */

async function loadStratz(br) {
  const arg = br.stratz ? `bracketBasicIds: [${br.stratz}]` : '';
  const stats = await cached(`stratz-stats-${br.key}.json`, async () =>
    (await stratz(`{ heroStats { stats${arg ? `(${arg})` : ''} { heroId matchCount winCount } } }`)).heroStats.stats);

  // Винрейт и число игр героя на каждой позиции 1–5
  const posStats = await cached(`stratz-posstats-${br.key}.json`, async () =>
    (await stratz(`{ heroStats { stats(${arg ? arg + ', ' : ''}groupByPosition: true) { heroId position matchCount winCount } } }`)).heroStats.stats
      .filter((s) => /^POSITION_[1-5]$/.test(s.position))
      .map((s) => [s.heroId, +s.position.slice(-1), s.matchCount, s.winCount]));

  const matchups = await cached(`stratz-matchups-${br.key}.json`, async () => {
    const out = {};
    const ids = HEROES.map((h) => h.id);
    let done = 0;
    const worker = async () => {
      while (ids.length) {
        const id = ids.shift();
        const d = await stratz(`{ heroStats { heroVsHeroMatchup(heroId: ${id}, ${arg} take: 200) {
          advantage { heroId with { heroId2 matchCount synergy } vs { heroId2 matchCount synergy } } } } }`);
        const a = d.heroStats.heroVsHeroMatchup.advantage[0] || { with: [], vs: [] };
        out[id] = { with: a.with.map((x) => [x.heroId2, x.matchCount, +x.synergy]), vs: a.vs.map((x) => [x.heroId2, x.matchCount, +x.synergy]) };
        done++;
        if (done % 20 === 0) log(`    STRATZ ${br.label}: ${done}/${HEROES.length} героев`);
        await sleep(300);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  });
  return { stats, posStats, matchups };
}

/* ---------- Матчи: список из OpenDota, позиции игроков из STRATZ ---------- */

async function loadMatches(br) {
  return cached(`opendota-matches2-${br.key}.json`, async () => {
    const rows = [];
    let lt = null;
    let pages = 0;
    while (rows.length < br.target) {
      const url = `https://api.opendota.com/api/publicMatches?${br.od.slice(1)}${lt ? '&less_than_match_id=' + lt : ''}`;
      const page = await fetchJson(url);
      if (!page.length) break;
      for (const m of page) {
        const ok = m.radiant_team?.length === 5 && m.dire_team?.length === 5 &&
          m.radiant_team.every((h) => h > 0) && m.dire_team.every((h) => h > 0) && RANKED_MODES.has(m.game_mode) && m.duration > 600;
        if (ok) rows.push([m.match_id, m.radiant_team, m.dire_team, m.radiant_win ? 1 : 0]);
      }
      lt = Math.min(...page.map((m) => m.match_id));
      if (++pages % 25 === 0) log(`    OpenDota ${br.label}: ${rows.length}/${br.target} матчей (${pages} стр.)`);
      await sleep(1100); // лимит OpenDota — 60 запросов в минуту
    }
    return rows;
  });
}

// Позиции 1–5 для каждого героя матча: { matchId: [[позиции Radiant по порядку героев], [позиции Dire]] }
async function loadPositions(br, matches) {
  return cached(`stratz-positions-${br.key}.json`, async () => {
    const out = {};
    const queue = matches.slice();
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const chunk = queue.splice(0, MATCHES_PER_QUERY);
        const q = chunk.map(([id], i) => `m${i}: match(id: ${id}) { players { heroId isRadiant position } }`).join(' ');
        const d = (await stratz(`{ ${q} }`)) || {};
        chunk.forEach(([id, rad, dire], i) => {
          const m = d[`m${i}`];
          if (!m || !m.players || m.players.length !== 10) return;
          const pos = new Map(m.players.map((p) => [p.heroId, /^POSITION_[1-5]$/.test(p.position) ? +p.position.slice(-1) : 0]));
          const rp = rad.map((h) => pos.get(h) || 0);
          const dp = dire.map((h) => pos.get(h) || 0);
          const perm = (a) => [...a].sort().join('') === '12345';
          if (perm(rp) && perm(dp)) out[id] = [rp, dp];
        });
        done += chunk.length;
        if (done % 2000 < MATCHES_PER_QUERY) log(`    STRATZ позиции ${br.label}: ${done}/${matches.length} матчей`);
        await sleep(400);
      }
    };
    await Promise.all([worker(), worker()]);
    return out;
  });
}

/* ---------- Сборка таблиц модели ---------- */

const N = HEROES.length;
const IDS = HEROES.map((h) => h.id);
const IDX = new Map(IDS.map((id, i) => [id, i]));
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
// «Непривычность» позиции: 0 для основной позиции героя, до 2,7 для позиций, где его почти не играют
const rarity = (share) => Math.min(2.7, -Math.log10(share + 0.002));

function buildTables({ stats, posStats, matchups }) {
  // Сила героя: логит винрейта со сглаживанием к 50%
  const hero = new Array(N).fill(0);
  for (const s of stats) {
    const i = IDX.get(s.heroId);
    if (i == null) continue;
    hero[i] = logit((s.winCount + 0.5 * SHRINK_HERO) / (s.matchCount + SHRINK_HERO));
  }
  // Позиции: поправка к силе героя на конкретной позиции и доля игр героя на ней
  const posAdj = new Float64Array(N * 5);
  const share = new Float64Array(N * 5);
  const total = new Float64Array(N);
  for (const [id, , n] of posStats) { const i = IDX.get(id); if (i != null) total[i] += n; }
  for (const [id, p, n, w] of posStats) {
    const i = IDX.get(id);
    if (i == null) continue;
    const prior = sigmoid(hero[i]);
    posAdj[i * 5 + p - 1] = logit((w + prior * SHRINK_POS) / (n + SHRINK_POS)) - hero[i];
    share[i * 5 + p - 1] = total[i] ? n / total[i] : 0;
  }
  // Синергия (симметричная) и преимущество (антисимметричное), в процентных пунктах, со сглаживанием
  const syn = new Float64Array(N * N);
  const synW = new Float64Array(N * N);
  const adv = new Float64Array(N * N);
  const advW = new Float64Array(N * N);
  for (const [idStr, m] of Object.entries(matchups)) {
    const i = IDX.get(+idStr);
    if (i == null) continue;
    for (const [id2, n, v] of m.with) {
      const j = IDX.get(id2);
      if (j == null || j === i) continue;
      const s = v * n / (n + SHRINK_PAIR);
      syn[i * N + j] += s; synW[i * N + j]++;
      syn[j * N + i] += s; synW[j * N + i]++;
    }
    for (const [id2, n, v] of m.vs) {
      const j = IDX.get(id2);
      if (j == null || j === i) continue;
      const s = v * n / (n + SHRINK_PAIR);
      adv[i * N + j] += s; advW[i * N + j]++;
      adv[j * N + i] -= s; advW[j * N + i]++;
    }
  }
  for (let k = 0; k < N * N; k++) {
    if (synW[k]) syn[k] /= synW[k];
    if (advW[k]) adv[k] /= advW[k];
  }
  return { hero, posAdj, share, syn, adv };
}

// Самая правдоподобная расстановка пятёрки героев по позициям (как defaultPositions в evaluator.js)
const PERMS = (() => {
  const out = [];
  const rec = (rest, acc) => (rest.length ? rest.forEach((p, k) => rec(rest.filter((_, j) => j !== k), [...acc, p])) : out.push(acc));
  rec([1, 2, 3, 4, 5], []);
  return out;
})();
function likelyPositions(t, team) {
  const idx = team.map((id) => IDX.get(id));
  let best = PERMS[0];
  let bestScore = -Infinity;
  for (const perm of PERMS) {
    const s = perm.reduce((acc, p, k) => acc + Math.log(t.share[idx[k] * 5 + p - 1] + 0.001), 0);
    if (s > bestScore) { bestScore = s; best = perm; }
  }
  return best;
}

/* ---------- Признаки матча (то же считает evaluator.js) ---------- */

// Роли героя из STRATZ: уровень 0–3 для каждой роли + ближний бой (1/0)
function roleTable(stratzHeroes) {
  const byId = new Map(stratzHeroes.map((h) => [h.id, h]));
  return IDS.map((id) => {
    const h = byId.get(id) || { roles: [], stats: {} };
    const level = (name) => (h.roles.find((r) => r.roleId === name.toUpperCase()) || { level: 0 }).level;
    return [...ROLE_NAMES.map(level), h.stats && h.stats.attackType === 'Melee' ? 1 : 0];
  });
}

// rp / dp — позиции героев (1–5) в том же порядке, что и rad / dire
function features(t, roles, rad, dire, rp, dp) {
  const r = rad.map((id) => IDX.get(id));
  const d = dire.map((id) => IDX.get(id));
  let H = 0, S = 0, A = 0, P = 0, O = 0;
  r.forEach((i, k) => { H += t.hero[i]; P += t.posAdj[i * 5 + rp[k] - 1]; O += rarity(t.share[i * 5 + rp[k] - 1]); });
  d.forEach((i, k) => { H -= t.hero[i]; P -= t.posAdj[i * 5 + dp[k] - 1]; O -= rarity(t.share[i * 5 + dp[k] - 1]); });
  for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) S += t.syn[r[a] * N + r[b]];
  for (let a = 0; a < d.length; a++) for (let b = a + 1; b < d.length; b++) S -= t.syn[d[a] * N + d[b]];
  for (const i of r) for (const j of d) A += t.adv[i * N + j];
  // Состав: сумма уровней роли в команде (с потолком — «много контроля» сверх меры уже не помогает)
  const C = COMP_FEATURES.map((_, k) => {
    const cap = k === COMP_FEATURES.length - 1 ? 5 : 6;
    const cnt = (team) => Math.min(team.reduce((s, i) => s + roles[i][k], 0), cap);
    return (cnt(r) - cnt(d)) / 3;
  });
  return [H, S / 10, A / 10, P, O, ...C];
}

/* ---------- Логистическая регрессия (метод Ньютона, L2) ---------- */

function fitLogistic(X, y, lambda) {
  const p = X[0].length + 1; // + свободный член (сторона)
  let w = new Array(p).fill(0);
  for (let it = 0; it < 30; it++) {
    const g = new Array(p).fill(0);
    const Hm = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let n = 0; n < X.length; n++) {
      const x = [1, ...X[n]];
      const z = x.reduce((s, v, k) => s + v * w[k], 0);
      const pr = 1 / (1 + Math.exp(-z));
      const r = pr - y[n];
      const ww = pr * (1 - pr);
      for (let a = 0; a < p; a++) {
        g[a] += r * x[a];
        for (let b = a; b < p; b++) Hm[a][b] += ww * x[a] * x[b];
      }
    }
    for (let a = 1; a < p; a++) { g[a] += lambda * w[a]; Hm[a][a] += lambda; }
    for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) Hm[a][b] = Hm[b][a];
    const step = solve(Hm, g);
    w = w.map((v, k) => v - step[k]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return w;
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[c][c]) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function evaluate(w, X, y) {
  let acc = 0, ll = 0, brier = 0;
  const buckets = {};
  X.forEach((x, n) => {
    const z = [1, ...x].reduce((s, v, k) => s + v * w[k], 0);
    const p = 1 / (1 + Math.exp(-z));
    acc += (p >= 0.5) === (y[n] === 1) ? 1 : 0;
    ll -= y[n] ? Math.log(p) : Math.log(1 - p);
    brier += (p - y[n]) ** 2;
    const b = Math.min(9, Math.floor(p * 10));
    (buckets[b] = buckets[b] || [0, 0, 0]);
    buckets[b][0]++; buckets[b][1] += p; buckets[b][2] += y[n];
  });
  return {
    accuracy: acc / X.length, logloss: ll / X.length, brier: brier / X.length, n: X.length,
    calibration: Object.keys(buckets).sort().map((b) => ({ bucket: +b, n: buckets[b][0], predicted: buckets[b][1] / buckets[b][0], actual: buckets[b][2] / buckets[b][0] })),
  };
}

// Детерминированное перемешивание, чтобы разбиение train/test было воспроизводимым
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const pct = (v) => (v * 100).toFixed(1) + '%';
const dropPos = (x) => [x[0], x[1], x[2], ...x.slice(5)]; // признаки без позиций — для сравнения

/* ---------- Главная ---------- */

(async () => {
  log('Сборка модели оценки драфта');
  const stratzHeroes = await cached('stratz-heroes.json', async () =>
    (await stratz('{ constants { heroes { id roles { roleId level } stats { attackType } } } }')).constants.heroes);
  const roles = roleTable(stratzHeroes);
  const model = {
    version: 2,
    builtAt: new Date().toISOString().slice(0, 10),
    source: 'STRATZ (сила героев по позициям, синергии, контрпики, роли, позиции в матчах); веса подобраны на матчах OpenDota',
    heroIds: IDS,
    compFeatures: COMP_FEATURES.map((f) => f.key),
    roles,
    brackets: {},
  };

  let baseW = null;
  let baseNoPos = null;
  for (const br of BRACKETS) {
    log(`\n▶ ${br.label}`);
    log('  Загрузка STRATZ…');
    const t = buildTables(await loadStratz(br));
    log('  Загрузка матчей OpenDota…');
    const all = await loadMatches(br);
    let positions;
    if (br.base) {
      log('  Загрузка позиций игроков из STRATZ…');
      positions = await loadPositions(br, all);
    } else {
      // STRATZ хранит в основном матчи высоких рангов — для этих матчей позиций у него нет.
      // Берём самую правдоподобную расстановку по долям игр героев на позициях.
      positions = Object.fromEntries(all.map(([id, r, d]) => [id, [likelyPositions(t, r), likelyPositions(t, d)]]));
      log('  Позиции: самые частые для героев (STRATZ не хранит позиции матчей этих рангов)');
    }
    const matches = seededShuffle(all.filter((m) => positions[m[0]]), 42);
    log(`  Матчей с позициями: ${matches.length} из ${all.length}`);

    const X = matches.map(([id, r, d]) => features(t, roles, r, d, positions[id][0], positions[id][1]));
    const y = matches.map((m) => m[3]);
    const cut = Math.floor(X.length * 0.8);
    const X0 = X.map(dropPos);
    let w, wAll, w0;
    if (br.base) {
      // Основная группа: подбираем все веса
      w = fitLogistic(X.slice(0, cut), y.slice(0, cut), 5);
      wAll = fitLogistic(X, y, 5);
      w0 = fitLogistic(X0.slice(0, cut), y.slice(0, cut), 5);
      baseW = wAll;
      baseNoPos = fitLogistic(X0, y, 5);
    } else {
      // Остальные группы: свои данные STRATZ, а из весов подстраиваем только сторону и общий масштаб
      const adaptFit = (XX, bw, rows) => {
        const Z = XX.map((x) => [x.reduce((s, v, k) => s + v * bw[k + 1], 0)]);
        const ws = fitLogistic(rows ? Z.slice(0, rows) : Z, rows ? y.slice(0, rows) : y, 1);
        return [ws[0], ...bw.slice(1).map((v) => v * ws[1])];
      };
      w = adaptFit(X, baseW, cut);
      wAll = adaptFit(X, baseW);
      w0 = adaptFit(X0, baseNoPos, cut);
      log(`  Масштаб относительно Divine – Immortal: ×${(w[1] / baseW[1]).toFixed(2)}`);
    }
    const testX = X.slice(cut), testY = y.slice(cut);
    const test = evaluate(w, testX, testY);
    // На сайте шанс считается только по драфту (без бонуса стороны) — его точность и показываем
    const draftOnly = evaluate([0, ...w.slice(1)], testX, testY);
    const noPos = evaluate([0, ...w0.slice(1)], X0.slice(cut), testY);
    log(`  Обучение ${cut}, проверка ${X.length - cut} матчей`);
    log(`  Точность только по драфту: ${pct(draftOnly.accuracy)} с позициями, ${pct(noPos.accuracy)} без позиций (со стороной: ${pct(test.accuracy)})`);
    log(`  Log-loss: ${test.logloss.toFixed(4)} (монетка: 0.6931), Brier: ${test.brier.toFixed(4)}`);
    log('  Калибровка (предсказано → на деле):');
    for (const c of test.calibration) if (c.n >= 30) log(`    ${(c.predicted * 100).toFixed(0).padStart(3)}% → ${(c.actual * 100).toFixed(0).padStart(3)}%   (${c.n} матчей)`);
    log(`  Веса: сторона ${w[0].toFixed(3)}, герои ${w[1].toFixed(3)}, синергия ${w[2].toFixed(3)}, контрпики ${w[3].toFixed(3)}, позиция ${w[4].toFixed(3)}, непривычная позиция ${w[5].toFixed(3)}`);
    log(`  Веса ролей: ${COMP_FEATURES.map((f, k) => `${f.key} ${w[6 + k].toFixed(3)}`).join(', ')}`);

    // В модель идут веса, подобранные на всех матчах группы
    model.brackets[br.key] = {
      label: br.label,
      coef: {
        side: +wAll[0].toFixed(5), hero: +wAll[1].toFixed(5), syn: +wAll[2].toFixed(5), adv: +wAll[3].toFixed(5),
        pos: +wAll[4].toFixed(5), offrole: +wAll[5].toFixed(5), comp: wAll.slice(6).map((v) => +v.toFixed(5)),
      },
      metrics: {
        accuracy: +draftOnly.accuracy.toFixed(4), accuracyNoPositions: +noPos.accuracy.toFixed(4), accuracyWithSide: +test.accuracy.toFixed(4),
        logloss: +test.logloss.toFixed(4), brier: +test.brier.toFixed(4), testMatches: test.n, trainMatches: cut,
      },
      hero: t.hero.map((v) => Math.round(v * 10000)),            // логит × 10000
      posAdj: Array.from(t.posAdj, (v) => Math.round(v * 10000)), // поправка на позицию, логит × 10000, [герой × 5 + позиция−1]
      posShare: Array.from(t.share, (v) => Math.round(v * 1000)), // доля игр героя на позиции × 1000
      syn: packUpper(t.syn),                                       // п.п. × 10, верхний треугольник
      adv: packUpper(t.adv),                                       // п.п. × 10, i против j для i < j (j против i = −значение)
    };
  }

  const body = JSON.stringify(model);
  fs.writeFileSync(OUT,
    '// Модель оценки драфта для режима «Пик-трейнинг». Сгенерировано: npm run build:model\n' +
    `const DRAFT_MODEL = ${body};\n\n` +
    "if (typeof module === 'object' && module.exports) module.exports = DRAFT_MODEL;\n");
  log(`\nГотово: draft-model.js (${Math.round(body.length / 1024)} КБ)`);
})().catch((e) => {
  console.error('\nОшибка:', e.message);
  process.exit(1);
});

function packUpper(m) {
  const out = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) out.push(Math.round(m[i * N + j] * 10));
  return out;
}
