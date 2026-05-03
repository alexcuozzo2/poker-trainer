const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { PokerGame } = require('./src/engine');
const { decideBotAction } = require('./src/bots');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const game = new PokerGame();
const clients = new Set();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

function isKnownRole(role) {
  return role === 'admin' || role === 'hero';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
}

function serveStatic(res, fileName) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': contentType(filePath) });
    res.end(data);
  });
}

function broadcast() {
  for (const client of clients) {
    client.res.write(`event: state\ndata: ${JSON.stringify(game.publicState(client.role))}\n\n`);
  }
}

function handleEvents(req, res, url) {
  const role = url.searchParams.get('role');
  if (!isKnownRole(role)) {
    res.writeHead(400);
    res.end('Unknown view role.');
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(`event: state\ndata: ${JSON.stringify(game.publicState(role))}\n\n`);
  const client = { role, res };
  clients.add(client);
  req.on('close', () => clients.delete(client));
}

function requireAdmin(body) {
  if (body.role !== 'admin') throw new Error('Admin view is required for this action.');
}

function requireHero(body) {
  if (body.role !== 'hero') throw new Error('Hero view is required for this action.');
}

function describeBotDecision(player, botType, decision) {
  const amount = decision.amount === undefined ? '' : ' to ' + decision.amount;
  return player.name + ' (' + botType + ') chooses ' + decision.action + amount + ': ' + decision.reason + '.';
}

function runAutomation() {
  let safety = 40;
  while (safety > 0 && !game.handComplete && game.actionOn) {
    const player = game.player(game.actionOn);
    const botType = String(player.botType || 'manual').toLowerCase();
    if (player.isHero || botType === 'manual') return;

    const decision = decideBotAction(game, player.seat, botType);
    if (!decision) return;

    try {
      game.applyPlayerAction(player.seat, decision.action, decision.amount);
      game.pushMessage(describeBotDecision(player, botType, decision));
    } catch (error) {
      player.botType = 'manual';
      game.pushMessage('Automation paused for ' + player.name + ': ' + error.message);
      return;
    }
    safety -= 1;
  }

  if (safety === 0) game.pushMessage('Automation paused after too many consecutive actions.');
}

function shouldRunAutomation(type) {
  return ['playerAction', 'newHand', 'configure', 'setBot'].includes(type);
}

function dispatch(body) {
  const type = String(body.type || '');
  const payload = body.payload || {};
  const role = String(body.role || '');

  if (type === 'playerAction') {
    const seat = Number(payload.seat);
    const player = game.player(seat);
    if (role === 'hero') {
      requireHero(body);
      if (!player.isHero) throw new Error('Hero can only act for the hero seat.');
      game.applyPlayerAction(seat, payload.action, payload.amount);
      return;
    }
    requireAdmin(body);
    if (player.isHero && !payload.forceHero) {
      throw new Error('Admin can only act for hero through a force override.');
    }
    game.applyPlayerAction(seat, payload.action, payload.amount);
    return;
  }

  requireAdmin(body);
  if (type === 'undo') game.undo();
  else if (type === 'newHand') game.startNewHand({ rotateButton: true, recordUndo: false });
  else if (type === 'configure') game.configureTable(payload);
  else if (type === 'setBlinds') game.setBlinds(payload);
  else if (type === 'setStack') game.setPlayerStack(payload.seat, payload.amount);
  else if (type === 'renamePlayer') game.renamePlayer(payload.seat, payload.name);
  else if (type === 'setBot') game.setPlayerBot(payload.seat, payload.botType);
  else if (type === 'setCard') game.setCardOverride(payload);
  else throw new Error('Unknown API action.');
}

async function handleApi(req, res) {
  try {
    const body = await readBody(req);
    dispatch(body);
    if (shouldRunAutomation(body.type)) runAutomation();
    broadcast();
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

const server = http.createServer((req, res) => {
  const url = parseUrl(req);
  if (req.method === 'GET' && url.pathname === '/events') {
    handleEvents(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api') {
    handleApi(req, res);
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/hero')) {
    serveStatic(res, 'index.html');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    serveStatic(res, 'landing.html');
    return;
  }
  if (req.method === 'GET') {
    const fileName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    serveStatic(res, fileName || 'landing.html');
    return;
  }
  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`Poker Trainer running on ${base}`);
  console.log(`Admin view: ${base}/admin`);
  console.log(`Hero view:  ${base}/hero`);
  console.log('Use a tunnel or deployment URL with the same /admin and /hero paths for remote play.');
});
