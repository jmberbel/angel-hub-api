const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const os = require('os');
const { execSync } = require('child_process');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase.operaciones.educaedtech.tools';
const SUPABASE_HOST = process.env.SUPABASE_HOST || null;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_KEY = process.env.RESEND_KEY;
const PORT = process.env.PORT || 3000;
const ANGEL_HUB_TOKEN = process.env.ANGEL_HUB_TOKEN; // Bearer token for Claude Code CLI
const ANGEL_PASSWORD = process.env.ANGEL_PASSWORD;   // Human password for OAuth login (Claude.ai web)
const BASE_URL = process.env.BASE_URL || 'https://informe-angel.operaciones.educaedtech.tools';

// MCP write scope. Values mirror the Angel Hub app (angel_hub.html); no tool can delete.
const WRITABLE_BOARDS = ['weekly', 'weekly_ops', 'strategy', 'strategy_ops', 'strategy_dir'];
const CARD_STATUSES = ['normal', 'yellow', 'pink', 'green'];
const ROADMAPS = ['edtech', 'ops'];
const ROADMAP_CATEGORIES = ['ALWAYS', 'OPERATIVOS', 'ESTRATÉGICOS'];
const ROADMAP_STATUSES = ['pendiente', 'proceso', 'done'];
const ROADMAP_SLOTS = 42;
const NOTE_TAGS = ['Idea', 'Pendiente', 'Reunión', 'Tech', 'Estrategia', 'Personal'];

// OAuth state (in-memory)
const authCodes = new Map();   // code -> { redirectUri, codeChallenge, expiresAt }
const accessTokens = new Set();
const oauthLog = []; // last 20 oauth events for debugging
function oLog(event, data) {
  oauthLog.push({ ts: new Date().toISOString(), event, ...data });
  if (oauthLog.length > 20) oauthLog.shift();
}

setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 300_000);

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

function he(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function supabaseRequest(method, path, payload) {
  const fullUrl = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };
  const body = payload !== undefined ? JSON.stringify(payload) : undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
    headers['Prefer'] = 'return=representation';
  }
  // If using internal IP, override Host + SNI so Traefik routes correctly
  if (SUPABASE_HOST) {
    headers['Host'] = SUPABASE_HOST;
    const urlObj = new URL(fullUrl);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
        servername: SUPABASE_HOST,
        rejectUnauthorized: false
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
  return fetchJson(fullUrl, { method, headers, body });
}

function supabaseGet(path) {
  return supabaseRequest('GET', path);
}

// Writes fail loudly so the MCP client sees the Supabase error instead of empty data
async function supabaseWrite(method, path, payload) {
  const r = await supabaseRequest(method, path, payload);
  if (r.status >= 300) {
    const detail = typeof r.body === 'string' ? r.body : (r.body && (r.body.message || JSON.stringify(r.body)));
    throw new Error(`Supabase ${method} ${path.split('?')[0]} failed (${r.status}): ${detail}`);
  }
  console.log(`[mcp-write] ${new Date().toISOString()} ${method} ${path}`);
  return Array.isArray(r.body) ? r.body[0] : r.body;
}

function isAuthorized(req) {
  if (!ANGEL_HUB_TOKEN && !ANGEL_PASSWORD) return true;
  const authHeader = req.headers['authorization'] || '';
  const incoming = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-api-key'] || '');
  return Boolean((ANGEL_HUB_TOKEN && incoming === ANGEL_HUB_TOKEN) || accessTokens.has(incoming));
}

function buildHtml(date, calendarEvents, columns, cards) {
  // column_id in cards stores the column NAME (not numeric id)
  const colByName = {};
  for (const col of columns) colByName[col.name] = col;

  const boardData = { weekly: {}, weekly_ops: {} };
  for (const card of cards) {
    const board = card.board;
    const colName = card.column_id || 'Sin columna';
    if (!boardData[board][colName]) boardData[board][colName] = [];
    boardData[board][colName].push(card);
  }

  let calendarHtml = '';
  if (!calendarEvents || calendarEvents.length === 0) {
    calendarHtml = '<p style="color:#666">Sin reuniones programadas para hoy.</p>';
  } else {
    calendarHtml = '<ul style="list-style:none;padding:0;margin:0">';
    for (const ev of calendarEvents) {
      calendarHtml += `<li style="padding:6px 0;border-bottom:1px solid #f0f0f0">• <strong>${ev.start} - ${ev.end}</strong> ${ev.title}</li>`;
    }
    calendarHtml += '</ul>';
  }

  function buildBoard(boardKey) {
    const boardCols = boardData[boardKey];
    if (!boardCols || Object.keys(boardCols).length === 0) return '<p style="color:#666">Sin tareas.</p>';
    // Sort columns by their position in the DB
    const sortedNames = Object.keys(boardCols).sort((a, b) => {
      const posA = colByName[a]?.position ?? 999;
      const posB = colByName[b]?.position ?? 999;
      return posA - posB;
    });
    let html = '';
    for (const colName of sortedNames) {
      const colCards = boardCols[colName];
      html += `<div style="margin-bottom:16px"><p style="font-weight:bold;color:#244A80;margin:0 0 6px 0">${colName}</p><ul style="list-style:none;padding:0;margin:0">`;
      const sorted = [...colCards].sort((a, b) => (a.status === 'normal' ? 1 : -1));
      for (const card of sorted) {
        const dot = card.status !== 'normal' ? '🔴 ' : '• ';
        html += `<li style="padding:3px 0">${dot}${card.text}</li>`;
      }
      html += '</ul></div>';
    }
    return html;
  }

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#fff;color:#222;max-width:640px;margin:0 auto;padding:24px">
<h1 style="color:#244A80;font-size:20px;margin-bottom:4px">Informe diario Angel Hub</h1>
<p style="color:#888;margin-top:0;margin-bottom:24px">${date}</p>
<h2 style="color:#244A80;font-size:16px;border-bottom:2px solid #244A80;padding-bottom:6px">Tu día de hoy</h2>
${calendarHtml}
<h2 style="color:#244A80;font-size:16px;border-bottom:2px solid #244A80;padding-bottom:6px;margin-top:28px">Weekly Board · Edtech</h2>
${buildBoard('weekly')}
<h2 style="color:#244A80;font-size:16px;border-bottom:2px solid #244A80;padding-bottom:6px;margin-top:28px">Weekly Board · OPS</h2>
${buildBoard('weekly_ops')}
<p style="color:#bbb;font-size:11px;margin-top:32px">Generado automáticamente por Angel Hub</p>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // Debug endpoints expose Supabase data and network info: same auth as /mcp
  if (url.pathname.startsWith('/debug-') && !isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // OAuth debug log
  if (url.pathname === '/debug-oauth-log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(oauthLog, null, 2));
    return;
  }

  // CORS preflight for OAuth endpoints
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // OAuth protected resource metadata (RFC 9728) — Claude.ai uses this to discover the auth server
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      resource: BASE_URL,
      authorization_servers: [BASE_URL]
    }));
    return;
  }

  // OAuth discovery
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/authorize`,
      token_endpoint: `${BASE_URL}/token`,
      registration_endpoint: `${BASE_URL}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256']
    }));
    return;
  }

  // Dynamic client registration (RFC 7591)
  if (url.pathname === '/register' && req.method === 'POST') {
    const body = JSON.parse(await parseBody(req) || '{}');
    const clientId = b64url(crypto.randomBytes(16));
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      client_id: clientId,
      client_name: body.client_name || 'client',
      redirect_uris: body.redirect_uris || [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }));
    return;
  }

  // OAuth authorize — GET: show login form, POST: process login
  if (url.pathname === '/authorize') {
    if (req.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const codeChallenge = url.searchParams.get('code_challenge') || '';
      const clientId = url.searchParams.get('client_id') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Angel Hub — Acceso</title>
<style>
  body{font-family:sans-serif;background:#f5f7fa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#fff;border-radius:12px;padding:40px 36px;box-shadow:0 2px 16px rgba(0,0,0,.08);width:100%;max-width:360px}
  h1{color:#244A80;font-size:18px;margin:0 0 8px}
  p{color:#888;font-size:14px;margin:0 0 24px}
  input{width:100%;box-sizing:border-box;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:16px}
  button{width:100%;padding:11px;background:#244A80;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}
  button:hover{background:#1a3460}
</style></head><body>
<div class="card">
  <h1>Angel Hub</h1>
  <p>Introduce tu contraseña de acceso para conectar con Claude.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="state" value="${he(state)}">
    <input type="hidden" name="redirect_uri" value="${he(redirectUri)}">
    <input type="hidden" name="code_challenge" value="${he(codeChallenge)}">
    <input type="hidden" name="client_id" value="${he(clientId)}">
    <input type="password" name="password" placeholder="Contraseña" autofocus required>
    <button type="submit">Conectar</button>
  </form>
</div></body></html>`);
      return;
    }

    if (req.method === 'POST') {
      const body = parseForm(await parseBody(req));
      const { password, redirect_uri, code_challenge, state, client_id } = body;

      oLog('authorize_post', { passwordMatch: password === ANGEL_PASSWORD, hasPassword: !!ANGEL_PASSWORD, redirectUri: redirect_uri?.slice(0, 60) });
      if (!ANGEL_PASSWORD || password.trim() !== ANGEL_PASSWORD.trim()) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Angel Hub — Acceso</title>
<style>
  body{font-family:sans-serif;background:#f5f7fa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#fff;border-radius:12px;padding:40px 36px;box-shadow:0 2px 16px rgba(0,0,0,.08);width:100%;max-width:360px}
  h1{color:#244A80;font-size:18px;margin:0 0 8px}
  p{color:#888;font-size:14px;margin:0 0 24px}
  input{width:100%;box-sizing:border-box;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:16px}
  button{width:100%;padding:11px;background:#244A80;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}
  .err{color:#c0392b;font-size:13px;margin-bottom:12px}
</style></head><body>
<div class="card">
  <h1>Angel Hub</h1>
  <p class="err">Contraseña incorrecta. Inténtalo de nuevo.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="state" value="${he(state)}">
    <input type="hidden" name="redirect_uri" value="${he(redirect_uri)}">
    <input type="hidden" name="code_challenge" value="${he(code_challenge)}">
    <input type="hidden" name="client_id" value="${he(client_id)}">
    <input type="password" name="password" placeholder="Contraseña" autofocus required>
    <button type="submit">Conectar</button>
  </form>
</div></body></html>`);
        return;
      }

      const code = b64url(crypto.randomBytes(32));
      authCodes.set(code, {
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        expiresAt: Date.now() + 600_000
      });

      try {
        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set('code', code);
        if (state) redirectUrl.searchParams.set('state', state);
        oLog('authorize_redirect', { to: redirectUrl.toString().slice(0, 80) });
        res.writeHead(302, { Location: redirectUrl.toString() });
        res.end();
      } catch (e) {
        oLog('authorize_redirect_error', { error: e.message, redirect_uri });
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid redirect_uri: ' + e.message);
      }
      return;
    }
  }

  // OAuth token exchange
  if (url.pathname === '/token' && req.method === 'POST') {
    const rawBody = await parseBody(req);
    const ct = req.headers['content-type'] || '';
    const body = ct.includes('application/json') ? JSON.parse(rawBody || '{}') : parseForm(rawBody);
    const { code, redirect_uri, code_verifier, grant_type } = body;

    if (grant_type !== 'authorization_code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    const stored = authCodes.get(code);
    oLog('token_exchange', { codeFound: !!stored, grant_type, hasVerifier: !!code_verifier, bodyKeys: Object.keys(body) });

    if (!stored || stored.expiresAt < Date.now()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }

    authCodes.delete(code);
    const accessToken = b64url(crypto.randomBytes(48));
    accessTokens.add(accessToken);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 86400
    }));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, v: 'v9-write' }));
    return;
  }

  if (url.pathname === '/debug-network') {
    const results = { dns: {}, network: {}, route: '', hosts: '', httpTests: {} };

    // DNS tests
    const uuid = 'qntkevw8v9gecebegs13zpgi';
    const dnsHosts = [
      `${uuid}-supabase-kong`, `${uuid}-supabase-rest`,
      'supabase-kong', 'supabase-rest', 'kong', 'rest', 'host.docker.internal'
    ];
    for (const h of dnsHosts) {
      try { results.dns[h] = await dns.lookup(h); }
      catch (e) { results.dns[h] = e.message; }
    }

    // Network interfaces
    results.network = os.networkInterfaces();

    // Route table
    try { results.route = execSync('ip route 2>/dev/null || route -n 2>/dev/null', { encoding: 'utf8', timeout: 2000 }); }
    catch (e) { results.route = e.message; }

    // /etc/hosts
    try { results.hosts = execSync('cat /etc/hosts', { encoding: 'utf8', timeout: 2000 }); }
    catch (e) { results.hosts = e.message; }

    // Use raw TCP socket — timeout fires even during SYN phase
    const testTCP = (ip, port) => new Promise((resolve) => {
      const sock = new net.Socket();
      let done = false;
      const finish = (r) => { if (!done) { done = true; sock.destroy(); resolve(r); } };
      sock.setTimeout(1500);
      sock.connect(port, ip, () => finish('OPEN'));
      sock.on('timeout', () => finish('TIMEOUT'));
      sock.on('error', (e) => finish(e.code || e.message));
    });

    // Scan IPs 1-20 for ports 80 and 443 in parallel
    const scan = [];
    for (let i = 1; i <= 20; i++) {
      const ip = `10.0.1.${i}`;
      scan.push(testTCP(ip, 80).then(r => [`${ip}:80`, r]));
      scan.push(testTCP(ip, 443).then(r => [`${ip}:443`, r]));
    }
    const scanRes = await Promise.all(scan);
    for (const [key, r] of scanRes) if (r !== 'ECONNREFUSED') results.httpTests[key] = r;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results, null, 2));
    return;
  }

  if (url.pathname === '/debug-tables') {
    try {
      const r = await supabaseGet('');
      // Root returns OpenAPI spec — extract table names from definitions or paths
      const spec = r.body;
      const tables = spec && spec.definitions
        ? Object.keys(spec.definitions)
        : spec && spec.paths
          ? Object.keys(spec.paths).map(p => p.replace(/^\//,''))
          : spec;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tables }, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/mcp') {
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Angel Hub", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Read full request body
    const readBody = () => parseBody(req);

    const TOOLS = [
      {
        name: 'get_weekly_boards',
        description: 'Get cards from weekly and weekly_ops boards, grouped by column/team.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'get_roadmap',
        description: 'Get tasks from angel_encinar_roadmap_tasks and teams from angel_encinar_roadmap_teams. Optional team filter.',
        inputSchema: { type: 'object', properties: { team: { type: 'string', description: 'Optional team name filter' } }, required: [] }
      },
      {
        name: 'get_notes',
        description: 'Get all notes from angel_encinar_notes, with optional search term.',
        inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Optional search term' } }, required: [] }
      },
      {
        name: 'get_kpis',
        description: 'Get data from angel_encinar_dashboard_kpi.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'get_bookmarks',
        description: 'Get bookmarks and folders from angel_encinar_fav_bookmarks and angel_encinar_fav_folders.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'get_card_comments',
        description: 'Get comments from angel_encinar_card_comments, with optional card_id filter.',
        inputSchema: { type: 'object', properties: { card_id: { type: 'number', description: 'Optional card ID to filter comments' } }, required: [] }
      },
      {
        name: 'get_strategy_boards',
        description: 'Get cards from strategy, strategy_ops and strategy_dir boards, grouped by column.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'create_card',
        description: 'Create a card in a weekly or strategy board column. The column must already exist on that board (use get_weekly_boards / get_strategy_boards to see column names).',
        inputSchema: {
          type: 'object',
          properties: {
            board: { type: 'string', enum: WRITABLE_BOARDS },
            column: { type: 'string', description: 'Exact column name on that board' },
            text: { type: 'string', description: 'Card title' },
            description: { type: 'string' },
            status: { type: 'string', enum: CARD_STATUSES, description: 'normal (default), yellow, pink or green' },
            start_date: { type: 'string', description: 'YYYY-MM-DD' },
            end_date: { type: 'string', description: 'YYYY-MM-DD' }
          },
          required: ['board', 'column', 'text']
        }
      },
      {
        name: 'update_card',
        description: 'Update fields of an existing weekly or strategy card. Only the fields provided are changed. Use move_card to change column.',
        inputSchema: {
          type: 'object',
          properties: {
            card_id: { type: 'number' },
            text: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: CARD_STATUSES },
            start_date: { type: 'string', description: 'YYYY-MM-DD' },
            end_date: { type: 'string', description: 'YYYY-MM-DD' }
          },
          required: ['card_id']
        }
      },
      {
        name: 'move_card',
        description: 'Move a weekly or strategy card to another column of the same board. Placed at the end of the column unless position is given.',
        inputSchema: {
          type: 'object',
          properties: {
            card_id: { type: 'number' },
            column: { type: 'string', description: 'Exact target column name on the card board' },
            position: { type: 'number' }
          },
          required: ['card_id', 'column']
        }
      },
      {
        name: 'create_roadmap_task',
        description: 'Create a roadmap task. The timeline uses half-month slots: slot 1 = 1-15 Apr 2026, slot 2 = 16-30 Apr 2026, ... slot 42 = 16-31 Dec 2027. Team must exist in that roadmap (see get_roadmap).',
        inputSchema: {
          type: 'object',
          properties: {
            roadmap: { type: 'string', enum: ROADMAPS, description: 'edtech (default) or ops' },
            team: { type: 'string', description: 'Exact team name' },
            category: { type: 'string', enum: ROADMAP_CATEGORIES },
            name: { type: 'string' },
            start_slot: { type: 'number', description: `1-${ROADMAP_SLOTS}` },
            end_slot: { type: 'number', description: `start_slot-${ROADMAP_SLOTS}` },
            status: { type: 'string', enum: ROADMAP_STATUSES, description: 'pendiente (default), proceso or done' },
            description: { type: 'string' },
            color: { type: 'string', description: 'Hex color. Defaults to the team color' }
          },
          required: ['team', 'category', 'name', 'start_slot', 'end_slot']
        }
      },
      {
        name: 'update_roadmap_task',
        description: 'Update fields of an existing roadmap task. Only the fields provided are changed. Slots: 1 = 1-15 Apr 2026 ... 42 = 16-31 Dec 2027.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'number' },
            team: { type: 'string' },
            category: { type: 'string', enum: ROADMAP_CATEGORIES },
            name: { type: 'string' },
            start_slot: { type: 'number' },
            end_slot: { type: 'number' },
            status: { type: 'string', enum: ROADMAP_STATUSES },
            description: { type: 'string' },
            color: { type: 'string' }
          },
          required: ['task_id']
        }
      },
      {
        name: 'create_note',
        description: 'Create a note.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string', description: 'Note content (HTML allowed, as in the app editor)' },
            tag: { type: 'string', enum: NOTE_TAGS, description: 'Defaults to Idea' }
          },
          required: ['title']
        }
      },
      {
        name: 'update_note',
        description: 'Update an existing note. Only the fields provided are changed.',
        inputSchema: {
          type: 'object',
          properties: {
            note_id: { type: 'number' },
            title: { type: 'string' },
            body: { type: 'string' },
            tag: { type: 'string', enum: NOTE_TAGS }
          },
          required: ['note_id']
        }
      }
    ];

    async function getBoardsGrouped(boards) {
      const list = boards.join(',');
      const [colRes, cardsRes] = await Promise.all([
        supabaseGet(`angel_encinar_board_columns?board=in.(${list})&order=board,position`),
        supabaseGet(`angel_encinar_board_cards?board=in.(${list})&order=board,status,position`)
      ]);
      const columns = colRes.body || [];
      const cards = cardsRes.body || [];
      const colPos = {};
      for (const col of columns) colPos[`${col.board}/${col.name}`] = col.position;
      const boardData = {};
      for (const b of boards) boardData[b] = {};
      // Include empty columns so the client knows valid targets for create/move
      for (const col of columns) if (boardData[col.board]) boardData[col.board][col.name] = [];
      for (const card of cards) {
        if (!boardData[card.board]) continue;
        const colName = card.column_id || 'Sin columna';
        if (!boardData[card.board][colName]) boardData[card.board][colName] = [];
        boardData[card.board][colName].push(card);
      }
      const result = {};
      for (const boardKey of boards) {
        const sortedNames = Object.keys(boardData[boardKey]).sort((a, b) =>
          (colPos[`${boardKey}/${a}`] ?? 999) - (colPos[`${boardKey}/${b}`] ?? 999));
        result[boardKey] = {};
        for (const name of sortedNames) result[boardKey][name] = boardData[boardKey][name];
      }
      return result;
    }

    function pick(args, fields) {
      const out = {};
      for (const f of fields) if (args[f] !== undefined) out[f] = args[f];
      return out;
    }

    function assertEnum(value, allowed, field) {
      if (value !== undefined && !allowed.includes(value)) {
        throw new Error(`Invalid ${field} "${value}". Allowed: ${allowed.join(', ')}`);
      }
    }

    function assertSlots(cs, ce) {
      for (const v of [cs, ce]) {
        if (!Number.isInteger(v) || v < 1 || v > ROADMAP_SLOTS) throw new Error(`Slots must be integers between 1 and ${ROADMAP_SLOTS}`);
      }
      if (cs > ce) throw new Error('start_slot must be <= end_slot');
    }

    async function getOne(table, id) {
      const r = await supabaseGet(`${table}?id=eq.${encodeURIComponent(id)}`);
      const row = Array.isArray(r.body) ? r.body[0] : null;
      if (!row) throw new Error(`${table} id ${id} not found`);
      return row;
    }

    async function assertColumn(board, column) {
      const r = await supabaseGet(`angel_encinar_board_columns?board=eq.${encodeURIComponent(board)}&name=eq.${encodeURIComponent(column)}`);
      if (!Array.isArray(r.body) || r.body.length === 0) throw new Error(`Column "${column}" does not exist on board ${board}`);
    }

    async function nextCardPosition(board, column) {
      const r = await supabaseGet(`angel_encinar_board_cards?board=eq.${encodeURIComponent(board)}&column_id=eq.${encodeURIComponent(column)}&select=position&order=position.desc&limit=1`);
      const top = Array.isArray(r.body) && r.body[0] ? r.body[0].position || 0 : -1;
      return top + 1;
    }

    async function getTeam(roadmap, team) {
      const r = await supabaseGet(`angel_encinar_roadmap_teams?roadmap=eq.${encodeURIComponent(roadmap)}&name=eq.${encodeURIComponent(team)}`);
      const row = Array.isArray(r.body) ? r.body[0] : null;
      if (!row) throw new Error(`Team "${team}" does not exist in roadmap ${roadmap}`);
      return row;
    }

    async function getWritableCard(cardId) {
      const card = await getOne('angel_encinar_board_cards', cardId);
      if (!WRITABLE_BOARDS.includes(card.board)) throw new Error(`Card ${cardId} belongs to board ${card.board}, which is not writable`);
      return card;
    }

    async function callTool(name, args) {
      args = args || {};
      if (name === 'get_weekly_boards') {
        return getBoardsGrouped(['weekly', 'weekly_ops']);
      }
      if (name === 'get_strategy_boards') {
        return getBoardsGrouped(['strategy', 'strategy_ops', 'strategy_dir']);
      }
      if (name === 'create_card') {
        assertEnum(args.board, WRITABLE_BOARDS, 'board');
        assertEnum(args.status, CARD_STATUSES, 'status');
        if (!args.text) throw new Error('text is required');
        await assertColumn(args.board, args.column);
        const row = {
          board: args.board,
          column_id: args.column,
          ...pick(args, ['text', 'description', 'status', 'start_date', 'end_date']),
          position: await nextCardPosition(args.board, args.column)
        };
        return supabaseWrite('POST', 'angel_encinar_board_cards', row);
      }
      if (name === 'update_card') {
        assertEnum(args.status, CARD_STATUSES, 'status');
        await getWritableCard(args.card_id);
        const changes = pick(args, ['text', 'description', 'status', 'start_date', 'end_date']);
        if (Object.keys(changes).length === 0) throw new Error('No fields to update');
        return supabaseWrite('PATCH', `angel_encinar_board_cards?id=eq.${encodeURIComponent(args.card_id)}`,
          { ...changes, updated_at: new Date().toISOString() });
      }
      if (name === 'move_card') {
        const card = await getWritableCard(args.card_id);
        await assertColumn(card.board, args.column);
        const position = Number.isInteger(args.position) ? args.position : await nextCardPosition(card.board, args.column);
        return supabaseWrite('PATCH', `angel_encinar_board_cards?id=eq.${encodeURIComponent(args.card_id)}`,
          { column_id: args.column, position, updated_at: new Date().toISOString() });
      }
      if (name === 'create_roadmap_task') {
        const roadmap = args.roadmap || 'edtech';
        assertEnum(roadmap, ROADMAPS, 'roadmap');
        assertEnum(args.category, ROADMAP_CATEGORIES, 'category');
        assertEnum(args.status, ROADMAP_STATUSES, 'status');
        assertSlots(args.start_slot, args.end_slot);
        if (!args.name) throw new Error('name is required');
        const team = await getTeam(roadmap, args.team);
        return supabaseWrite('POST', 'angel_encinar_roadmap_tasks', {
          roadmap,
          team_id: team.name,
          cat_id: args.category,
          name: args.name,
          cs: args.start_slot,
          ce: args.end_slot,
          color: args.color || team.color,
          status: args.status || 'pendiente',
          description: args.description || ''
        });
      }
      if (name === 'update_roadmap_task') {
        assertEnum(args.category, ROADMAP_CATEGORIES, 'category');
        assertEnum(args.status, ROADMAP_STATUSES, 'status');
        const task = await getOne('angel_encinar_roadmap_tasks', args.task_id);
        const changes = pick(args, ['name', 'status', 'description', 'color']);
        if (args.team !== undefined) changes.team_id = (await getTeam(task.roadmap, args.team)).name;
        if (args.category !== undefined) changes.cat_id = args.category;
        if (args.start_slot !== undefined || args.end_slot !== undefined) {
          const cs = args.start_slot ?? task.cs;
          const ce = args.end_slot ?? task.ce;
          assertSlots(cs, ce);
          changes.cs = cs;
          changes.ce = ce;
        }
        if (Object.keys(changes).length === 0) throw new Error('No fields to update');
        return supabaseWrite('PATCH', `angel_encinar_roadmap_tasks?id=eq.${encodeURIComponent(args.task_id)}`,
          { ...changes, updated_at: new Date().toISOString() });
      }
      if (name === 'create_note') {
        assertEnum(args.tag, NOTE_TAGS, 'tag');
        if (!args.title) throw new Error('title is required');
        return supabaseWrite('POST', 'angel_encinar_notes', {
          title: args.title,
          body: args.body || '',
          tag: args.tag || 'Idea'
        });
      }
      if (name === 'update_note') {
        assertEnum(args.tag, NOTE_TAGS, 'tag');
        await getOne('angel_encinar_notes', args.note_id);
        const changes = pick(args, ['title', 'body', 'tag']);
        if (Object.keys(changes).length === 0) throw new Error('No fields to update');
        return supabaseWrite('PATCH', `angel_encinar_notes?id=eq.${encodeURIComponent(args.note_id)}`,
          { ...changes, updated_at: new Date().toISOString() });
      }
      if (name === 'get_roadmap') {
        const [tasksRes, teamsRes] = await Promise.all([
          supabaseGet('angel_encinar_roadmap_tasks?order=id'),
          supabaseGet('angel_encinar_roadmap_teams?order=id')
        ]);
        let tasks = tasksRes.body || [];
        if (args.team) {
          const t = String(args.team).toLowerCase();
          tasks = tasks.filter(x => {
            const fields = [x.team, x.team_name, x.team_id].filter(Boolean).map(v => String(v).toLowerCase());
            return fields.some(f => f.includes(t));
          });
        }
        return { tasks, teams: teamsRes.body || [] };
      }
      if (name === 'get_notes') {
        const r = await supabaseGet('angel_encinar_notes?order=id');
        let notes = r.body || [];
        if (args.search) {
          const s = String(args.search).toLowerCase();
          notes = notes.filter(n => JSON.stringify(n).toLowerCase().includes(s));
        }
        return notes;
      }
      if (name === 'get_kpis') {
        const r = await supabaseGet('angel_encinar_dashboard_kpi?order=id');
        return r.body || [];
      }
      if (name === 'get_bookmarks') {
        const [bRes, fRes] = await Promise.all([
          supabaseGet('angel_encinar_fav_bookmarks?order=id'),
          supabaseGet('angel_encinar_fav_folders?order=id')
        ]);
        return { bookmarks: bRes.body || [], folders: fRes.body || [] };
      }
      if (name === 'get_card_comments') {
        const path = args.card_id != null
          ? `angel_encinar_card_comments?card_id=eq.${encodeURIComponent(args.card_id)}&order=id`
          : 'angel_encinar_card_comments?order=id';
        const r = await supabaseGet(path);
        return r.body || [];
      }
      throw new Error(`Unknown tool: ${name}`);
    }

    async function handleMessage(msg) {
      const isNotification = !('id' in msg);
      const id = msg.id;
      try {
        let result;
        switch (msg.method) {
          case 'initialize':
            result = {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'angel-hub', version: '1.1.0' }
            };
            break;
          case 'notifications/initialized':
            return null;
          case 'tools/list':
            result = { tools: TOOLS };
            break;
          case 'tools/call': {
            const params = msg.params || {};
            const data = await callTool(params.name, params.arguments);
            result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
            break;
          }
          case 'ping':
            result = {};
            break;
          default:
            if (isNotification) return null;
            return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
        }
        if (isNotification) return null;
        return { jsonrpc: '2.0', id, result };
      } catch (err) {
        if (isNotification) return null;
        return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message } };
      }
    }

    try {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'angel-hub', version: '1.0.0', protocol: 'MCP', transport: 'streamable-http' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      const raw = await readBody();
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      if (Array.isArray(payload)) {
        const responses = [];
        for (const msg of payload) {
          const r = await handleMessage(msg);
          if (r) responses.push(r);
        }
        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responses));
        return;
      }

      const response = await handleMessage(payload);
      if (!response) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } }));
    }
    return;
  }

  if (url.pathname === '/debug-supabase') {
    try {
      const [colRes, cardsRes] = await Promise.all([
        supabaseGet('angel_encinar_board_columns?board=in.(weekly,weekly_ops)&order=board,position&limit=5'),
        supabaseGet('angel_encinar_board_cards?board=in.(weekly,weekly_ops)&order=board,position&limit=5')
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ columns: colRes.body, cards: cardsRes.body }, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method !== 'GET' || url.pathname !== '/send') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  const to = url.searchParams.get('to') || 'josemaria.berbel@educaedtech.com';
  const date = url.searchParams.get('date') || new Date().toLocaleDateString('es-ES');
  let calendarEvents = [];
  try {
    const eventsParam = url.searchParams.get('events');
    if (eventsParam) calendarEvents = JSON.parse(decodeURIComponent(eventsParam));
  } catch (e) {}

  try {
    const [colRes, cardsRes] = await Promise.all([
      supabaseGet('angel_encinar_board_columns?board=in.(weekly,weekly_ops)&order=board,position'),
      supabaseGet('angel_encinar_board_cards?board=in.(weekly,weekly_ops)&order=board,status,position')
    ]);

    const html = buildHtml(date, calendarEvents, colRes.body, cardsRes.body);

    const emailPayload = JSON.stringify({
      from: 'Informe Angel Hub <noreply@mail.operaciones.educaedtech.tools>',
      to: [to],
      subject: `Informe diario Angel Hub — ${date}`,
      html
    });

    const resendRes = await fetchJson('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(emailPayload)
      },
      body: emailPayload
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, resend: resendRes.body, to, date }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, () => console.log(`angel-hub-api running on port ${PORT}`));
