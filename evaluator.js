/*
 * Оценка драфта для режима «Пик-трейнинг».
 * Считает шанс победы Radiant по модели из draft-model.js (см. scripts/build-model.js) — только по драфту —
 * и раскладывает его на понятные слагаемые: сила героев, синергии, контрпики, состав.
 * Общий для сервера (Node.js) и браузера.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftEvaluator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const COMP_LABELS = {
    Carry: 'Керри', Support: 'Саппорты', Nuker: 'Урон способностями', Disabler: 'Контроль',
    Initiator: 'Инициация', Durable: 'Живучесть', Escape: 'Мобильность', Pusher: 'Пуш', Melee: 'Ближний бой',
  };

  function index(model) {
    if (!model._idx) model._idx = new Map(model.heroIds.map((id, i) => [id, i]));
    return model._idx;
  }

  // Индекс пары (i < j) в упакованном верхнем треугольнике
  const tri = (N, i, j) => i * N - (i * (i + 1)) / 2 + (j - i - 1);

  function brackets(model) {
    if (!model) return [];
    return Object.entries(model.brackets).map(([key, b]) => ({ key, label: b.label, accuracy: b.metrics.accuracy }));
  }

  const bracketOf = (model, key) => model.brackets[key] || model.brackets.all;
  const hasPositions = (b) => !!(b && b.posShare);

  // «Непривычность» позиции (как в scripts/build-model.js): 0 для основной позиции, до 2,7 для экзотики
  const rarity = (share) => Math.min(2.7, -Math.log10(share + 0.002));

  /** Доли игр героя на позициях 1–5 (0…1) для подсказок в интерфейсе; null, если данных нет. */
  function positionShares(model, bracketKey, heroId) {
    const b = model && bracketOf(model, bracketKey);
    const i = model && index(model).get(heroId);
    if (!hasPositions(b) || i == null) return null;
    return [0, 1, 2, 3, 4].map((p) => b.posShare[i * 5 + p] / 1000);
  }

  /** Самая правдоподобная расстановка 5 героев по позициям 1–5: { heroId: позиция }. */
  function defaultPositions(model, bracketKey, heroIds) {
    const shares = heroIds.map((id) => positionShares(model, bracketKey, id) || [0.2, 0.2, 0.2, 0.2, 0.2]);
    let best = null;
    let bestScore = -Infinity;
    const perm = (rest, acc) => {
      if (!rest.length) {
        const score = acc.reduce((s, p, k) => s + Math.log(shares[k][p - 1] + 0.001), 0);
        if (score > bestScore) { bestScore = score; best = acc.slice(); }
        return;
      }
      rest.forEach((p, k) => perm(rest.filter((_, j) => j !== k), [...acc, p]));
    };
    perm([1, 2, 3, 4, 5].slice(0, heroIds.length), []);
    return Object.fromEntries(heroIds.map((id, k) => [id, best[k]]));
  }

  /**
   * radiantIds / direIds — id пикнутых героев; positions — { heroId: позиция 1–5 } (необязательно:
   * для героев без позиции берётся самая правдоподобная расстановка).
   * Возвращает шанс Radiant и разбор; все «pp» — процентные пункты в пользу Radiant (минус — в пользу Dire).
   */
  function evaluate(model, bracketKey, radiantIds, direIds, positions) {
    if (!model) return null;
    const b = bracketOf(model, bracketKey);
    if (!b) return null;
    const usePos = hasPositions(b) && b.coef.pos != null;
    const pos = {
      ...(usePos ? defaultPositions(model, bracketKey, radiantIds) : {}),
      ...(usePos ? defaultPositions(model, bracketKey, direIds) : {}),
      ...(positions || {}),
    };
    const N = model.heroIds.length;
    const idx = index(model);
    const c = b.coef;
    const hero = (i) => b.hero[i] / 10000;
    const syn = (i, j) => (i === j ? 0 : (i < j ? b.syn[tri(N, i, j)] : b.syn[tri(N, j, i)]) / 10);
    const adv = (i, j) => (i === j ? 0 : (i < j ? b.adv[tri(N, i, j)] : -b.adv[tri(N, j, i)]) / 10);

    const R = radiantIds.map((id) => idx.get(id)).filter((i) => i != null);
    const D = direIds.map((id) => idx.get(id)).filter((i) => i != null);

    // Слагаемые в логитах (+ в пользу Radiant)
    const heroL = new Map();
    const synPairs = [];
    const advPairs = [];
    let H = 0, S = 0, A = 0;
    for (const i of R) { const v = c.hero * hero(i); H += v; heroL.set(i, v); }
    for (const i of D) { const v = -c.hero * hero(i); H += v; heroL.set(i, v); }

    // Позиции: сила героя именно на своей позиции + штраф за непривычную позицию
    let P = 0;
    const posInfo = new Map();
    if (usePos) {
      const addPos = (i, sign) => {
        const p = pos[model.heroIds[i]];
        if (!(p >= 1 && p <= 5)) return;
        const share = b.posShare[i * 5 + p - 1] / 1000;
        const v = sign * (c.pos * (b.posAdj[i * 5 + p - 1] / 10000) + c.offrole * rarity(share));
        P += v;
        heroL.set(i, heroL.get(i) + v);
        posInfo.set(i, { pos: p, share, l: v });
      };
      R.forEach((i) => addPos(i, 1));
      D.forEach((i) => addPos(i, -1));
    }
    const team = (list, sign) => {
      for (let a = 0; a < list.length; a++) {
        for (let k = a + 1; k < list.length; k++) {
          const v = sign * c.syn * syn(list[a], list[k]) / 10;
          S += v;
          synPairs.push({ a: list[a], b: list[k], side: sign > 0 ? 'radiant' : 'dire', l: v });
          heroL.set(list[a], heroL.get(list[a]) + v / 2);
          heroL.set(list[k], heroL.get(list[k]) + v / 2);
        }
      }
    };
    team(R, 1);
    team(D, -1);
    for (const i of R) {
      for (const j of D) {
        const v = c.adv * adv(i, j) / 10;
        A += v;
        advPairs.push({ r: i, d: j, l: v });
        heroL.set(i, heroL.get(i) + v / 2);
        heroL.set(j, heroL.get(j) + v / 2);
      }
    }
    const comp = model.compFeatures.map((key, k) => {
      const cap = k === model.compFeatures.length - 1 ? 5 : 6;
      const sum = (list) => list.reduce((s, i) => s + model.roles[i][k], 0);
      const r = sum(R), d = sum(D);
      return { key, label: COMP_LABELS[key] || key, radiant: r, dire: d, l: c.comp[k] * (Math.min(r, cap) - Math.min(d, cap)) / 3 };
    });
    const C = comp.reduce((s, x) => s + x.l, 0);

    // Шанс считается только по драфту: бонус стороны Radiant в модели учтён при подборе весов
    // (чтобы не искажать остальные слагаемые), но на итог не влияет — оцениваем именно пики.
    const draftL = H + S + A + C + P;
    const p = sigmoid(draftL);
    const sidePP = (sigmoid(c.side) - 0.5) * 100; // только для справки
    // Перевод в процентные пункты: делим (p − 50%) пропорционально логитам слагаемых
    const k = Math.abs(draftL) > 1e-9 ? ((p - 0.5) * 100) / draftL : 0;
    const pp = (v) => +(v * k).toFixed(2);
    const id = (i) => model.heroIds[i];

    return {
      pRadiant: p,
      bracket: { key: bracketKey in model.brackets ? bracketKey : 'all', label: b.label, accuracy: b.metrics.accuracy },
      parts: { heroes: pp(H), positions: usePos ? pp(P) : null, synergy: pp(S), counters: pp(A), composition: pp(C) },
      sideBonus: +sidePP.toFixed(2), // бонус Radiant по статистике — справочно, в шанс не входит
      heroes: [...heroL.entries()].map(([i, v]) => {
        const pi = posInfo.get(i);
        return { id: id(i), side: R.includes(i) ? 'radiant' : 'dire', pp: pp(v), pos: pi ? pi.pos : null, posShare: pi ? +pi.share.toFixed(3) : null, posPP: pi ? pp(pi.l) : null };
      }),
      synergies: synPairs.map((x) => ({ a: id(x.a), b: id(x.b), side: x.side, pp: pp(x.l) }))
        .sort((x, y) => Math.abs(y.pp) - Math.abs(x.pp)).slice(0, 6),
      counters: advPairs.map((x) => ({ radiant: id(x.r), dire: id(x.d), pp: pp(x.l) }))
        .sort((x, y) => Math.abs(y.pp) - Math.abs(x.pp)).slice(0, 6),
      composition: comp.map((x) => ({ key: x.key, label: x.label, radiant: x.radiant, dire: x.dire, pp: pp(x.l) })),
    };
  }

  return { evaluate, brackets, defaultPositions, positionShares };
});
