'use strict';

const E = DraftEngine;
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const heroImg = (h) => `${CDN}/heroes/${h.key}.png`;
const HERO_BY_ID = new Map(HEROES.map((h) => [h.id, h]));
const ATTRS = [
  { key: 'str', label: 'Сила', icon: 'hero_strength' },
  { key: 'agi', label: 'Ловкость', icon: 'hero_agility' },
  { key: 'int', label: 'Интеллект', icon: 'hero_intelligence' },
  { key: 'all', label: 'Универсальный', icon: 'hero_universal' },
];
const RECENT_KEY = 'torneum-recent-v1';
const LOCAL_KEY = 'torneum-local-v1';
const HOST_KEY = 'torneum-host-v1';

// Модель пик-трейнинга (draft-model.js) — нужна в браузере для режима без сервера
const MODEL = typeof DRAFT_MODEL !== 'undefined' ? DRAFT_MODEL : null;
if (MODEL) E.setEvaluator((bracket, rad, dire) => DraftEvaluator.evaluate(MODEL, bracket, rad, dire));

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let view = null;        // { id, role, state, presence, keys, local }
let offset = 0;         // разница часов сервера и браузера
let transport = null;
let serverInfo = null;  // { port, addresses } — если страница открыта через сервер
let selected = null;
let lastStepKey = '';
let posDraft = { A: null, B: null }; // расстановка позиций, которую капитан ещё редактирует
let animatedCoin = null;

const now = () => Date.now() + offset;

/* ---------- Утилиты ---------- */

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* нет хранилища */ } }

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* небезопасный контекст */ }
  const ta = el('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
  return ok;
}

function showScreen(name) {
  $('setup').classList.toggle('hidden', name !== 'setup');
  $('draft').classList.toggle('hidden', name !== 'draft');
}

/* ---------- Транспорт: сервер или локально ---------- */

function remoteTransport(id, key) {
  const es = new EventSource(`/api/lobbies/${id}/stream?key=${encodeURIComponent(key || '')}`);
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    offset = d.serverNow - Date.now();
    setConn(true);
    onView(d);
  };
  es.onerror = () => setConn(false);
  return {
    async send(action) {
      const r = await fetch(`/api/lobbies/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, action }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Нет связи с сервером');
    },
  };
}

function localTransport() {
  const st = lsGet(LOCAL_KEY, null);
  const emit = () => {
    lsSet(LOCAL_KEY, st);
    onView({ id: 'local', role: 'admin', state: st, presence: { admin: true, A: true, B: true, spectators: 0 }, local: true });
  };
  setInterval(() => { if (E.tick(st, Date.now())) emit(); }, 250);
  setTimeout(emit);
  return { async send(action) { E.apply(st, 'admin', action, Date.now()); emit(); } };
}

function setConn(ok) {
  $('conn').className = 'conn ' + (ok ? 'ok' : 'bad');
  $('conn').title = ok ? 'Связь с сервером есть' : 'Нет связи с сервером — переподключаемся…';
}

function act(action) {
  transport.send(action).catch((e) => toast(e.message));
}

/* ---------- Хелперы состояния ---------- */

const st = () => view.state;
const map = () => E.curMap(view.state);
const teamName = (t) => (t === 'A' ? st().settings.nameA : st().settings.nameB);
const canAct = (team) => !!team && E.canControl(st(), view.role, team);

function sideOf(t) {
  const m = map();
  return m.sides ? m.sides[t] : null;
}
function sideCls(t) {
  const s = sideOf(t);
  return s === 'radiant' ? 'side-r' : s === 'dire' ? 'side-d' : 'side-n';
}
const coinFlying = (m) => !!m.coin && now() - m.coin.at < E.COIN_MS;

/* ---------- Получение состояния ---------- */

function onView(d) {
  view = d;
  const m = map();
  const key = `${view.state.maps.length}:${m.phase}:${m.actions.length}`;
  if (key !== lastStepKey) { selected = null; lastStepKey = key; posDraft = { A: null, B: null }; }
  showScreen('draft');
  render();
}

/* ---------- Отрисовка ---------- */

function heroTile(h, cls) {
  const d = el('div', cls);
  const img = el('img');
  img.src = heroImg(h);
  img.alt = h.name;
  d.title = h.name;
  d.appendChild(img);
  d.appendChild(el('span', 'hname', esc(h.name)));
  return d;
}

function render() {
  if (!view) return;
  const S = st();
  const s = S.settings;
  const m = map();
  const acting = E.actingTeam(S);
  const step = E.curStep(S);
  const flying = coinFlying(m);
  const leftTeam = m.sides ? (m.sides.A === 'radiant' ? 'A' : 'B') : 'A';

  // Шапка
  $('mapLabel').textContent = `Карта ${S.maps.length}`;
  $('bestOfLabel').textContent = `Bo${s.bestOf}${s.trainer ? ' · пик-трейнинг' : ''}`;
  for (const t of ['A', 'B']) {
    $('scoreName' + t).textContent = teamName(t);
    $('scoreName' + t).className = 'team-name ' + sideCls(t);
    $('score' + t).textContent = S.score[t];
  }
  const roleText = view.role === 'admin'
    ? (s.hotseat ? 'Админ · одно устройство' : 'Админ')
    : view.role === 'spectator' ? 'Зритель' : `Капитан · ${teamName(view.role)}`;
  $('roleChip').textContent = roleText;
  $('roleChip').className = 'role-chip ' + (view.role === 'A' || view.role === 'B' ? sideCls(view.role) : '');
  $('conn').classList.toggle('hidden', !!view.local);

  renderAdmin();

  // Строка хода
  const tb = $('turnBar');
  tb.className = 'turn-bar' + (acting && !flying ? ' turn ' + sideCls(acting) : '');
  let turn;
  if (S.over) {
    const w = S.score.A > S.score.B ? 'A' : 'B';
    turn = `Серия завершена — <b>${esc(teamName(w))}</b> побеждает ${S.score[w]}:${S.score[E.other(w)]}`;
  } else if (m.phase === 'coin') turn = 'Подброс монеты';
  else if (flying) turn = 'Монета в воздухе…';
  else if (m.phase === 'choice1' || m.phase === 'choice2') turn = `<b>${esc(teamName(acting))}</b> — выбор`;
  else if (step) turn = `<b>${esc(teamName(step.team))}</b> — ${step.type === 'pick' ? 'ПИК' : 'БАН'}`;
  else if (m.phase === 'positions') {
    turn = 'Расстановка позиций';
    if (!s.hotseat && ['A', 'B'].some((t) => canAct(t) && !m.positions[t])) turn += ' <span class="your-turn">ваш ход</span>';
  } else if (m.eval) turn = `Оценка драфта: <b class="side-r">${(m.eval.pRadiant * 100).toFixed(1)}%</b> : <b class="side-d">${(100 - m.eval.pRadiant * 100).toFixed(1)}%</b>`;
  else turn = 'Драфт завершён';
  if (acting && canAct(acting) && !flying && !S.over && !s.hotseat) turn += ' <span class="your-turn">ваш ход</span>';
  $('turnText').innerHTML = turn;

  // Порядок ходов
  const order = $('order');
  order.innerHTML = '';
  order.classList.toggle('hidden', !m.seq.length);
  m.seq.forEach((stp, i) => {
    const chip = el('div', `chip ${stp.type} ${sideCls(stp.team)}${i === m.actions.length && m.phase === 'draft' ? ' current' : ''}${i < m.actions.length ? ' done' : ''}`);
    const hid = m.actions[i];
    if (hid != null) { const img = el('img'); img.src = heroImg(HERO_BY_ID.get(hid)); chip.appendChild(img); }
    else chip.textContent = stp.type === 'pick' ? 'P' : 'B';
    chip.title = `${i + 1}. ${teamName(stp.team)} — ${stp.type === 'pick' ? 'пик' : 'бан'}`;
    order.appendChild(chip);
  });

  // Колонки команд: Radiant слева
  for (const pos of ['L', 'R']) {
    const t = pos === 'L' ? leftTeam : E.other(leftTeam);
    const side = sideOf(t);
    const col = $('col' + pos);
    col.className = `team-col ${side || 'neutral'}${acting === t && !flying && !S.over ? ' active' : ''}${view.role === t ? ' mine' : ''}`;
    $('side' + pos).textContent = side ? (side === 'radiant' ? 'Radiant' : 'Dire') : 'Сторона не выбрана';
    $('name' + pos).textContent = teamName(t);
    $('fp' + pos).classList.toggle('show', m.first === t);
    renderSlots(t, $('picks' + pos), $('bans' + pos));
  }

  renderPrep();
  renderPositions();
  renderPool();
  renderPreview();
  renderEval();
  renderResult();
  renderHistory();
  renderTimers();
}

function renderSlots(t, picks, bans) {
  const S = st();
  const m = map();
  picks.innerHTML = '';
  bans.innerHTML = '';
  if (!m.seq.length) {
    for (let i = 0; i < 5; i++) picks.appendChild(el('div', 'slot pick empty'));
    for (let i = 0; i < (S.settings.bans ? 4 : 0); i++) bans.appendChild(el('div', 'slot ban empty'));
    return;
  }
  m.seq.forEach((stp, i) => {
    if (stp.team !== t) return;
    const hid = m.actions[i];
    const isCur = i === m.actions.length && m.phase === 'draft';
    const target = stp.type === 'pick' ? picks : bans;
    if (hid != null) {
      const tile = heroTile(HERO_BY_ID.get(hid), `slot ${stp.type} filled`);
      const p = stp.type === 'pick' ? knownPosition(m, t, hid) : null;
      if (p) tile.appendChild(el('span', 'pos-badge', String(p)));
      target.appendChild(tile);
    } else {
      const slot = el('div', `slot ${stp.type} empty${isCur ? ' current' : ''}`);
      if (isCur && selected != null) slot.appendChild(heroTile(HERO_BY_ID.get(selected), 'ghost-tile'));
      target.appendChild(slot);
    }
  });
}

/* ---------- Пик-трейнинг: расстановка позиций ---------- */

const POS_NAMES = ['Керри', 'Мид', 'Оффлейн', 'Саппорт 4', 'Саппорт 5'];
const picksOf = (m, t) => m.actions.filter((_, i) => m.seq[i] && m.seq[i].type === 'pick' && m.seq[i].team === t);

// Позиция героя, если она уже известна этому зрителю (своя расстановка, открытая чужая или из оценки)
function knownPosition(m, t, heroId) {
  const own = m.positions && m.positions[t];
  if (own && !own.hidden && own[heroId]) return own[heroId];
  const h = m.eval && m.eval.heroes.find((x) => x.id === heroId);
  return h && h.pos ? h.pos : null;
}

function positionDraft(m, t) {
  if (!posDraft[t]) {
    const sent = m.positions[t];
    posDraft[t] = sent && !sent.hidden
      ? { ...sent }
      : (MODEL ? DraftEvaluator.defaultPositions(MODEL, st().settings.bracket, picksOf(m, t))
        : Object.fromEntries(picksOf(m, t).map((id, k) => [id, k + 1])));
  }
  return posDraft[t];
}

function setDraftPosition(t, heroId, p) {
  const d = posDraft[t];
  const holder = Object.keys(d).find((id) => d[id] === p);
  if (holder && +holder !== heroId) d[holder] = d[heroId]; // герой, стоявший на этой позиции, меняется местами
  d[heroId] = p;
  render();
}

function renderPositions() {
  const box = $('posBox');
  const S = st();
  const m = map();
  const show = m.phase === 'positions' && !S.over;
  box.classList.toggle('hidden', !show);
  if (!show) return;
  const radT = m.sides.A === 'radiant' ? 'A' : 'B';
  box.innerHTML = `<div class="prep-title">Расстановка позиций</div>
    <div class="prep-text">Распределите своих героев по позициям 1–5 — модель учтёт, насколько герой силён именно на этой позиции.
      Расстановка соперника откроется, когда обе команды подтвердят свою.</div>
    <div class="pos-teams"></div>`;
  const wrap = box.querySelector('.pos-teams');

  for (const t of [radT, E.other(radT)]) {
    const sent = m.positions[t];
    const card = el('div', `pos-card ${sideCls(t)}`);
    card.appendChild(el('div', 'pos-head', `<b>${esc(teamName(t))}</b><span>${sideOf(t) === 'radiant' ? 'Radiant' : 'Dire'}</span>
      <em class="${sent ? 'ok' : ''}">${sent ? '✓ подтверждено' : 'расставляет…'}</em>`));

    if (canAct(t)) {
      const d = positionDraft(m, t);
      for (const id of picksOf(m, t)) {
        const h = HERO_BY_ID.get(id);
        const shares = MODEL ? DraftEvaluator.positionShares(MODEL, S.settings.bracket, id) : null;
        const usual = shares ? shares.indexOf(Math.max(...shares)) + 1 : null;
        const cur = d[id];
        const curShare = shares ? shares[cur - 1] : null;
        const row = el('div', 'pos-row');
        row.innerHTML = `<img src="${heroImg(h)}" alt=""><div class="pos-hero"><b>${esc(h.name)}</b>
          <small class="${curShare != null && curShare < 0.1 ? 'warn' : ''}">${shares ? `на поз. ${cur} — ${Math.round(curShare * 100)}% его игр · обычно поз. ${usual}` : ''}</small></div>`;
        const chips = el('div', 'pos-chips');
        for (let p = 1; p <= 5; p++) {
          const b = el('button', `pos-chip${cur === p ? ' on' : ''}`, String(p));
          b.title = `${POS_NAMES[p - 1]}${shares ? ` — ${Math.round(shares[p - 1] * 100)}% игр героя` : ''}`;
          b.addEventListener('click', () => setDraftPosition(t, id, p));
          chips.appendChild(b);
        }
        row.appendChild(chips);
        card.appendChild(row);
      }
      const done = !!sent;
      const btn = el('button', 'btn primary', done ? 'Обновить расстановку' : 'Подтвердить расстановку');
      btn.disabled = !!(sent && m.positions[E.other(t)]);
      btn.addEventListener('click', () => act({ type: 'positions', team: t, positions: posDraft[t] }));
      card.appendChild(btn);
    } else if (sent && !sent.hidden) {
      // Админ видит отправленную расстановку
      for (const id of picksOf(m, t)) {
        const h = HERO_BY_ID.get(id);
        card.appendChild(el('div', 'pos-row ro', `<img src="${heroImg(h)}" alt=""><div class="pos-hero"><b>${esc(h.name)}</b></div><span class="pos-chip on">${sent[id]}</span>`));
      }
    } else {
      card.appendChild(el('div', 'muted pos-wait', sent ? 'Расстановка подтверждена и скрыта до подтверждения обеих команд.' : 'Команда расставляет героев по позициям…'));
    }
    wrap.appendChild(card);
  }
}

/* Монетка и выбор стороны / очереди пика */
function renderPrep() {
  const S = st();
  const m = map();
  const prep = $('prep');
  const show = !S.over && ['coin', 'choice1', 'choice2'].includes(m.phase);
  prep.classList.toggle('hidden', !show);
  if (!show) return;

  const flying = coinFlying(m);
  $('coinStage').classList.toggle('hidden', !m.coinMap);
  $('coinA').textContent = teamName('A');
  $('coinB').textContent = teamName('B');
  updateCoin(m);

  const actions = $('prepActions');
  actions.innerHTML = '';
  const log = $('choiceLog');
  log.innerHTML = '';
  m.choices.forEach((c) => {
    log.appendChild(el('div', 'choice-chip', `<b>${esc(teamName(c.team))}</b> выбрала <span class="${c.value}">${E.CHOICES[c.value].label}</span>`));
  });

  if (m.phase === 'coin') {
    $('prepTitle').textContent = `Карта ${S.maps.length} · подброс монеты`;
    $('prepText').textContent = 'Победитель выбирает сторону (Radiant / Dire) или очередь пика (первый / последний). Проигравший получает оставшийся выбор.';
    if (view.role !== 'spectator') {
      const b = el('button', 'btn primary big-ish', '◆ Подбросить монету ◆');
      b.addEventListener('click', () => act({ type: 'flip' }));
      actions.appendChild(b);
    } else actions.appendChild(el('div', 'muted', 'Ждём, когда подбросят монету…'));
    return;
  }

  if (flying) {
    $('prepTitle').innerHTML = '&nbsp;'; // заголовок уже в строке хода, монете нужно место для полёта
    $('prepText').textContent = '';
    log.innerHTML = '';
    return;
  }

  const team = E.actingTeam(S);
  const opp = E.other(team);
  let options;
  if (m.phase === 'choice1') {
    $('prepTitle').innerHTML = `<b class="${sideCls(team)}">${esc(teamName(team))}</b> выбирает`;
    $('prepText').textContent = m.coinMap
      ? `Монету выиграла команда ${teamName(team)}. Выберите сторону или очередь пика — второй вариант достанется сопернику на выбор.`
      : `${teamName(team)} проиграла прошлую карту и выбирает первой. Выберите сторону или очередь пика.`;
    options = ['radiant', 'dire', 'first', 'last'];
  } else {
    const firstC = m.choices[0];
    const firstKind = E.CHOICES[firstC.value].kind;
    $('prepTitle').innerHTML = `<b>${esc(teamName(team))}</b> выбирает ${firstKind === 'side' ? 'очередь пика' : 'сторону'}`;
    if (firstKind === 'side') {
      const auto = firstC.value === 'radiant' ? 'Dire' : 'Radiant';
      $('prepText').textContent = `${teamName(opp)} взяла ${E.CHOICES[firstC.value].label}, поэтому ${teamName(team)} играет за ${auto}. Осталось выбрать очередь пика.`;
      options = ['first', 'last'];
    } else {
      const auto = firstC.value === 'first' ? 'последний пик' : 'первый пик';
      $('prepText').textContent = `${teamName(opp)} взяла ${E.CHOICES[firstC.value].label.toLowerCase()}, поэтому у ${teamName(team)} ${auto}. Осталось выбрать сторону.`;
      options = ['radiant', 'dire'];
    }
  }

  if (canAct(team)) {
    const grid = el('div', 'choice-grid');
    for (const v of options) {
      const b = el('button', `choice-btn ${v}`, `<span>${E.CHOICES[v].label}</span><small>${E.CHOICES[v].kind === 'side' ? 'сторона' : 'очередь пика'}</small>`);
      b.addEventListener('click', () => act({ type: 'choose', value: v }));
      grid.appendChild(b);
    }
    actions.appendChild(grid);
  } else {
    actions.appendChild(el('div', 'muted waiting', `Ждём выбора команды ${esc(teamName(team))}…`));
  }
}

function updateCoin(m) {
  const coin = $('coin');
  const shadow = $('coinShadow');
  if (!m.coin) {
    if (animatedCoin) { coin.getAnimations().forEach((a) => a.cancel()); shadow.getAnimations().forEach((a) => a.cancel()); }
    animatedCoin = null;
    coin.style.transform = 'rotateX(0deg)';
    coin.classList.add('idle');
    return;
  }
  coin.classList.remove('idle');
  const key = `${view.id}:${st().maps.length}:${m.coin.at}`;
  if (animatedCoin === key) {
    // Время полёта вышло, а анимация отстала (фоновая вкладка) — сразу ставим монету на результат
    if (!coinFlying(m)) [coin, shadow].forEach((x) => x.getAnimations().forEach((a) => a.finish()));
    return;
  }
  animatedCoin = key;
  const finalDeg = 360 * 7 + (m.coin.winner === 'A' ? 0 : 180);
  const passed = now() - m.coin.at;
  coin.getAnimations().forEach((a) => a.cancel());
  coin.style.transform = `rotateX(${finalDeg}deg)`;
  if (passed >= E.COIN_MS - 50) return;
  const opts = { duration: E.COIN_MS, easing: 'linear' };
  const a = coin.animate([
    { transform: 'translateY(0) rotateX(0deg) scale(1)', easing: 'cubic-bezier(.2,.8,.4,1)' },
    { transform: `translateY(-120px) rotateX(${finalDeg * 0.55}deg) scale(1.2)`, offset: 0.42, easing: 'cubic-bezier(.6,0,.8,.4)' },
    { transform: `translateY(0) rotateX(${finalDeg - 20}deg) scale(1)`, offset: 0.82, easing: 'ease-out' },
    { transform: `translateY(-14px) rotateX(${finalDeg - 5}deg) scale(1.02)`, offset: 0.9 },
    { transform: `translateY(0) rotateX(${finalDeg}deg) scale(1)` },
  ], opts);
  const sh = shadow.animate([
    { transform: 'scaleX(1)', opacity: 0.6 },
    { transform: 'scaleX(.45)', opacity: 0.2, offset: 0.42 },
    { transform: 'scaleX(1)', opacity: 0.6, offset: 0.82 },
    { transform: 'scaleX(.9)', opacity: 0.5, offset: 0.9 },
    { transform: 'scaleX(1)', opacity: 0.6 },
  ], opts);
  a.currentTime = passed;
  sh.currentTime = passed;
  // Во фоновой вкладке анимации стоят на паузе — перерисовываем по таймеру, а не по onfinish
  setTimeout(render, E.COIN_MS - passed + 30);
}

function renderPool() {
  const S = st();
  const m = map();
  const step = E.curStep(S);
  const used = E.usedInMap(m);
  const interactive = !!step && canAct(step.team);
  const q = $('search').value.trim().toLowerCase();
  const pool = $('pool');
  pool.innerHTML = '';
  pool.classList.toggle('locked', !interactive);

  const avail = m.pool.filter((id) => !used.has(id)).length;
  $('poolCount').textContent = m.pool.length;
  $('burnedInfo').textContent = S.burned.length ? `· доступно ${avail} · исключено за серию: ${S.burned.length}` : `· доступно ${avail}`;

  for (const a of ATTRS) {
    const heroes = HEROES.filter((h) => h.attr === a.key && m.pool.includes(h.id));
    if (!heroes.length) continue;
    const col = el('div', 'attr-group');
    col.appendChild(el('div', 'attr-head', `<img src="${CDN}/icons/${a.icon}.png" alt=""><span>${a.label}</span><em>${heroes.length}</em>`));
    const grid = el('div', 'hero-grid');
    for (const h of heroes) {
      const u = used.get(h.id);
      let cls = 'hero';
      if (u) cls += ` used ${u.type} ${sideCls(u.team)}`;
      if (selected === h.id) cls += ' selected';
      if (q && !h.name.toLowerCase().includes(q)) cls += ' dim';
      const tile = heroTile(h, cls);
      if (u) tile.appendChild(el('span', 'badge', u.type === 'pick' ? 'ПИК' : 'БАН'));
      tile.addEventListener('click', () => select(h.id));
      tile.addEventListener('dblclick', () => { select(h.id); confirmPick(); });
      grid.appendChild(tile);
    }
    col.appendChild(grid);
    pool.appendChild(col);
  }

  // Исключённые за серию герои
  const box = $('burned');
  box.innerHTML = '';
  box.classList.toggle('hidden', !S.burned.length);
  if (S.burned.length) {
    box.appendChild(el('div', 'burned-title', `🔥 Уже выбраны в серии — недоступны (${S.burned.length})`));
    const list = el('div', 'burned-list');
    S.burned.forEach((id) => {
      const h = HERO_BY_ID.get(id);
      const img = el('img');
      img.src = heroImg(h);
      img.title = img.alt = h.name;
      list.appendChild(img);
    });
    box.appendChild(list);
  }
}

function renderPreview() {
  const step = E.curStep(st());
  const can = !!step && canAct(step.team);
  $('preview').classList.toggle('hidden', !can);
  if (!can) return;
  if (selected != null) {
    const h = HERO_BY_ID.get(selected);
    $('previewImg').src = heroImg(h);
    $('previewImg').classList.remove('hidden');
    $('previewName').textContent = h.name;
  } else {
    $('previewImg').classList.add('hidden');
    $('previewName').textContent = 'Выберите героя';
  }
  const isBan = step.type === 'ban';
  const btn = $('confirmBtn');
  btn.disabled = selected == null;
  btn.textContent = isBan ? 'Забанить' : 'Пикнуть';
  btn.className = 'btn ' + (isBan ? 'ban-btn' : sideOf(step.team) === 'dire' ? 'dire-btn' : 'radiant-btn');
  $('previewHint').textContent = `${st().settings.hotseat ? teamName(step.team) + ': ' : ''}клик — выбрать, двойной клик — сразу ${isBan ? 'забанить' : 'пикнуть'}`;
}

function renderResult() {
  const S = st();
  const m = map();
  const box = $('resultBox');
  const btns = $('resultBtns');
  btns.innerHTML = '';
  if (S.over) {
    const w = S.score.A > S.score.B ? 'A' : 'B';
    box.classList.remove('hidden');
    $('resultTitle').textContent = `🏆 ${teamName(w)} побеждает в серии ${S.score[w]}:${S.score[E.other(w)]}`;
    if (view.role === 'admin') {
      const u = el('button', 'btn ghost', '↶ Отменить результат');
      u.addEventListener('click', () => act({ type: 'undo' }));
      const n = el('button', 'btn primary', 'Новое лобби');
      n.addEventListener('click', newLobby);
      btns.append(u, n);
    }
    return;
  }
  // Пик-трейнинг: победа засчитана автоматически, ждём следующую карту
  if (m.phase === 'evaluated') {
    box.classList.remove('hidden');
    $('resultTitle').textContent = `🏆 Победа на карте засчитана: ${teamName(m.winner)}`;
    if (view.role === 'admin') {
      const n = el('button', 'btn primary', 'Следующая карта →');
      n.addEventListener('click', () => act({ type: 'next' }));
      btns.appendChild(n);
    } else btns.appendChild(el('div', 'muted', 'Следующую карту запустит админ.'));
    return;
  }
  const done = m.phase === 'done';
  box.classList.toggle('hidden', !done);
  if (!done) return;
  if (view.role === 'admin') {
    $('resultTitle').textContent = m.eval ? 'Шансы равны 50 на 50 — выберите победителя карты' : 'Драфт завершён. Кто выиграл карту?';
    for (const t of ['A', 'B']) {
      const b = el('button', `btn ${sideOf(t) === 'dire' ? 'dire-btn' : 'radiant-btn'}`, `🏆 ${esc(teamName(t))}`);
      b.addEventListener('click', () => act({ type: 'winner', team: t }));
      btns.appendChild(b);
    }
  } else {
    $('resultTitle').textContent = m.eval
      ? 'Шансы равны 50 на 50 — победителя выберет админ.'
      : 'Драфт завершён. GL HF! Результат карты отметит админ.';
  }
}

/* Пик-трейнинг: шансы команд и разбор драфта */
function renderEval() {
  const box = $('evalBox');
  const m = map();
  const ev = m.eval;
  box.classList.toggle('hidden', !ev);
  if (!ev) return;
  const radT = m.sides.A === 'radiant' ? 'A' : 'B';
  const dirT = E.other(radT);
  const pR = ev.pRadiant * 100;
  const pD = 100 - pR;
  const fmt = (v) => `${v.toFixed(1)}%`;
  const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
  const heroImgTag = (id) => { const h = HERO_BY_ID.get(id); return h ? `<img src="${heroImg(h)}" alt="${esc(h.name)}" title="${esc(h.name)}">` : ''; };
  const heroName = (id) => esc((HERO_BY_ID.get(id) || { name: '?' }).name);
  // Строка «в пользу кого»: + — Radiant, − — Dire
  const favor = (v) => (Math.abs(v) < 0.05 ? '<span class="muted">поровну</span>'
    : `<b class="${v > 0 ? 'side-r' : 'side-d'}">${signed(Math.abs(v))} ${esc(teamName(v > 0 ? radT : dirT))}</b>`);
  // Полоска от центра: перевес Radiant тянется влево (Radiant на экране слева), Dire — вправо
  const bar = (v, max) => {
    const w = Math.min(50, (Math.abs(v) / max) * 50);
    return `<div class="fbar"><span class="${v >= 0 ? 'r' : 'd'}" style="${v >= 0 ? `left:${50 - w}%` : 'left:50%'};width:${w}%"></span></div>`;
  };

  const parts = [
    ['Сила героев в патче', ev.parts.heroes],
    ...(ev.parts.positions != null ? [['Позиции героев', ev.parts.positions]] : []),
    ['Синергия союзников', ev.parts.synergy],
    ['Контрпики', ev.parts.counters],
    ['Состав (роли)', ev.parts.composition],
  ];
  const maxPart = Math.max(1, ...parts.map(([, v]) => Math.abs(v)));

  const syn = ev.synergies.filter((x) => Math.abs(x.pp) >= 0.05).slice(0, 4);
  const ctr = ev.counters.filter((x) => Math.abs(x.pp) >= 0.05).slice(0, 4);
  const heroesBy = (side) => ev.heroes.filter((h) => h.side === side).sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp));
  const roles = ev.composition.filter((c) => c.key !== 'Melee');
  const offRole = ev.heroes.filter((h) => h.pos && h.posShare != null && h.posShare < 0.1);

  const decided = m.winner && m.autoWin;
  box.innerHTML = `
    <div class="eval-head">
      <div class="eval-title">Оценка драфта</div>
      <div class="eval-sub">Модель STRATZ · ${esc(ev.bracket.label)} · угадывает исход матча по драфту в ${Math.round(ev.bracket.accuracy * 100)}% случаев</div>
    </div>
    <div class="odds">
      <div class="odds-team side-r ${pR > pD ? 'lead' : ''}"><small>Radiant</small><b>${esc(teamName(radT))}</b><em>${fmt(pR)}</em></div>
      <div class="odds-bar"><span class="r" style="width:${pR}%"></span><span class="d" style="width:${pD}%"></span><i></i></div>
      <div class="odds-team side-d ${pD > pR ? 'lead' : ''}"><small>Dire</small><b>${esc(teamName(dirT))}</b><em>${fmt(pD)}</em></div>
    </div>
    ${decided ? `<div class="verdict">🏆 Победа засчитана: <b class="${m.winner === radT ? 'side-r' : 'side-d'}">${esc(teamName(m.winner))}</b></div>` : ''}
    <div class="eval-grid">
      <div class="eval-card">
        <h4>Из чего сложились шансы</h4>
        ${parts.map(([label, v]) => `<div class="factor"><span>${label}</span>${bar(v, maxPart)}<span class="fv">${favor(v)}</span></div>`).join('')}
        ${ev.sideBonus != null ? `<div class="side-note">Оцениваем только драфт. Сторона в шанс не входит, хотя по статистике Radiant
          на этом ранге побеждает чаще на ${ev.sideBonus.toFixed(1)}%.</div>` : ''}
      </div>
      <div class="eval-card">
        <h4>Связки союзников</h4>
        ${syn.length ? syn.map((x) => {
          // Связка оценивается для своей команды: плюс — пара усиливает друг друга, минус — мешает
          const t = x.side === 'radiant' ? radT : dirT;
          const own = x.side === 'radiant' ? x.pp : -x.pp;
          return `<div class="pair"><div class="pair-imgs">${heroImgTag(x.a)}<span>+</span>${heroImgTag(x.b)}</div><div class="pair-text">${heroName(x.a)} + ${heroName(x.b)}<small class="${x.side === 'radiant' ? 'side-r' : 'side-d'}">${esc(teamName(t))}</small></div><div class="pv"><b class="${own >= 0 ? 'pos' : 'neg'}">${signed(own)}</b></div></div>`;
        }).join('') : '<div class="muted">Заметных связок нет</div>'}
        <h4>Контрпики</h4>
        ${ctr.length ? ctr.map((x) => {
          const winHero = x.pp > 0 ? x.radiant : x.dire;
          const loseHero = x.pp > 0 ? x.dire : x.radiant;
          return `<div class="pair"><div class="pair-imgs">${heroImgTag(winHero)}<span>›</span>${heroImgTag(loseHero)}</div><div class="pair-text">${heroName(winHero)} <span class="muted">против</span> ${heroName(loseHero)}</div><div class="pv">${favor(x.pp)}</div></div>`;
        }).join('') : '<div class="muted">Заметных контрпиков нет</div>'}
      </div>
      <div class="eval-card">
        <h4>Вклад героев</h4>
        <div class="hero-impact">
          ${[['radiant', radT], ['dire', dirT]].map(([side, t]) => `<div class="hi-col"><div class="hi-name ${side === 'radiant' ? 'side-r' : 'side-d'}">${esc(teamName(t))}</div>
            ${heroesBy(side).map((h) => {
              const own = side === 'radiant' ? h.pp : -h.pp; // вклад в пользу своей команды
              const posTag = h.pos ? `<i class="hi-pos${h.posShare != null && h.posShare < 0.1 ? ' warn' : ''}" title="${POS_NAMES[h.pos - 1]}${h.posShare != null ? ` — ${Math.round(h.posShare * 100)}% игр героя` : ''}">${h.pos}</i>` : '';
              return `<div class="hi-row">${heroImgTag(h.id)}<span>${posTag}${heroName(h.id)}</span><b class="${own >= 0 ? 'pos' : 'neg'}">${signed(own)}</b></div>`;
            }).join('')}</div>`).join('')}
        </div>
        ${offRole.length ? `<h4>Непривычные позиции</h4>${offRole.map((h) => {
          const own = h.side === 'radiant' ? h.posPP : -h.posPP;
          return `<div class="off-row">${heroImgTag(h.id)}<span>${heroName(h.id)} на поз. ${h.pos} — так его играют лишь в ${Math.max(1, Math.round(h.posShare * 100))}% игр</span><b class="${own >= 0 ? 'pos' : 'neg'}">${signed(own)}</b></div>`;
        }).join('')}` : ''}
        <h4>Роли в составе</h4>
        <div class="roles">
          ${roles.map((c) => `<div class="role-row"><span>${esc(c.label)}</span><b class="side-r">${c.radiant}</b><i>:</i><b class="side-d">${c.dire}</b></div>`).join('')}
        </div>
      </div>
    </div>
    <div class="eval-note">Вклад указан в процентах шанса на победу. Драфт — лишь часть игры: даже лучшая модель по пикам угадывает победителя примерно в 55–60% матчей.</div>`;
}

function renderHistory() {
  const S = st();
  const box = $('history');
  box.innerHTML = '';
  const done = S.maps.filter((m) => m.winner);
  if (!done.length) return;
  box.appendChild(el('h3', null, 'История серии'));
  done.forEach((m, idx) => {
    const row = el('div', 'hist-row');
    const odds = m.eval ? ` · ${Math.round(Math.max(m.eval.pRadiant, 1 - m.eval.pRadiant) * 1000) / 10}%` : '';
    row.appendChild(el('div', 'hist-map', `Карта ${idx + 1}<br><small>🏆 ${esc(teamName(m.winner))}${odds}</small>`));
    const order = m.sides.A === 'radiant' ? ['A', 'B'] : ['B', 'A'];
    for (const t of order) {
      const side = m.sides[t];
      const hs = el('div', `hist-side ${side === 'radiant' ? 'side-r' : 'side-d'}${m.winner === t ? ' win' : ''}`);
      hs.appendChild(el('div', 'hist-name', `${esc(teamName(t))} · ${side === 'radiant' ? 'Radiant' : 'Dire'}${m.first === t ? ' · первый пик' : ''}`));
      const heroes = el('div', 'hist-heroes');
      m.seq.forEach((stp, i) => {
        if (stp.team === t && stp.type === 'pick' && m.actions[i] != null) {
          const h = HERO_BY_ID.get(m.actions[i]);
          const img = el('img'); img.src = heroImg(h); img.title = h.name;
          heroes.appendChild(img);
        }
      });
      hs.appendChild(heroes);
      row.appendChild(hs);
    }
    box.appendChild(row);
  });
}

function renderTimers() {
  if (!view) return;
  const S = st();
  const m = map();
  const step = E.curStep(S);
  const on = !!S.clock && !!step && !S.over;
  $('timers').classList.toggle('hidden', !on);
  if (!on) return;
  const v = E.clockView(S.clock, step.team, now());
  const leftTeam = m.sides.A === 'radiant' ? 'A' : 'B';
  for (const pos of ['L', 'R']) {
    const t = pos === 'L' ? leftTeam : E.other(leftTeam);
    const box = $('timer' + pos);
    const active = step.team === t;
    box.className = `timer-box ${sideCls(t)}${active ? ' active' : ''}${v.paused ? ' paused' : ''}${active && v.turnLeft <= 0 ? ' reserve' : ''}`;
    box.querySelector('.t-main').textContent = active ? Math.ceil(v.turnLeft) : '—';
    box.querySelector('.t-res').textContent = '+' + Math.ceil(v.reserve[t]);
  }
}

/* ---------- Админ-панель в лобби ---------- */

function linkFor(key) {
  const host = $('hostSelect').value || location.host;
  return `${location.protocol}//${host}${location.pathname}?lobby=${view.id}${key ? '&key=' + key : ''}`;
}

function renderAdmin() {
  const isAdmin = view.role === 'admin';
  $('adminPanel').classList.toggle('hidden', !isAdmin);
  if (!isAdmin) return;
  const S = st();
  $('adminLinks').classList.toggle('hidden', !!view.local);
  if (!view.local) {
    fillHostSelect();
    document.querySelectorAll('.link-row[data-role]').forEach((r) => r.classList.toggle('hidden', S.settings.hotseat));
    $('linkNameA').textContent = `Капитан · ${S.settings.nameA}`;
    $('linkNameB').textContent = `Капитан · ${S.settings.nameB}`;
    $('linkA').value = linkFor(view.keys.A);
    $('linkB').value = linkFor(view.keys.B);
    $('linkS').value = linkFor(null);
    $('presA').className = 'dot' + (view.presence.A ? ' on' : '');
    $('presB').className = 'dot' + (view.presence.B ? ' on' : '');
    $('presA').title = view.presence.A ? 'Подключён' : 'Не подключён';
    $('presB').title = view.presence.B ? 'Подключён' : 'Не подключён';
    $('specCount').textContent = view.presence.spectators ? `(${view.presence.spectators})` : '';
  }
  const hasClock = !!S.clock && !!E.curStep(S);
  $('pauseBtn').classList.toggle('hidden', !hasClock);
  if (hasClock) $('pauseBtn').textContent = S.clock.pausedAt != null ? '▶ Продолжить' : '⏸ Пауза';
}

let hostsFilled = false;
function fillHostSelect() {
  if (hostsFilled || !serverInfo) return;
  hostsFilled = true;
  const sel = $('hostSelect');
  const opts = [];
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!isLocalHost) opts.push({ v: location.host, t: location.host });
  for (const a of serverInfo.addresses) {
    const v = `${a.address}:${serverInfo.port}`;
    if (!opts.some((o) => o.v === v)) opts.push({ v, t: `${v} — ${a.name}${a.virtual ? ' (виртуальный)' : ''}` });
  }
  if (!opts.length) opts.push({ v: location.host, t: `${location.host} (только этот компьютер)` });
  sel.innerHTML = opts.map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('');
  const saved = lsGet(HOST_KEY, null);
  if (saved && opts.some((o) => o.v === saved)) sel.value = saved;
}

/* ---------- Действия пользователя ---------- */

function select(id) {
  const step = E.curStep(st());
  if (!step || !canAct(step.team) || !E.isAvailable(map(), id)) return;
  selected = id;
  render();
}

function confirmPick() {
  if (selected != null) act({ type: 'pick', heroId: selected });
}

function newLobby() {
  location.href = location.pathname;
}

/* ---------- Экран создания лобби ---------- */

function segValue(id) { return $(id).querySelector('button.on').dataset.v; }
function setSeg(id, v) { $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v))); }

function readSettings() {
  return {
    nameA: $('nameA').value.trim() || 'Team 1',
    nameB: $('nameB').value.trim() || 'Team 2',
    bestOf: +segValue('bestOf'),
    poolSize: parseInt($('poolSize').value, 10) || 36,
    bans: segValue('bans') === 'on',
    timer: segValue('timer') === 'on',
    hotseat: segValue('mode') === 'hotseat',
    trainer: segValue('trainer') === 'on',
    bracket: $('bracket').value || 'all',
  };
}

// Ранги, по которым есть модель: на сервере — из /api/info, без сервера — из draft-model.js в браузере
function trainerBrackets() {
  if (serverInfo) return serverInfo.trainer || [];
  return MODEL ? DraftEvaluator.brackets(MODEL) : [];
}

let bracketsFilled = false;
function fillBrackets() {
  const list = trainerBrackets();
  if (bracketsFilled || !list.length) return;
  bracketsFilled = true;
  $('bracket').innerHTML = list.map((b) => `<option value="${b.key}">${esc(b.label)} — точность ${Math.round(b.accuracy * 100)}%</option>`).join('');
  $('bracket').value = list.some((b) => b.key === 'divine_immortal') ? 'divine_immortal' : list[0].key;
}

function validateSetup() {
  const s = readSettings();
  const minPool = s.bans ? 18 : 10;
  let warn = '';
  if (s.poolSize < minPool) warn = `В пуле должно быть минимум ${minPool} героев.`;
  else if (HEROES.length - (s.bestOf - 1) * 10 < s.poolSize) warn = 'Недостаточно героев для такой серии: уменьшите пул.';
  $('setupWarn').textContent = warn;
  $('startBtn').disabled = !!warn;

  const linksBtn = $('mode').querySelector('[data-v="links"]');
  linksBtn.disabled = !serverInfo;
  if (!serverInfo && segValue('mode') === 'links') setSeg('mode', 'hotseat');
  $('modeHint').textContent = !serverInfo
    ? (location.hostname.endsWith('github.io')
      ? 'Демо-версия: здесь нет сервера, поэтому доступен только режим «Одно устройство». Чтобы капитаны пикали по ссылкам, запустите сервер у себя — инструкция в README репозитория.'
      : 'Сервер не запущен, поэтому доступен только режим «Одно устройство». Как запустить сервер — в README.md.')
    : segValue('mode') === 'links'
      ? 'Каждый капитан пикает со своего устройства по своей ссылке. Админ отмечает победителя карты.'
      : 'Обе команды пикают на этом устройстве. Ссылку для зрителей / OBS всё равно можно раздать.';

  // Пик-трейнинг доступен, только если собрана модель (npm run build:model)
  fillBrackets();
  const hasModel = trainerBrackets().length > 0;
  $('trainer').querySelector('[data-v="on"]').disabled = !hasModel;
  if (!hasModel && segValue('trainer') === 'on') setSeg('trainer', 'off');
  const trainerOn = segValue('trainer') === 'on';
  $('bracketField').classList.toggle('hidden', !trainerOn);
  $('trainerHint').textContent = !hasModel
    ? 'Пик-трейнинг недоступен: модель оценки драфта не собрана (npm run build:model).'
    : trainerOn
      ? 'После драфта модель оценит шансы команд, покажет разбор и сама засчитает победу стороне с бо́льшим шансом.'
      : 'Обычный режим: победителя каждой карты отмечает админ.';
  return !warn;
}

function renderRecent() {
  const list = lsGet(RECENT_KEY, []);
  $('recent').classList.toggle('hidden', !list.length);
  $('recentList').innerHTML = '';
  list.forEach((r) => {
    const a = el('a', 'recent-item', `<b>${esc(r.nameA)}</b> vs <b>${esc(r.nameB)}</b><span>${r.local ? 'одно устройство, без сервера' : new Date(r.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>`);
    a.href = r.local ? '?local=1' : `?lobby=${r.id}&key=${r.key}`;
    $('recentList').appendChild(a);
  });
}

function rememberLobby(entry) {
  const list = lsGet(RECENT_KEY, []).filter((r) => !(r.local && entry.local) && r.id !== entry.id);
  list.unshift(entry);
  lsSet(RECENT_KEY, list.slice(0, 8));
}

async function createLobby() {
  if (!validateSetup()) return;
  const s = readSettings();
  $('startBtn').disabled = true;
  try {
    if (serverInfo) {
      const r = await fetch('/api/lobbies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Не удалось создать лобби');
      rememberLobby({ id: d.id, key: d.keys.admin, nameA: s.nameA, nameB: s.nameB, at: Date.now() });
      location.href = `?lobby=${d.id}&key=${d.keys.admin}`;
    } else {
      const state = E.createSeries({ ...s, hotseat: true }, HEROES.map((h) => h.id), Date.now());
      lsSet(LOCAL_KEY, state);
      rememberLobby({ local: true, nameA: s.nameA, nameB: s.nameB, at: Date.now() });
      location.href = '?local=1';
    }
  } catch (e) {
    toast(e.message);
    $('startBtn').disabled = false;
  }
}

function initSetup() {
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      validateSetup();
    });
  });
  $('poolSize').addEventListener('input', validateSetup);
  $('startBtn').addEventListener('click', createLobby);
}

function showSetup() {
  validateSetup();
  renderRecent();
  showScreen('setup');
}

/* ---------- Запуск ---------- */

async function detectServer() {
  if (location.protocol === 'file:') return null;
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

function initDraftUi() {
  $('confirmBtn').addEventListener('click', confirmPick);
  $('undoBtn').addEventListener('click', () => act({ type: 'undo' }));
  $('pauseBtn').addEventListener('click', () => act({ type: 'pause' }));
  $('newLobbyBtn').addEventListener('click', () => {
    if (!st().over && !window.confirm('Перейти к созданию нового лобби? Текущее останется доступно по ссылке.')) return;
    newLobby();
  });
  $('hostSelect').addEventListener('change', () => { lsSet(HOST_KEY, $('hostSelect').value); render(); });
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await copyText($(b.dataset.copy).value);
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать — выделите ссылку вручную');
  }));
  $('search').addEventListener('input', render);
  $('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toLowerCase();
    if (!q) return confirmPick();
    const m = map();
    const match = HEROES.find((h) => E.isAvailable(m, h.id) && h.name.toLowerCase().includes(q));
    if (match) { e.target.value = ''; select(match.id); }
  });
  document.addEventListener('keydown', (e) => {
    if (!view || view.role !== 'admin') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      act({ type: 'undo' });
    }
  });
  setInterval(renderTimers, 250);
}

async function init() {
  initSetup();
  initDraftUi();
  serverInfo = await detectServer();

  if (params.get('local')) {
    if (!lsGet(LOCAL_KEY, null)) return showSetup();
    transport = localTransport();
    return;
  }
  const id = params.get('lobby');
  if (id && serverInfo) {
    const r = await fetch(`/api/lobbies/${encodeURIComponent(id)}`).catch(() => null);
    if (!r || !r.ok) {
      showSetup();
      toast('Лобби не найдено');
      return;
    }
    transport = remoteTransport(id, params.get('key'));
    return;
  }
  if (id && !serverInfo) toast('Сервер недоступен — ссылка на лобби работает только при запущенном сервере');
  showSetup();
}

init();
