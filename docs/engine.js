/*
 * Логика драфта Captain's Draft × Fearless.
 * Общая для сервера (Node.js) и браузера (режим «одно устройство» без сервера).
 * Состояние — простой JSON; все изменения идут через apply() и tick().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TURN_TIME = 30;      // секунд на ход
  const RESERVE_TIME = 130;  // резерв команды на карту
  const COIN_MS = 3200;      // длительность анимации монетки

  // Схема BetBoom Streamers Battle 15: у каждой команды 2 бана и 3 пика, затем 2 бана и 2 финальных пика.
  // F — команда с первым пиком, S — с последним.
  const ORDER_WITH_BANS = [
    ['F', 'ban'], ['S', 'ban'], ['F', 'ban'], ['S', 'ban'],
    ['F', 'pick'], ['S', 'pick'], ['S', 'pick'], ['F', 'pick'], ['F', 'pick'], ['S', 'pick'],
    ['F', 'ban'], ['S', 'ban'], ['F', 'ban'], ['S', 'ban'],
    ['S', 'pick'], ['F', 'pick'], ['F', 'pick'], ['S', 'pick'],
  ];
  const ORDER_NO_BANS = [
    ['F', 'pick'], ['S', 'pick'], ['S', 'pick'], ['F', 'pick'], ['F', 'pick'],
    ['S', 'pick'], ['S', 'pick'], ['F', 'pick'], ['F', 'pick'], ['S', 'pick'],
  ];

  const CHOICES = {
    radiant: { kind: 'side', label: 'Radiant' },
    dire: { kind: 'side', label: 'Dire' },
    first: { kind: 'order', label: 'Первый пик' },
    last: { kind: 'order', label: 'Последний пик' },
  };

  const other = (t) => (t === 'A' ? 'B' : 'A');

  function shuffle(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function fail(msg) { throw new Error(msg); }

  function buildSequence(first, withBans, poolLen) {
    const steps = (withBans ? ORDER_WITH_BANS : ORDER_NO_BANS).map(([who, type]) => ({ who, type }));
    // Если героев не хватает на все баны — убираем последние баны парами
    let maxBans = Math.max(0, poolLen - 10);
    maxBans -= maxBans % 2;
    let bans = steps.filter((s) => s.type === 'ban').length;
    while (bans > maxBans) {
      steps.splice(steps.map((s) => s.type).lastIndexOf('ban'), 1);
      bans--;
    }
    return steps.map((s) => ({ team: s.who === 'F' ? first : other(first), type: s.type }));
  }

  // Монетка бросается на нечётных картах (1, 3, 5); на чётных первым выбирает проигравший монетку на предыдущей карте
  function isCoinMap(index) {
    return index % 2 === 0;
  }

  function sanitizeSettings(s, heroCount) {
    const bestOf = [1, 3, 5].includes(+s.bestOf) ? +s.bestOf : 3;
    const bans = s.bans !== false;
    const minPool = bans ? 18 : 10;
    const maxPool = heroCount - (bestOf - 1) * 10;
    const poolSize = Math.max(minPool, Math.min(maxPool, parseInt(s.poolSize, 10) || 36));
    const name = (v, d) => String(v || '').trim().slice(0, 24) || d;
    return {
      nameA: name(s.nameA, 'Team 1'),
      nameB: name(s.nameB, 'Team 2'),
      bestOf, poolSize, bans,
      timer: !!s.timer,
      hotseat: !!s.hotseat,
      // Пик-трейнинг: после драфта модель оценивает шансы и сама засчитывает победу
      trainer: !!s.trainer,
      bracket: ['all', 'legend_ancient', 'divine_immortal'].includes(s.bracket) ? s.bracket : 'all',
      // Пул героев: 'random' — полный рандом, 'balanced' — поровну героев каждого атрибута
      poolMode: s.poolMode === 'balanced' ? 'balanced' : 'random',
    };
  }

  // Оценщик драфта подключается снаружи (сервер и браузер передают модель): (bracket, radiantIds, direIds) → оценка
  let evaluator = null;
  function setEvaluator(fn) { evaluator = fn; }

  /* ---------- Серия и карты ---------- */

  /**
   * heroes — список героев: id или { id, attr }. Атрибуты нужны для режима «поровну по атрибутам».
   */
  function createSeries(settings, heroes, now, rnd = Math.random) {
    const heroIds = heroes.map((h) => (typeof h === 'object' ? h.id : h));
    const heroAttr = {};
    heroes.forEach((h) => { if (typeof h === 'object' && h.attr) heroAttr[h.id] = h.attr; });
    const st = {
      v: 1,
      createdAt: now,
      settings: sanitizeSettings(settings, heroIds.length),
      heroIds,
      heroAttr,
      burned: [],
      maps: [],
      score: { A: 0, B: 0 },
      over: false,
      clock: null,
    };
    startMap(st, rnd);
    return st;
  }

// Пул карты из доступных (ещё не сыгранных в серии) героев
  function buildPool(st, rest, rnd) {
    const size = st.settings.poolSize;
    const attrs = ['str', 'agi', 'int', 'all'];
    if (st.settings.poolMode !== 'balanced' || !st.heroAttr || !Object.keys(st.heroAttr).length) {
      return shuffle(rest, rnd).slice(0, size);
    }
    // Поровну по атрибутам; остаток от деления на 4 — случайным атрибутам
    const groups = Object.fromEntries(attrs.map((a) => [a, shuffle(rest.filter((id) => st.heroAttr[id] === a), rnd)]));
    const quota = Object.fromEntries(attrs.map((a) => [a, Math.floor(size / 4)]));
    shuffle(attrs, rnd).slice(0, size % 4).forEach((a) => { quota[a]++; });
    const pool = [];
    for (const a of attrs) pool.push(...groups[a].splice(0, quota[a]));
    // Если в каком-то атрибуте героев не хватило (поздние карты Fearless) — добираем из остальных
    if (pool.length < size) {
      const left = shuffle(rest.filter((id) => !pool.includes(id)), rnd);
      pool.push(...left.slice(0, size - pool.length));
    }
    return pool;
  }

  function startMap(st, rnd) {
    const index = st.maps.length;
    const rest = st.heroIds.filter((id) => !st.burned.includes(id));
    const coin = isCoinMap(index);
    // На картах без монетки первым выбирает проигравший последний бросок монетки
    const lastCoin = st.maps.slice().reverse().find((mm) => mm.coin);
    st.maps.push({
      pool: buildPool(st, rest, rnd),
      coinMap: coin,
      phase: coin ? 'coin' : 'choice1',   // coin → choice1 → choice2 → draft → done [→ evaluated] → result
      coin: null,                          // { winner, at }
      chooser: coin ? null : other(lastCoin.coin.winner),
      choices: [],                         // [{ team, value }]
      sides: null,                         // { A: 'radiant'|'dire', B: ... }
      first: null,                         // команда с первым пиком
      seq: [],
      actions: [],
      winner: null,
    });
    st.clock = null;
  }

  const curMap = (st) => st.maps[st.maps.length - 1];
  const curStep = (st) => {
    const m = curMap(st);
    return m.phase === 'draft' ? m.seq[m.actions.length] || null : null;
  };

  function usedInMap(m) {
    const used = new Map();
    m.actions.forEach((id, i) => used.set(id, m.seq[i]));
    return used;
  }

  function isAvailable(m, id) {
    return m.pool.includes(id) && !m.actions.includes(id);
  }

  // Кто сейчас должен действовать: команда 'A'/'B' или null
  function actingTeam(st) {
    if (st.over) return null;
    const m = curMap(st);
    if (m.phase === 'choice1') return m.chooser;
    if (m.phase === 'choice2') return other(m.chooser);
    if (m.phase === 'draft') { const s = curStep(st); return s ? s.team : null; }
    return null;
  }

  function canControl(st, role, team) {
    return role === team || (role === 'admin' && st.settings.hotseat);
  }

  /* ---------- Таймер ---------- */

  function startClock(st, now, keepReserve) {
    if (!st.settings.timer) { st.clock = null; return; }
    const reserve = keepReserve && st.clock ? st.clock.reserve : { A: RESERVE_TIME, B: RESERVE_TIME };
    const paused = st.clock && st.clock.pausedAt != null;
    st.clock = { since: now, reserve: { ...reserve }, pausedAt: paused ? now : null };
  }

  // Текущее состояние таймера для команды, чей ход
  function clockView(clock, team, now) {
    if (!clock) return null;
    const t = clock.pausedAt != null ? clock.pausedAt : now;
    const elapsed = Math.max(0, (t - clock.since) / 1000);
    const turnLeft = Math.max(0, TURN_TIME - elapsed);
    const reserve = { ...clock.reserve };
    if (team) reserve[team] = Math.max(0, reserve[team] - Math.max(0, elapsed - TURN_TIME));
    return { turnLeft, reserve, paused: clock.pausedAt != null, expired: !!team && turnLeft <= 0 && reserve[team] <= 0 };
  }

  function commitClock(st, team, now) {
    if (!st.clock) return;
    const v = clockView(st.clock, team, now);
    st.clock.reserve = v.reserve;
    startClock(st, now, true);
  }

  /* ---------- Действия ---------- */

  function finishChoices(st, m, now) {
    const sideC = m.choices.find((c) => CHOICES[c.value].kind === 'side');
    const orderC = m.choices.find((c) => CHOICES[c.value].kind === 'order');
    const opp = { radiant: 'dire', dire: 'radiant' };
    m.sides = { [sideC.team]: sideC.value, [other(sideC.team)]: opp[sideC.value] };
    m.first = orderC.value === 'first' ? orderC.team : other(orderC.team);
    m.seq = buildSequence(m.first, st.settings.bans, m.pool.length);
    m.phase = 'draft';
    startClock(st, now, false);
  }

  function doPick(st, heroId, now) {
    const m = curMap(st);
    const step = curStep(st);
    commitClock(st, step.team, now);
    m.actions.push(heroId);
    if (m.actions.length >= m.seq.length) {
      st.clock = null;
      // Пик-трейнинг: перед оценкой капитаны расставляют героев по позициям 1–5
      if (st.settings.trainer && evaluator) {
        m.phase = 'positions';
        m.positions = { A: null, B: null };
      } else {
        m.phase = 'done';
      }
    }
  }

  // Отправка расстановки: { heroId: позиция } — каждый пикнутый герой команды на своей позиции 1–5
  function submitPositions(st, m, team, positions) {
    const picks = picksOf(m, team);
    const map = {};
    for (const id of picks) {
      const p = +(positions || {})[id];
      if (!(p >= 1 && p <= 5)) fail('Расставьте всех героев по позициям');
      map[id] = p;
    }
    if (new Set(Object.values(map)).size !== picks.length) fail('У каждого героя должна быть своя позиция');
    m.positions[team] = map;
    if (m.positions.A && m.positions.B) {
      m.phase = 'done';
      evaluateMap(st, m);
    }
  }

  function clearEvaluation(st, m) {
    if (m.winner) revertWinner(st, m);
    m.eval = null;
    m.phase = 'positions';
    m.positions = { A: null, B: null };
  }

  const picksOf = (m, team) => m.actions.filter((_, i) => m.seq[i].type === 'pick' && m.seq[i].team === team);

  // Пик-трейнинг: оценка драфта и автоматическая победа стороне с бо́льшим шансом
  function evaluateMap(st, m) {
    if (!evaluator) return;
    const rad = m.sides.A === 'radiant' ? 'A' : 'B';
    const ev = evaluator(st.settings.bracket, picksOf(m, rad), picksOf(m, other(rad)), { ...m.positions.A, ...m.positions.B });
    if (!ev) return;
    m.eval = ev;
    const p = Math.round(ev.pRadiant * 1000) / 10; // точность до 0,1%
    if (p === 50) return;                          // ровно 50 на 50 — победителя выбирает админ
    recordWinner(st, m, p > 50 ? rad : other(rad), true);
  }

  // Засчитывает победу на карте. В пик-трейнинге с автоматической победой карта ждёт кнопку «Следующая карта».
  function recordWinner(st, m, team, auto, rnd) {
    m.winner = team;
    m.autoWin = !!auto;
    st.score[team]++;
    picksOf(m, 'A').concat(picksOf(m, 'B')).forEach((id) => st.burned.push(id));
    if (st.score[team] >= Math.ceil(st.settings.bestOf / 2) || st.maps.length >= st.settings.bestOf) {
      st.over = true;
      m.phase = 'result';
    } else if (auto) {
      m.phase = 'evaluated';
    } else {
      m.phase = 'result';
      startMap(st, rnd || Math.random);
    }
  }

  function revertWinner(st, m) {
    st.score[m.winner]--;
    const picks = picksOf(m, 'A').concat(picksOf(m, 'B'));
    st.burned = st.burned.filter((id) => !picks.includes(id));
    m.winner = null;
    m.autoWin = false;
    st.over = false;
  }

  /**
   * Применяет действие. role: 'admin' | 'A' | 'B'.
   * action: { type: 'flip' | 'choose' | 'pick' | 'undo' | 'winner' | 'pause', ... }
   * Бросает Error с понятным текстом, если действие невозможно.
   */
  function apply(st, role, action, now, rnd = Math.random) {
    const m = curMap(st);
    const isAdmin = role === 'admin';
    switch (action.type) {
      case 'flip': {
        if (st.over || m.phase !== 'coin') fail('Сейчас не время бросать монету');
        if (!isAdmin && role !== 'A' && role !== 'B') fail('Нет прав');
        const winner = rnd() < 0.5 ? 'A' : 'B';
        m.coin = { winner, at: now };
        m.chooser = winner;
        m.phase = 'choice1';
        return;
      }
      case 'choose': {
        const info = CHOICES[action.value];
        if (!info) fail('Неизвестный вариант');
        if (m.phase !== 'choice1' && m.phase !== 'choice2') fail('Сейчас не этап выбора');
        const team = actingTeam(st);
        if (!canControl(st, role, team)) fail('Сейчас выбирает другая команда');
        if (m.phase === 'choice2' && CHOICES[m.choices[0].value].kind === info.kind) {
          fail(info.kind === 'side' ? 'Нужно выбрать очередь пика' : 'Нужно выбрать сторону');
        }
        m.choices.push({ team, value: action.value });
        if (m.phase === 'choice1') m.phase = 'choice2';
        else finishChoices(st, m, now);
        return;
      }
      case 'pick': {
        const step = curStep(st);
        if (!step || st.over) fail('Сейчас нельзя пикать');
        if (!canControl(st, role, step.team)) fail('Сейчас ход другой команды');
        const id = +action.heroId;
        if (!isAvailable(m, id)) fail('Этот герой недоступен');
        doPick(st, id, now);
        return;
      }
      case 'pause': {
        if (!isAdmin) fail('Только админ может ставить паузу');
        if (!st.clock) return;
        if (st.clock.pausedAt != null) {
          st.clock.since += now - st.clock.pausedAt;
          st.clock.pausedAt = null;
        } else {
          st.clock.pausedAt = now;
        }
        return;
      }
      case 'positions': {
        if (m.phase !== 'positions') fail('Сейчас не этап расстановки позиций');
        const team = role === 'A' || role === 'B' ? role : action.team;
        if (team !== 'A' && team !== 'B') fail('Не указана команда');
        if (!canControl(st, role, team)) fail('Можно расставлять только свою команду');
        if (m.positions[other(team)] && m.positions[team]) fail('Обе команды уже подтвердили расстановку');
        submitPositions(st, m, team, action.positions);
        return;
      }
      case 'winner': {
        if (!isAdmin) fail('Результат карты отмечает только админ');
        if (m.phase !== 'done') fail('Драфт ещё не завершён');
        recordWinner(st, m, action.team === 'B' ? 'B' : 'A', false, rnd);
        return;
      }
      case 'next': {
        if (!isAdmin) fail('Следующую карту запускает админ');
        if (m.phase !== 'evaluated') fail('Карта ещё не завершена');
        m.phase = 'result';
        startMap(st, rnd);
        return;
      }
      case 'restart': {
        // Новая серия с теми же настройками в том же лобби — ссылки капитанов и зрителей продолжают работать
        if (!isAdmin) fail('Начать заново может только админ');
        const fresh = createSeries(st.settings, st.heroIds.map((id) => ({ id, attr: (st.heroAttr || {})[id] })), now, rnd);
        Object.keys(st).forEach((k) => delete st[k]);
        Object.assign(st, fresh);
        return;
      }
      case 'undo': {
        if (!isAdmin) fail('Отмена доступна только админу');
        undo(st, now);
        return;
      }
      default:
        fail('Неизвестное действие');
    }
  }

  function undo(st, now) {
    const m = curMap(st);
    // Отмена результата прошлой карты (если новая карта ещё не началась)
    const untouched = (m.phase === 'coin') || (m.phase === 'choice1' && !m.coinMap);
    if (untouched && st.maps.length > 1) {
      st.maps.pop();
      const prev = curMap(st);
      st.clock = null;
      // Авто-победа пик-трейнинга: сначала возвращаемся к экрану оценки, победа пока остаётся
      if (prev.autoWin) { prev.phase = 'evaluated'; return; }
      revertWinner(st, prev);
      prev.phase = 'done';
      return;
    }
    if (st.over) {
      st.clock = null;
      // Пик-трейнинг: отмена результата возвращает к расстановке позиций
      if (m.eval) { clearEvaluation(st, m); return; }
      revertWinner(st, m);
      m.phase = 'done';
      return;
    }
    switch (m.phase) {
      case 'evaluated':
        clearEvaluation(st, m);
        return;
      case 'positions':
        // Сначала сбрасываем отправленные расстановки, затем — последний пик
        if (m.positions.A || m.positions.B) { m.positions = { A: null, B: null }; return; }
        m.positions = null;
        m.actions.pop();
        m.phase = 'draft';
        startClock(st, now, true);
        return;
      case 'done':
        if (m.eval) { clearEvaluation(st, m); return; } // 50 на 50 в пик-трейнинге
        // fallthrough
      case 'draft':
        if (m.actions.length) {
          m.eval = null;
          m.actions.pop();
          m.phase = 'draft';
          startClock(st, now, true);
        } else {
          m.choices.pop();
          m.phase = 'choice2';
          m.seq = []; m.sides = null; m.first = null;
          st.clock = null;
        }
        return;
      case 'choice2':
        m.choices.pop();
        m.phase = 'choice1';
        return;
      case 'choice1':
        if (m.coinMap) { m.coin = null; m.chooser = null; m.phase = 'coin'; return; }
        fail('Нечего отменять');
        return;
      default:
        fail('Нечего отменять');
    }
  }

  // Вызывается периодически: если время хода и резерв кончились — случайный герой
  function tick(st, now, rnd = Math.random) {
    if (!st.clock || st.over) return false;
    const step = curStep(st);
    if (!step) return false;
    const v = clockView(st.clock, step.team, now);
    if (!v.expired || v.paused) return false;
    const m = curMap(st);
    const avail = m.pool.filter((id) => isAvailable(m, id));
    if (!avail.length) return false;
    doPick(st, avail[Math.floor(rnd() * avail.length)], now);
    return true;
  }

  return {
    TURN_TIME, RESERVE_TIME, COIN_MS, CHOICES, ORDER_WITH_BANS, ORDER_NO_BANS,
    other, isCoinMap, sanitizeSettings, createSeries, apply, tick, setEvaluator,
    curMap, curStep, usedInMap, isAvailable, actingTeam, canControl, clockView,
  };
});
