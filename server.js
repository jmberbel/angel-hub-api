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

// OAuth state (in-memory)
const authCodes = new Map();   // code -> { redirectUri, codeChallenge, expiresAt }
const accessTokens = new Set();

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

function supabaseGet(path) {
  const fullUrl = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };
  // If using internal IP, override Host + SNI so Traefik routes correctly
  if (SUPABASE_HOST) {
    headers['Host'] = SUPABASE_HOST;
    const urlObj = new URL(fullUrl);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
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
      req.end();
    });
  }
  return fetchJson(fullUrl, { method: 'GET', headers });
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
  img{display:block;margin:0 auto 24px;height:36px}
  h1{color:#244A80;font-size:18px;margin:0 0 8px}
  p{color:#888;font-size:14px;margin:0 0 24px}
  input{width:100%;box-sizing:border-box;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:16px}
  button{width:100%;padding:11px;background:#244A80;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}
  button:hover{background:#1a3460}
  .err{color:#c0392b;font-size:13px;margin-bottom:12px;display:none}
</style></head><body>
<div class="card">
  <h1>Angel Hub</h1>
  <p>Introduce tu contraseña de acceso para conectar con Claude.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="password" name="password" placeholder="Contraseña" autofocus required>
    <button type="submit">Conectar</button>
  </form>
</div></body></html>`);
      return;
    }

    if (req.method === 'POST') {
      const body = parseForm(await parseBody(req));
      const { password, redirect_uri, code_challenge, state, client_id } = body;

      if (!ANGEL_PASSWORD || password !== ANGEL_PASSWORD) {
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
    <input type="hidden" name="state" value="${state || ''}">
    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">
    <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
    <input type="hidden" name="client_id" value="${client_id || ''}">
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

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('code', code);
      if (state) redirectUrl.searchParams.set('state', state);
      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
      return;
    }
  }

  // OAuth token exchange
  if (url.pathname === '/token' && req.method === 'POST') {
    const body = parseForm(await parseBody(req));
    const { code, redirect_uri, code_verifier, grant_type } = body;

    if (grant_type !== 'authorization_code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt < Date.now()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }

    // Verify PKCE
    const challenge = b64url(crypto.createHash('sha256').update(code_verifier).digest());
    if (challenge !== stored.codeChallenge) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }

    authCodes.delete(code);
    const accessToken = b64url(crypto.randomBytes(48));
    accessTokens.add(accessToken);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 86400
    }));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, v: 'v7-mcp' }));
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
    if (ANGEL_HUB_TOKEN || ANGEL_PASSWORD) {
      const authHeader = req.headers['authorization'] || '';
      const incoming = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-api-key'] || '');
      const valid = (ANGEL_HUB_TOKEN && incoming === ANGEL_HUB_TOKEN) || accessTokens.has(incoming);
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
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
      }
    ];

    async function callTool(name, args) {
      args = args || {};
      if (name === 'get_weekly_boards') {
        const [colRes, cardsRes] = await Promise.all([
          supabaseGet('angel_encinar_board_columns?board=in.(weekly,weekly_ops)&order=board,position'),
          supabaseGet('angel_encinar_board_cards?board=in.(weekly,weekly_ops)&order=board,status,position')
        ]);
        const columns = colRes.body || [];
        const cards = cardsRes.body || [];
        const colByName = {};
        for (const col of columns) colByName[col.name] = col;
        const boardData = { weekly: {}, weekly_ops: {} };
        for (const card of cards) {
          const board = card.board;
          const colName = card.column_id || 'Sin columna';
          if (!boardData[board]) boardData[board] = {};
          if (!boardData[board][colName]) boardData[board][colName] = [];
          boardData[board][colName].push(card);
        }
        // Sort columns by position for each board
        const result = {};
        for (const boardKey of Object.keys(boardData)) {
          const sortedNames = Object.keys(boardData[boardKey]).sort((a, b) => {
            const posA = colByName[a]?.position ?? 999;
            const posB = colByName[b]?.position ?? 999;
            return posA - posB;
          });
          result[boardKey] = {};
          for (const name of sortedNames) result[boardKey][name] = boardData[boardKey][name];
        }
        return result;
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
              serverInfo: { name: 'angel-hub', version: '1.0.0' }
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
