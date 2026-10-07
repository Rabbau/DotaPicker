'use strict';

const E = DraftEngine;
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const heroImg = (h) => `${CDN}/heroes/${h.key}.png`;
const HERO_BY_ID = new Map(HEROES.map((h) => [h.id, h]));
const ATTRS = [
  { key: 'str', label: 'Сила' },
  { key: 'agi', label: 'Ловкость' },
  { key: 'int', label: 'Интеллект' },
  { key: 'all', label: 'Универсальный' },
];
let attrFilter = 'any'; // фильтр пула по атрибуту: 'any' — все 4 блока сеткой 2×2
const RECENT_KEY = 'torneum-recent-v1';
const LOCAL_KEY = 'torneum-local-v1';
const HOST_KEY = 'torneum-host-v1';

// Модель пик-трейнинга (draft-model.js) — нужна в браузере для режима без сервера
const MODEL = typeof DRAFT_MODEL !== 'undefined' ? DRAFT_MODEL : null;
if (MODEL) E.setEvaluator((bracket, rad, dire, positions) => DraftEvaluator.evaluate(MODEL, bracket, rad, dire, positions));

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

  // Шапка: карта и счёт
  $('mapLabel').textContent = `Карта ${S.maps.length} из ${s.bestOf}`;
  $('modeTag').classList.toggle('hidden', !s.trainer);
  for (const t of ['A', 'B']) {
    $('scoreName' + t).textContent = teamName(t);
    $('score' + t).textContent = S.score[t];
    // Название команды в цвет её стороны; пока стороны не выбраны — серое
    $('scoreName' + t).className = sideOf(t) ? sideCls(t) : 'side-none';
  }
  const roleText = view.role === 'admin'
    ? (s.hotseat ? 'Админ · одно устройство' : 'Админ')
    : view.role === 'spectator' ? 'Зритель' : `Капитан · ${teamName(view.role)}`;
  $('roleChip').textContent = roleText;
  $('roleChip').className = 'role-pill ' + (view.role === 'A' || view.role === 'B' ? sideCls(view.role) : '');
  $('conn').classList.toggle('hidden', !!view.local);
  $('undoBtn').classList.toggle('hidden', view.role !== 'admin');

  renderAdmin();

  // Строка хода
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

  renderOrder(m, leftTeam);

  // Колонки команд: Radiant слева
  for (const pos of ['L', 'R']) {
    const t = pos === 'L' ? leftTeam : E.other(leftTeam);
    const side = sideOf(t);
    const col = $('col' + pos);
    // До выбора сторон команда 1 — слева, команда 2 — справа
    const look = side || 'neutral'; // до выбора сторон колонки серые
    col.className = `team-col ${look}${acting === t && !flying && !S.over ? ' active' : ''}${view.role === t ? ' mine' : ''}`;
    $('name' + pos).textContent = teamName(t);
    $('sub' + pos).innerHTML = side
      ? `<b>${side === 'radiant' ? 'Radiant' : 'Dire'}</b> · ${m.first === t ? 'первый пик' : 'последний пик'}`
      : (m.coinMap ? 'Сторона и очередь — после монеты' : 'Сторона и очередь — после выбора');
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
  renderTurnToast();
}

/* ---------- Уведомление капитану «Ваш пик / Ваш бан» ----------
   Только в режиме «Капитаны по ссылкам» и только у того, чей сейчас ход.
   При наведении плашка уезжает вверх, чтобы было видно, что под ней; клики проходят сквозь неё. */
let turnToastRect = null;

function renderTurnToast() {
  const box = $('turnToast');
  const S = st();
  const m = map();
  const role = view.role;
  let title = '';
  let sub = '';
  let kind = '';
  if (!view.local && !S.settings.hotseat && (role === 'A' || role === 'B') && !S.over && !coinFlying(m)) {
    const step = E.curStep(S);
    if (step && step.team === role) {
      kind = step.type;
      title = step.type === 'pick' ? 'Ваш пик' : 'Ваш бан';
      sub = `${teamName(role)} · выберите героя в пуле`;
    } else if (['choice1', 'choice2'].includes(m.phase) && E.actingTeam(S) === role) {
      kind = 'choice';
      title = 'Ваш выбор';
      sub = m.phase === 'choice1' ? 'Сторона или очередь пика' : (E.CHOICES[m.choices[0].value].kind === 'side' ? 'Очередь пика' : 'Сторона');
    } else if (m.phase === 'positions' && m.positions && !m.positions[role]) {
      kind = 'choice';
      title = 'Расставьте позиции';
      sub = 'Распределите героев по позициям 1–5';
    }
  }
  const show = !!title;
  if (show) {
    $('turnToastTitle').textContent = title;
    $('turnToastSub').textContent = sub;
    box.dataset.kind = kind;
  }
  if (show !== box.classList.contains('show')) {
    box.classList.toggle('show', show);
    box.classList.remove('peek');
    turnToastRect = null;
  }
}

// Наведение: пока курсор над местом плашки — она уехала вверх («peek»)
document.addEventListener('mousemove', (e) => {
  const box = $('turnToast');
  if (!box || !box.classList.contains('show')) return;
  if (!box.classList.contains('peek')) turnToastRect = box.getBoundingClientRect();
  const r = turnToastRect;
  if (!r) return;
  const pad = 8;
  const inside = e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
  box.classList.toggle('peek', inside);
});

const emptyPick = (n, cls = '') => el('div', `slot pick empty${cls}`, `<span class="slot-n">${n}</span><span class="slot-t">свободно</span>`);

function renderSlots(t, picks, bans) {
  const S = st();
  const m = map();
  picks.innerHTML = '';
  bans.innerHTML = '';
  bans.previousElementSibling.textContent = S.settings.bans ? 'Баны' : '';
  if (!m.seq.length) {
    for (let i = 1; i <= 5; i++) picks.appendChild(emptyPick(i));
    for (let i = 0; i < (S.settings.bans ? 4 : 0); i++) bans.appendChild(el('div', 'slot ban empty'));
    return;
  }
  let n = 0;
  m.seq.forEach((stp, i) => {
    if (stp.team !== t) return;
    if (stp.type === 'pick') n++;
    const hid = m.actions[i];
    const isCur = i === m.actions.length && m.phase === 'draft';
    const target = stp.type === 'pick' ? picks : bans;
    if (hid != null) {
      const tile = heroTile(HERO_BY_ID.get(hid), `slot ${stp.type} filled`);
      const p = stp.type === 'pick' ? knownPosition(m, t, hid) : null;
      if (p) tile.appendChild(el('span', 'pos-badge', String(p)));
      target.appendChild(tile);
    } else {
      const slot = stp.type === 'pick' ? emptyPick(n, isCur ? ' current' : '') : el('div', `slot ban empty${isCur ? ' current' : ''}`);
      if (isCur && selected != null) {
        if (stp.type === 'pick') slot.innerHTML = '';
        slot.appendChild(heroTile(HERO_BY_ID.get(selected), 'ghost-tile'));
      }
      target.appendChild(slot);
    }
  });
}

// Лента «Порядок драфта»: монетка → выбор стороны → баны/пики → (позиции в пик-трейнинге)
function renderOrder(m, leftTeam) {
  const S = st();
  const order = $('order');
  order.innerHTML = '';
  const choosing = ['choice1', 'choice2'].includes(m.phase);
  const stage = (label, cur, done) => order.appendChild(el('span', `step${cur ? ' cur' : done ? ' done' : ''}`, label));
  if (m.coinMap) stage('Монета', m.phase === 'coin' || (m.coin && coinFlying(m)), m.phase !== 'coin');
  stage('Выбор стороны', choosing && !coinFlying(m), !['coin', 'choice1', 'choice2'].includes(m.phase));
  const seq = m.seq.length ? m.seq : previewSequence(m);
  seq.forEach((stp, i) => {
    const sideClass = m.sides ? sideCls(stp.team) : 'side-n';
    const chip = el('span', `chip ${stp.type} ${sideClass}${i === m.actions.length && m.phase === 'draft' ? ' current' : ''}${i < m.actions.length ? ' done' : ''}`);
    const hid = m.actions[i];
    if (hid != null) { const img = el('img'); img.src = heroImg(HERO_BY_ID.get(hid)); chip.appendChild(img); }
    else chip.textContent = stp.type === 'pick' ? 'П' : 'Б';
    chip.title = `${i + 1}. ${m.seq.length ? teamName(stp.team) : (stp.who === 'F' ? 'Первый пик' : 'Последний пик')} — ${stp.type === 'pick' ? 'пик' : 'бан'}`;
    order.appendChild(chip);
  });
  if (S.settings.trainer) stage('Позиции', m.phase === 'positions', ['done', 'evaluated', 'result'].includes(m.phase) && !!m.eval);

  const l = leftTeam;
  $('orderLegend').innerHTML = m.sides
    ? `<span class="lg-r">■</span> ${esc(teamName(l))} · <span class="lg-d">■</span> ${esc(teamName(E.other(l)))} · Б — бан, П — пик`
    : 'Б — бан, П — пик · цвета команд — после выбора сторон';
}

// До выбора сторон показываем схему драфта без привязки к командам
function previewSequence(m) {
  return (st().settings.bans ? E.ORDER_WITH_BANS : E.ORDER_NO_BANS).map(([who, type]) => ({ who, type, team: null }));
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
  box.innerHTML = `<h2 class="pos-title">Расстановка позиций</h2>
    <p class="pos-text">Распределите своих героев по позициям 1–5 — модель учтёт, насколько герой силён именно на этой позиции.
      Расстановка соперника откроется, когда обе команды подтвердят свою.</p>
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
      const btn = el('button', 'btn cta-sm', done ? 'Обновить расстановку' : 'Подтвердить расстановку');
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
  // До броска на монете «ALEA ?», после — названия команд на сторонах
  // До броска на зелёной стороне «?», после — название команды (длинное — аббревиатурой)
  const labelA = coinLabel(teamName('A'));
  const labelB = coinLabel(teamName('B'));
  $('coinA').textContent = m.coin ? labelA : '?';
  $('coinA').className = m.coin ? coinSize(labelA) : 'q';
  $('coinB').textContent = labelB;
  $('coinB').className = coinSize(labelB);
  updateCoin(m);

  const actions = $('prepActions');
  actions.innerHTML = '';
  actions.classList.remove('wide');
  const log = $('choiceLog');
  log.innerHTML = '';
  m.choices.forEach((c) => {
    log.appendChild(el('div', 'choice-chip', `<b>${esc(teamName(c.team))}</b> выбрала <span class="${c.value}">${E.CHOICES[c.value].label}</span>`));
  });

  if (m.phase === 'coin') {
    $('prepTitle').textContent = 'Подброс монеты';
    $('prepText').textContent = 'Победитель выбирает одно: сторону или очередь пика. Проигравший получает оставшийся выбор.';
    log.innerHTML = ['Radiant', 'Dire', 'Первый пик', 'Последний пик'].map((x) => `<span class="tagline">${x}</span>`).join('');
    if (view.role !== 'spectator') {
      const b = el('button', 'btn cta', 'Подбросить');
      b.addEventListener('click', () => act({ type: 'flip' }));
      actions.appendChild(b);
    } else actions.appendChild(el('div', 'waiting', 'Ждём, когда подбросят монету…'));
    return;
  }

  if (flying) {
    $('prepTitle').textContent = 'Монета в воздухе…';
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
      : `${teamName(team)} проиграла монетку на прошлой карте и выбирает первой. Выберите сторону или очередь пика.`;
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

  actions.classList.add('wide');
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

// Подпись на монете: короткое название как есть, длинное — аббревиатурой.
// «Virtus Pro» → «VP», «Team Spirit» → «TS», «Strategia» → «STR», «Aurora» → «Aurora»
function coinLabel(name) {
  const n = String(name).trim();
  if (n.length <= 8) return n;
  const words = n.split(/[\s\-_.]+/).filter(Boolean);
  if (words.length > 1) return words.map((w) => w[0]).join('').slice(0, 4).toUpperCase();
  return n.slice(0, 3).toUpperCase();
}

// Размер надписи по длине: до 4 символов — крупно, 5–6 — средне, 7–8 — мелко
const coinSize = (label) => (label.length <= 4 ? '' : label.length <= 6 ? 'mid' : 'long');

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
    { transform: `translateY(-90px) rotateX(${finalDeg * 0.55}deg) scale(1.15)`, offset: 0.42, easing: 'cubic-bezier(.6,0,.8,.4)' },
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
  $('poolCount').innerHTML = `<b>${avail}</b> доступно из ${m.pool.length}`;

  // Фильтр по атрибуту: «Все» (any) — 4 блока сеткой 2×2, иначе один блок на всю ширину
  const inPool = (key) => HEROES.filter((h) => h.attr === key && m.pool.includes(h.id));
  const chips = $('attrChips');
  chips.innerHTML = '';
  [{ key: 'any', label: 'Все', n: m.pool.length }, ...ATTRS.map((a) => ({ key: a.key, label: a.label, n: inPool(a.key).length, cls: `a-${a.key}` }))]
    .forEach((c) => {
      const b = el('button', `attr-chip ${c.cls || ''}${attrFilter === c.key ? ' on' : ''}`, `<i></i>${c.label} <em>${c.n}</em>`);
      b.type = 'button';
      b.addEventListener('click', () => { attrFilter = c.key; render(); });
      chips.appendChild(b);
    });
  pool.classList.toggle('single', attrFilter !== 'any');

  for (const a of ATTRS) {
    if (attrFilter !== 'any' && attrFilter !== a.key) continue;
    const heroes = inPool(a.key);
    if (!heroes.length) continue;
    const col = el('div', `attr-group a-${a.key}`);
    col.appendChild(el('div', 'attr-head', `<i></i><span>${a.label}</span><em>${heroes.length}</em>`));
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

  // Fearless: исключённые за серию герои
  const box = $('burned');
  const n = S.burned.length;
  box.innerHTML = `<div class="fl-body"><span class="fl-title">Fearless · исключены в серии</span>
    <span class="fl-sub">${n ? 'Эти герои уже сыграны и не попадут в пул до конца серии' : `Пока пусто — после карты ${S.maps.length} здесь появятся сыгранные герои`}</span></div>
    <span class="fl-count${n ? ' has' : ''}">${n}</span>`;
  if (n) {
    const list = el('div', 'burned-list');
    S.burned.forEach((id) => {
      const h = HERO_BY_ID.get(id);
      const img = el('img');
      img.src = heroImg(h);
      img.title = img.alt = h.name;
      list.appendChild(img);
    });
    box.querySelector('.fl-body').appendChild(list);
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
  btn.className = 'btn cta-sm' + (isBan ? ' ban-btn' : '');
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
    $('resultTitle').innerHTML = `${TROPHY} ${esc(teamName(w))} побеждает в серии ${S.score[w]}:${S.score[E.other(w)]}`;
    if (view.role === 'admin') {
      const u = el('button', 'btn', '↶ Отменить результат');
      u.addEventListener('click', () => act({ type: 'undo' }));
      const r = el('button', 'btn cta-sm', 'Начать заново');
      r.title = 'Новая серия с теми же настройками — ссылки капитанов и зрителей продолжат работать';
      r.addEventListener('click', () => {
        if (window.confirm('Начать серию заново с теми же настройками? Текущая серия будет сброшена.')) act({ type: 'restart' });
      });
      const n = el('button', 'btn', 'Новое лобби');
      n.addEventListener('click', newLobby);
      btns.append(u, r, n);
    } else btns.appendChild(el('div', 'muted', 'Начать заново или создать новое лобби может админ.'));
    return;
  }
  // Пик-трейнинг: победа засчитана автоматически, ждём следующую карту
  if (m.phase === 'evaluated') {
    box.classList.remove('hidden');
    $('resultTitle').innerHTML = `${TROPHY} Победа на карте засчитана: ${esc(teamName(m.winner))}`;
    if (view.role === 'admin') {
      const n = el('button', 'btn cta-sm', 'Следующая карта →');
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
      const b = el('button', `btn ${sideOf(t) === 'dire' ? 'dire-btn' : 'radiant-btn'}`, `${TROPHY} ${esc(teamName(t))}`);
      b.addEventListener('click', () => act({ type: 'winner', team: t }));
      btns.appendChild(b);
    }
  } else {
    $('resultTitle').textContent = m.eval
      ? 'Шансы равны 50 на 50 — победителя выберет админ.'
      : 'Драфт завершён. GL HF! Результат карты отметит админ.';
  }
}

/* ---------- Пик-трейнинг: песочница «другой пик» ----------
   Зритель заменяет пикнутых героев и видит, как изменились бы шансы.
   Считается в браузере по той же модели и на результат карты не влияет. */
let sandbox = null; // { key, swaps: { исходный id: новый id }, pos: { исходный id: позиция }, sel: исходный id | null }

const sandboxKey = () => `${view.id}:${st().maps.length}`;

// Позиции героев реального драфта (из оценки) — замена встаёт на позицию заменённого
function realPositions(m) {
  return Object.fromEntries(m.eval.heroes.filter((h) => h.pos).map((h) => [h.id, h.pos]));
}

// Изменены ли позиции относительно реальной расстановки
function sandboxPosChanged(m) {
  const real = realPositions(m);
  return Object.entries(sandbox.pos).some(([id, p]) => real[id] !== p);
}

function sandboxEval(m) {
  if (!sandbox || !MODEL || (!Object.keys(sandbox.swaps).length && !sandboxPosChanged(m))) return null;
  const radT = m.sides.A === 'radiant' ? 'A' : 'B';
  const swap = (id) => sandbox.swaps[id] || id;
  const pos = {};
  for (const [id, p] of Object.entries(sandbox.pos)) pos[swap(+id)] = p;
  return DraftEvaluator.evaluate(MODEL, st().settings.bracket, picksOf(m, radT).map(swap), picksOf(m, E.other(radT)).map(swap), pos);
}

// Кого можно поставить вместо героя: свободные герои пула карты (не пикнутые, не забаненные, не взятые в другой замене)
function sandboxCandidates(m) {
  const taken = new Set([...m.actions, ...Object.values(sandbox.swaps)]);
  const cur = sandbox.swaps[sandbox.sel];
  const order = { str: 0, agi: 1, int: 2, all: 3 };
  return m.pool.filter((id) => !taken.has(id) || id === cur)
    .map((id) => HERO_BY_ID.get(id))
    .sort((a, b) => order[a.attr] - order[b.attr] || a.name.localeCompare(b.name));
}

function renderSandbox(m, radT, real, ev) {
  if (!MODEL) return '';
  if (!sandbox) {
    return `<div class="sbx-open"><button type="button" class="btn" data-sb="open">Протестировать другой пик или позиции</button>
      <span class="muted">Замените героя или поменяйте позиции и посмотрите, как изменятся шансы — на результат карты не влияет</span></div>`;
  }
  const pos = sandbox.pos;
  const realPos = realPositions(m);
  const team = (t) => {
    const side = sideOf(t);
    const tiles = picksOf(m, t).map((orig) => {
      const cur = sandbox.swaps[orig] || orig;
      const h = HERO_BY_ID.get(cur);
      const o = HERO_BY_ID.get(orig);
      const moved = pos[orig] !== realPos[orig];
      const cls = `sbx-hero${sandbox.sel === orig ? ' sel' : ''}${cur !== orig || moved ? ' swapped' : ''}`;
      return `<button type="button" class="${cls}" data-sb="sel" data-id="${orig}" title="${esc(h.name)}${cur !== orig ? ` (вместо ${esc(o.name)})` : ''}">
        <img src="${heroImg(h)}" alt=""><span class="pos-badge">${pos[orig] || '?'}</span><span class="sbx-name">${esc(h.name)}</span>
        ${cur !== orig ? `<span class="sbx-was">вместо ${esc(o.name)}</span>` : moved ? `<span class="sbx-was">была поз. ${realPos[orig]}</span>` : ''}</button>`;
    }).join('');
    return `<div class="sbx-team ${side === 'radiant' ? 'side-r' : 'side-d'}"><div class="sbx-team-name">${esc(teamName(t))} · ${side === 'radiant' ? 'Radiant' : 'Dire'}</div><div class="sbx-row">${tiles}</div></div>`;
  };
  let picker = '<div class="sbx-hint">Нажмите на героя, чтобы заменить его или поменять ему позицию.</div>';
  if (sandbox.sel != null) {
    const o = HERO_BY_ID.get(sandbox.sel);
    const curHero = HERO_BY_ID.get(sandbox.swaps[sandbox.sel] || sandbox.sel);
    picker = `<div class="sbx-pick">
      <div class="sbx-pos"><span>Позиция <b>${esc(curHero.name)}</b>:</span>
        ${[1, 2, 3, 4, 5].map((p) => `<button type="button" class="pos-chip${pos[sandbox.sel] === p ? ' on' : ''}" data-sb="pos" data-p="${p}" title="${POS_NAMES[p - 1]}">${p}</button>`).join('')}
        <small class="muted">если позиция занята — герои поменяются местами</small></div>
      <div class="sbx-pick-head"><span>Замена для <b>${esc(o.name)}</b> · поз. ${pos[sandbox.sel] || '?'}</span>
        <label class="search-box small"><input data-sb="q" placeholder="Поиск героя" autocomplete="off"></label></div>
      <div class="sbx-grid">${sandboxCandidates(m).map((h) => `<button type="button" class="sbx-cand a-${h.attr}${sandbox.swaps[sandbox.sel] === h.id ? ' on' : ''}" data-sb="swap" data-id="${h.id}" data-name="${esc(h.name.toLowerCase())}" title="${esc(h.name)}">
        <img src="${heroImg(h)}" alt=""><span>${esc(h.name)}</span></button>`).join('')}</div></div>`;
  }
  // Сравнение «было → стало» для обеих команд
  let delta = '';
  if (ev !== real) {
    const d = (ev.pRadiant - real.pRadiant) * 100;
    const fmtP = (p) => `${(p * 100).toFixed(1)}%`;
    delta = `<div class="sbx-delta">
      <span class="side-r"><b>${esc(teamName(radT))}</b> ${fmtP(real.pRadiant)} → <b>${fmtP(ev.pRadiant)}</b></span>
      <em class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}% Radiant</em>
      <span class="side-d"><b>${esc(teamName(E.other(radT)))}</b> ${fmtP(1 - real.pRadiant)} → <b>${fmtP(1 - ev.pRadiant)}</b></span></div>`;
  }
  return `<div class="sandbox">
    <div class="sbx-head"><div><b>Песочница · другой пик и позиции</b><span class="muted">Шансы пересчитываются по той же модели. На результат карты не влияет.</span></div>
      <div class="sbx-actions"><button type="button" class="btn small" data-sb="reset"${Object.keys(sandbox.swaps).length || sandboxPosChanged(m) ? '' : ' disabled'}>Сбросить изменения</button>
      <button type="button" class="btn small" data-sb="close">Закрыть</button></div></div>
    ${delta}
    <div class="sbx-teams">${team(radT)}${team(E.other(radT))}</div>
    ${picker}
  </div>`;
}

function onSandboxClick(e) {
  const t = e.target.closest('[data-sb]');
  if (!t || t.tagName === 'INPUT') return;
  const id = +t.dataset.id;
  switch (t.dataset.sb) {
    case 'open': sandbox = { key: sandboxKey(), swaps: {}, pos: realPositions(map()), sel: null }; break;
    case 'close': sandbox = null; break;
    case 'reset': sandbox.swaps = {}; sandbox.pos = realPositions(map()); sandbox.sel = null; break;
    case 'pos': {
      // Новая позиция выбранному герою; тиммейт, стоявший на ней, получает его старую позицию
      const p = +t.dataset.p;
      const m = map();
      const team = picksOf(m, 'A').includes(sandbox.sel) ? 'A' : 'B';
      const mate = picksOf(m, team).find((x) => x !== sandbox.sel && sandbox.pos[x] === p);
      if (mate != null) sandbox.pos[mate] = sandbox.pos[sandbox.sel];
      sandbox.pos[sandbox.sel] = p;
      break;
    }
    case 'sel': sandbox.sel = sandbox.sel === id ? null : id; break;
    case 'swap':
      if (id === sandbox.sel) delete sandbox.swaps[sandbox.sel];
      else sandbox.swaps[sandbox.sel] = id;
      sandbox.sel = null;
      break;
    default: return;
  }
  render();
}

function onSandboxSearch(e) {
  if (e.target.dataset.sb !== 'q') return;
  const q = e.target.value.trim().toLowerCase();
  $('evalBox').querySelectorAll('.sbx-cand').forEach((b) => b.classList.toggle('dim', !!q && !b.dataset.name.includes(q)));
}

/* Пик-трейнинг: шансы команд и разбор драфта */
function renderEval() {
  const box = $('evalBox');
  const m = map();
  const real = m.eval;
  box.classList.toggle('hidden', !real);
  if (!real) { sandbox = null; return; }
  if (sandbox && sandbox.key !== sandboxKey()) sandbox = null;
  const ev = sandboxEval(m) || real;
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

  const testing = ev !== real;
  const decided = m.winner && m.autoWin && !testing;
  box.innerHTML = `
    <div class="eval-head">
      <div class="eval-title">${testing ? 'Оценка драфта с заменами' : 'Оценка драфта'}</div>
      <div class="eval-sub">Модель STRATZ · ${esc(ev.bracket.label)} · угадывает исход матча по драфту в ${Math.round(ev.bracket.accuracy * 100)}% случаев</div>
    </div>
    ${renderSandbox(m, radT, real, ev)}
    <div class="odds">
      <div class="odds-team side-r ${pR > pD ? 'lead' : ''}"><small>Radiant</small><b>${esc(teamName(radT))}</b><em>${fmt(pR)}</em></div>
      <div class="odds-bar"><span class="r" style="width:${pR}%"></span><span class="d" style="width:${pD}%"></span><i></i></div>
      <div class="odds-team side-d ${pD > pR ? 'lead' : ''}"><small>Dire</small><b>${esc(teamName(dirT))}</b><em>${fmt(pD)}</em></div>
    </div>
    ${decided ? `<div class="verdict">${TROPHY} Победа засчитана: <b class="${m.winner === radT ? 'side-r' : 'side-d'}">${esc(teamName(m.winner))}</b></div>` : ''}
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
      <div class="eval-card eval-wide"><div class="ec-col">
        <h4>Вклад героев</h4>
        <div class="hero-impact">
          ${[['radiant', radT], ['dire', dirT]].map(([side, t]) => `<div class="hi-col"><div class="hi-name ${side === 'radiant' ? 'side-r' : 'side-d'}">${esc(teamName(t))}</div>
            ${heroesBy(side).map((h) => {
              const own = side === 'radiant' ? h.pp : -h.pp; // вклад в пользу своей команды
              const posTag = h.pos ? `<i class="hi-pos${h.posShare != null && h.posShare < 0.1 ? ' warn' : ''}" title="${POS_NAMES[h.pos - 1]}${h.posShare != null ? ` — ${Math.round(h.posShare * 100)}% игр героя` : ''}">${h.pos}</i>` : '';
              return `<div class="hi-row">${heroImgTag(h.id)}<span>${posTag}${heroName(h.id)}</span><b class="${own >= 0 ? 'pos' : 'neg'}">${signed(own)}</b></div>`;
            }).join('')}</div>`).join('')}
        </div></div><div class="ec-col">
        ${offRole.length ? `<h4>Непривычные позиции</h4>${offRole.map((h) => {
          const own = h.side === 'radiant' ? h.posPP : -h.posPP;
          return `<div class="off-row">${heroImgTag(h.id)}<span>${heroName(h.id)} на поз. ${h.pos} — так его играют лишь в ${Math.max(1, Math.round(h.posShare * 100))}% игр</span><b class="${own >= 0 ? 'pos' : 'neg'}">${signed(own)}</b></div>`;
        }).join('')}` : ''}
        <h4>Роли в составе</h4>
        <div class="roles">
          ${roles.map((c) => `<div class="role-row"><span>${esc(c.label)}</span><b class="side-r">${c.radiant}</b><i>:</i><b class="side-d">${c.dire}</b></div>`).join('')}
        </div>
      </div></div>
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
    row.appendChild(el('div', 'hist-map', `Карта ${idx + 1}<br><small>${TROPHY} ${esc(teamName(m.winner))}${odds}</small>`));
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
  const S = st();
  const isAdmin = view.role === 'admin';
  const hasClock = !!S.clock && !!E.curStep(S);
  // Без сервера ссылок нет — панель нужна только для паузы таймера
  $('adminPanel').classList.toggle('hidden', !isAdmin || (!!view.local && !hasClock));
  if (!isAdmin) return;
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
    poolMode: segValue('poolMode'),
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
  $('linksSub').textContent = serverInfo ? 'Каждый капитан — со своего устройства' : 'Нужен запущенный сервер';
  $('modeHint').textContent = !serverInfo
    ? (location.hostname.endsWith('github.io')
      ? 'Демо-версия: здесь нет сервера. Чтобы капитаны пикали по ссылкам, запустите сервер у себя — инструкция в README репозитория.'
      : '')
    : segValue('mode') === 'links'
      ? 'После создания появятся ссылки для капитанов и зрителей. Победителя карты отмечает админ.'
      : 'Обе команды пикают на этом устройстве. Ссылку для зрителей / OBS всё равно можно раздать.';
  document.querySelectorAll('#poolPresets button').forEach((b) => b.classList.toggle('on', +b.dataset.v === s.poolSize));

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
      ? 'После драфта команды расставят героев по позициям, модель оценит шансы, покажет разбор и сама засчитает победу стороне с бо́льшим шансом.'
      : 'Обычный режим: победителя каждой карты отмечает админ.';
  renderSummary(s, trainerOn);
  return !warn;
}

// Сводка справа: команды, карты серии (где монетка), параметры лобби
function renderSummary(s, trainerOn) {
  $('sumNameA').textContent = s.nameA;
  $('sumNameB').textContent = s.nameB;
  $('sumMaps').innerHTML = Array.from({ length: s.bestOf }, (_, i) =>
    `<span class="${E.isCoinMap(i) ? 'is-coin' : ''}" title="${E.isCoinMap(i) ? 'Подброс монеты' : 'Первым выбирает проигравший монетку на прошлой карте'}">Карта ${i + 1}</span>`).join('');
  const bracketLabel = trainerOn ? ($('bracket').selectedOptions[0] || { textContent: '' }).textContent.split(' — ')[0] : '';
  const rows = [
    ['Формат', `Bo${s.bestOf}`],
    ['Режим', s.hotseat || !serverInfo ? 'Одно устройство' : 'Капитаны по ссылкам'],
    ['Пул на карту', `${s.poolSize} героев · ${s.poolMode === 'balanced' ? 'поровну по атрибутам' : 'рандом'}`],
    ['Баны', s.bans ? 'Есть' : 'Только пики'],
    ['Таймер', s.timer ? '30с + 130с резерв' : 'Без таймера'],
    ['Тип', trainerOn ? `Пик-трейнинг${bracketLabel ? ' · ' + bracketLabel : ''}` : 'Обычный'],
  ];
  $('summaryList').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('startNote').textContent = serverInfo
    ? 'Лобби сохранится на сервере — после создания появятся ссылки'
    : 'Лобби сохранится только в этом браузере';
}

function renderServerStatus() {
  const pill = $('serverStatus');
  pill.className = 'server-pill' + (serverInfo ? '' : ' off');
  pill.innerHTML = serverInfo
    ? 'Сервер запущен — капитаны могут подключаться по ссылкам'
    : 'Сервер офлайн — доступен режим «Одно устройство» <a href="https://github.com/Rabbau/DotaPicker#запуск-в-локальной-сети--пошаговая-инструкция" target="_blank" rel="noopener">Как запустить</a>';
}

// Контурный кубок вместо эмодзи 🏆 — цвет берётся от текста (currentColor)
const TROPHY = '<svg class="ic-trophy" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v1.5a3.5 3.5 0 0 1-3.5 3.5"/><path d="M7 5H4v1.5A3.5 3.5 0 0 0 7.5 10"/></svg>';

const CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>';

function renderRecent() {
  const list = lsGet(RECENT_KEY, []);
  $('recent').classList.toggle('hidden', !list.length);
  $('recentList').innerHTML = '';
  const local = lsGet(LOCAL_KEY, null);
  list.forEach((r) => {
    let sub = r.bestOf ? `Bo${r.bestOf}` : '';
    let chip = new Date(r.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    if (r.local && local) {
      // Локальное лобби хранится в браузере — можно показать карту и счёт
      sub = `Bo${local.settings.bestOf} · Карта ${local.maps.length}${local.over ? ' · серия завершена' : ''}`;
      chip = `${local.score.A} : ${local.score.B}`;
    }
    sub = [sub, r.local ? 'одно устройство' : 'на сервере'].filter(Boolean).join(' · ');
    const a = el('a', 'recent-item', `<div class="ri-body"><span class="ri-title">${esc(r.nameA)} <i>vs</i> ${esc(r.nameB)}</span>
      <span class="ri-sub">${esc(sub)}</span></div><span class="ri-chip">${esc(chip)}</span>${CHEVRON}`);
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
      rememberLobby({ id: d.id, key: d.keys.admin, nameA: s.nameA, nameB: s.nameB, bestOf: s.bestOf, at: Date.now() });
      location.href = `?lobby=${d.id}&key=${d.keys.admin}`;
    } else {
      const state = E.createSeries({ ...s, hotseat: true }, HEROES, Date.now());
      lsSet(LOCAL_KEY, state);
      rememberLobby({ local: true, nameA: s.nameA, nameB: s.nameB, bestOf: s.bestOf, at: Date.now() });
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
  $('nameA').addEventListener('input', validateSetup);
  $('nameB').addEventListener('input', validateSetup);
  $('bracket').addEventListener('change', validateSetup);
  const setPool = (v) => { $('poolSize').value = Math.max(10, Math.min(HEROES.length, v)); validateSetup(); };
  $('poolDec').addEventListener('click', () => setPool((parseInt($('poolSize').value, 10) || 36) - 2));
  $('poolInc').addEventListener('click', () => setPool((parseInt($('poolSize').value, 10) || 36) + 2));
  document.querySelectorAll('#poolPresets button').forEach((b) => b.addEventListener('click', () => setPool(+b.dataset.v)));
  $('startBtn').addEventListener('click', createLobby);
}

function showSetup() {
  renderServerStatus();
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
  $('evalBox').addEventListener('click', onSandboxClick);
  $('evalBox').addEventListener('input', onSandboxSearch);
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
