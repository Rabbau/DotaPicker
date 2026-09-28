/*
 * Обновляет список героев (heroes.js) из OpenDota API — например, когда в игру добавили нового героя.
 *   npm run update:heroes   (или node scripts/update-heroes.js)
 * Нужен интернет. После обновления не забудьте пересобрать демо: npm run build:docs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'heroes.js');

(async () => {
  const res = await fetch('https://api.opendota.com/api/heroes');
  if (!res.ok) throw new Error(`OpenDota ответил ${res.status}`);
  const list = (await res.json())
    .map((h) => ({ id: h.id, key: h.name.replace('npc_dota_hero_', ''), name: h.localized_name, attr: h.primary_attr }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const body = list.map((h) => '  ' + JSON.stringify(h)).join(',\n');
  fs.writeFileSync(OUT,
    '// Список героев Dota 2 (источник: OpenDota API)\n' +
    `const HEROES = [\n${body}\n];\n\n` +
    "if (typeof module === 'object' && module.exports) module.exports = HEROES;\n");
  console.log(`Готово: ${list.length} героев записано в heroes.js`);
})().catch((e) => {
  console.error('Не удалось обновить список героев:', e.message);
  process.exit(1);
});
