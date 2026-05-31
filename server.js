const http = require('http');
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase.operaciones.educaedtech.tools';
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
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  return fetchJson(url, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
}

function buildHtml(date, calendarEvents, columns, cards) {
  const colMap = {};
  for (const col of columns) colMap[col.id] = col;

  const boardData = { weekly: {}, weekly_ops: {} };
  for (const card of cards) {
    const board = card.board;
    const colName = colMap[card.column_id]?.name || 'Sin columna';
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
    let html = '';
    for (const [colName, colCards] of Object.entries(boardCols)) {
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

  if (req.method !== 'GET' || url.pathname !== '/send') {
    res.writeHead(url.pathname === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: url.pathname === '/health' }));
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
