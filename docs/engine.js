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

  // Монетка бросается на первой и на решающей (последней возможной) карте
  function isCoinMap(index, bestOf) {
    return index === 0 || (bestOf > 1 && index === bestOf - 1);
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
    };
  }

  /* ---------- Серия и карты ---------- */

  function createSeries(settings, heroIds, now, rnd = Math.random) {
    const st = {
      v: 1,
      createdAt: now,
      settings: sanitizeSettings(settings, heroIds.length),
      heroIds: heroIds.slice(),
      burned: [],
      maps: [],
      score: { A: 0, B: 0 },
      over: false,
      clock: null,
    };
    startMap(st, rnd);
    return st;
  }

  function startMap(st, rnd) {
    const index = st.maps.length;
    const rest = st.heroIds.filter((id) => !st.burned.includes(id));
    const coin = isCoinMap(index, st.settings.bestOf);
    const prev = st.maps[index - 1];
    st.maps.push({
      pool: shuffle(rest, rnd).slice(0, st.settings.poolSize),
      coinMap: coin,
      phase: coin ? 'coin' : 'choice1',   // coin → choice1 → choice2 → draft → done
      coin: null,                          // { winner, at }
      chooser: coin ? null : other(prev.winner), // первым выбирает проигравший прошлую карту
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
      m.phase = 'done';
      st.clock = null;
    }
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
      case 'winner': {
        if (!isAdmin) fail('Результат карты отмечает только админ');
        if (m.phase !== 'done') fail('Драфт ещё не завершён');
        const team = action.team === 'B' ? 'B' : 'A';
        m.winner = team;
        st.score[team]++;
        m.actions.forEach((id, i) => { if (m.seq[i].type === 'pick') st.burned.push(id); });
        if (st.score[team] >= Math.ceil(st.settings.bestOf / 2) || st.maps.length >= st.settings.bestOf) {
          st.over = true;
          m.phase = 'result';
        } else {
          m.phase = 'result';
          startMap(st, rnd);
        }
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
    if ((untouched && st.maps.length > 1) || st.over) {
      if (!st.over) st.maps.pop();
      const prev = curMap(st);
      st.score[prev.winner]--;
      const picks = prev.actions.filter((_, i) => prev.seq[i].type === 'pick');
      st.burned = st.burned.filter((id) => !picks.includes(id));
      prev.winner = null;
      prev.phase = 'done';
      st.over = false;
      st.clock = null;
      return;
    }
    switch (m.phase) {
      case 'done':
      case 'draft':
        if (m.actions.length) {
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
    TURN_TIME, RESERVE_TIME, COIN_MS, CHOICES,
    other, isCoinMap, sanitizeSettings, createSeries, apply, tick,
    curMap, curStep, usedInMap, isAvailable, actingTeam, canControl, clockView,
  };
});
