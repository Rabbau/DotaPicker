/*
 * Сервер драфта для локальной сети. Без внешних зависимостей — нужен только Node.js 18+.
 *   node server.js            (порт 3000)
 *   PORT=8080 node server.js
 * Капитаны и зрители получают обновления через Server-Sent Events, действия шлют POST-запросами.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Engine = require('./engine.js');
const HEROES = require('./heroes.js');

const PORT = +process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'lobbies.json');
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/engine.js': 'engine.js',
  '/heroes.js': 'heroes.js', '/style.css': 'style.css', '/favicon.ico': 'favicon.ico', '/favicon.png': 'favicon.png',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png' };

/* ---------- Хранилище лобби ---------- */

const lobbies = new Map(); // id → { id, keys: { admin, A, B }, state, clients: Set<{ res, role }> }

function loadLobbies() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const l of data) lobbies.set(l.id, { ...l, clients: new Set() });
  } catch (e) { /* файла ещё нет */ }
}

let saveTimer = null;
function saveLobbies() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = [...lobbies.values()].map(({ id, keys, state }) => ({ id, keys, state }));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(DATA_FILE, JSON.stringify(data), () => {});
  }, 300);
}

const token = (n) => crypto.randomBytes(n).toString('hex');

function roleFor(lobby, key) {
  if (key && key === lobby.keys.admin) return 'admin';
  if (key && key === lobby.keys.A) return 'A';
  if (key && key === lobby.keys.B) return 'B';
  return 'spectator';
}

function presence(lobby) {
  const p = { admin: false, A: false, B: false, spectators: 0 };
  for (const c of lobby.clients) {
    if (c.role === 'spectator') p.spectators++;
    else p[c.role] = true;
  }
  return p;
}

function payload(lobby, role) {
  return JSON.stringify({
    id: lobby.id,
    role,
    state: lobby.state,
    presence: presence(lobby),
    keys: role === 'admin' ? lobby.keys : undefined,
    serverNow: Date.now(),
  });
}

function broadcast(lobby) {
  for (const c of lobby.clients) c.res.write(`data: ${payload(lobby, c.role)}\n\n`);
}

/* ---------- Сеть ---------- */

// IPv4-адреса компьютера в локальной сети; виртуальные адаптеры — в конце списка
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const virtual = /vEthernet|WSL|VirtualBox|VMware|Hyper-V|docker|Loopback|vbox|Radmin|Hamachi|ZeroTier|Tailscale/i.test(name);
      out.push({ name, address: a.address, virtual });
    }
  }
  const rank = (a) => (a.virtual ? 10 : 0) + (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y));
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // Статика
    if (req.method === 'GET' && STATIC[p]) {
      const file = path.join(ROOT, STATIC[p]);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (req.method === 'GET' && p === '/api/info') {
      return sendJson(res, 200, { port: PORT, addresses: lanAddresses() });
    }

    // Создание лобби
    if (req.method === 'POST' && p === '/api/lobbies') {
      const settings = await readBody(req);
      const id = token(4);
      const lobby = {
        id,
        keys: { admin: token(8), A: token(8), B: token(8) },
        state: Engine.createSeries(settings, HEROES.map((h) => h.id), Date.now()),
        clients: new Set(),
      };
      lobbies.set(id, lobby);
      saveLobbies();
      console.log(`Создано лобби ${id}: ${lobby.state.settings.nameA} vs ${lobby.state.settings.nameB}`);
      return sendJson(res, 200, { id, keys: lobby.keys });
    }

    const m = p.match(/^\/api\/lobbies\/([a-f0-9]+)(?:\/(stream|action))?$/);
    if (m) {
      const lobby = lobbies.get(m[1]);
      if (!lobby) return sendJson(res, 404, { error: 'Лобби не найдено' });

      if (req.method === 'GET' && !m[2]) return sendJson(res, 200, { ok: true });

      // Поток обновлений
      if (req.method === 'GET' && m[2] === 'stream') {
        const role = roleFor(lobby, url.searchParams.get('key'));
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 1500\n\n');
        const client = { res, role };
        lobby.clients.add(client);
        broadcast(lobby);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          lobby.clients.delete(client);
          broadcast(lobby);
        });
        return;
      }

      // Действие
      if (req.method === 'POST' && m[2] === 'action') {
        const body = await readBody(req);
        const role = roleFor(lobby, body.key);
        if (role === 'spectator') return sendJson(res, 403, { error: 'Зрители не могут влиять на драфт' });
        try {
          Engine.apply(lobby.state, role, body.action || {}, Date.now());
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        saveLobbies();
        broadcast(lobby);
        return sendJson(res, 200, { ok: true });
      }
    }

    sendJson(res, 404, { error: 'Не найдено' });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'Ошибка сервера' });
  }
});

// Таймер: автопик, когда время хода и резерв кончились
setInterval(() => {
  const now = Date.now();
  for (const lobby of lobbies.values()) {
    if (Engine.tick(lobby.state, now)) { saveLobbies(); broadcast(lobby); }
  }
}, 250);

loadLobbies();
server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  const line = '─'.repeat(58);
  console.log(`\n${line}\n  TORNEUM DOTA 2 — сервер драфта запущен\n${line}`);
  console.log(`  На этом компьютере:   http://localhost:${PORT}`);
  if (addrs.length) {
    console.log('  Для других устройств в сети:');
    for (const a of addrs) console.log(`    http://${a.address}:${PORT}   (${a.name}${a.virtual ? ', виртуальный адаптер' : ''})`);
  } else {
    console.log('  ⚠ Не найдено сетевых подключений — капитаны не смогут подключиться.');
  }
  console.log(`${line}\n  Не закрывайте это окно, пока идёт турнир. Остановить: Ctrl+C\n`);
});
