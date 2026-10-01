/*
 * Собирает демо-версию сайта в папку docs/ для GitHub Pages.
 *   npm run build:docs   (или node scripts/build-docs.js)
 * Копирует клиентские файлы; скриншоты в docs/screenshots не трогает.
 * На GitHub Pages нет сервера, поэтому демо работает в режиме «Одно устройство».
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const FILES = ['index.html', 'app.js', 'engine.js', 'evaluator.js', 'heroes.js', 'draft-model.js', 'style.css', 'favicon.ico', 'favicon.png'];

fs.mkdirSync(DOCS, { recursive: true });
for (const f of FILES) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.log(`  (пропущен ${f} — файла нет; для draft-model.js выполните npm run build:model)`);
    continue;
  }
  fs.copyFileSync(path.join(ROOT, f), path.join(DOCS, f));
  console.log(`  docs/${f}`);
}
// Отключаем обработку Jekyll — файлы отдаются как есть
fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');
console.log('  docs/.nojekyll\nГотово: папка docs/ обновлена.');
