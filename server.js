const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const os = require('os');
const { execSync } = require('child_process');

// SUPABASE_URL: use internal Traefik IP to avoid hairpin NAT (e.g. https://10.0.1.6)
// SUPABASE_HOST: the public hostname for TLS SNI + Host header (supabase.operaciones.educaedtech.tools)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase.operaciones.educaedtech.tools';
const SUPABASE_HOST = process.env.SUPABASE_HOST || null;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_KEY = process.env.RESEND_KEY;
const PORT = process.env.PORT || 3000;

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
    const ANGEL_HUB_TOKEN = process.env.ANGEL_HUB_TOKEN;
    if (ANGEL_HUB_TOKEN) {
      const authHeader = req.headers['authorization'] || '';
      const incoming = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-api-key'] || '');
      if (incoming !== ANGEL_HUB_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Read full request body
    const readBody = () => new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

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
