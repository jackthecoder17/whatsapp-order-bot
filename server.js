// HTTP server: serves the demo page and owner dashboard, their APIs,
// and the WhatsApp Cloud API webhook. No npm packages needed (Node 18+).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bot = require('./bot');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const WA_TOKEN = process.env.WHATSAPP_TOKEN; // Meta access token
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // from Meta dashboard
const WA_VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || 'my-verify-token';
const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP; // e.g. 2348012345678 — gets new-order alerts
const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD; // unset = no login (local demo only)

if (WA_TOKEN && !DASH_PASSWORD) {
  console.error('❌ Set DASHBOARD_PASSWORD before connecting a real WhatsApp number — otherwise anyone could open your dashboard.');
  process.exit(1);
}

// ---- Conversations -----------------------------------------------------
// Every message in and out is logged per phone number. The simulator and
// the dashboard's Chats tab both read from here.
const conversations = new Map(); // phone -> [{ id, from: 'customer'|'bot'|'owner', text, ts }]
const humanRequests = new Map(); // phone -> timestamp
let msgSeq = 0;

function log(phone, from, text) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  const list = conversations.get(phone);
  list.push({ id: ++msgSeq, from, text, ts: Date.now() });
  if (list.length > 300) list.splice(0, list.length - 300);
}

async function send(phone, text, from = 'bot') {
  if (!text) return;
  log(phone, from, text);
  if (phone.startsWith('sim-')) return; // simulator reads the log directly
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.log(`[no WhatsApp credentials] → ${phone}: ${text}`);
    return;
  }
  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } }),
  });
  if (!res.ok) console.error('WhatsApp send failed:', res.status, await res.text());
}

async function receive(phone, text) {
  log(phone, 'customer', text);
  const replies = await bot.handle(phone, text);
  for (const r of replies) await send(phone, r);
}

// ---- Owner alerts ------------------------------------------------------
bot.events.on('order', (o) => {
  console.log(`🆕 New order ${o.id} — ₦${o.total} from ${o.name}`);
  if (OWNER_WHATSAPP) {
    const items = o.items.map((i) => `${i.qty} × ${i.name}`).join('\n');
    send(OWNER_WHATSAPP, `🆕 New order *${o.id}*\n${items}\nTotal: ₦${o.total.toLocaleString('en-NG')}\n${o.name} · ${o.mode}${o.address ? ' · ' + o.address : ''}`);
  }
});

bot.events.on('human', (phone) => {
  humanRequests.set(phone, Date.now());
  if (OWNER_WHATSAPP) send(OWNER_WHATSAPP, `🙋🏾 Customer ${phone} wants to talk to a person. Reply from the dashboard's Chats tab.`);
});

// ---- Dashboard login ---------------------------------------------------
const tokens = new Set();

function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function authed(req) {
  if (!DASH_PASSWORD) return true;
  const t = cookie(req, 'dash');
  return !!t && tokens.has(t);
}

function passwordOk(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(DASH_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---- HTTP helpers ------------------------------------------------------
function json(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function page(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
}

function dashboardData() {
  const chats = [...conversations.entries()]
    .map(([phone, msgs]) => {
      const last = msgs[msgs.length - 1];
      const order = store.latestFor(phone);
      return { phone, name: order?.name || null, last, needsHuman: humanRequests.has(phone) };
    })
    .sort((a, b) => b.needsHuman - a.needsHuman || b.last.ts - a.last.ts);
  return {
    businessName: bot.config.businessName,
    statuses: bot.STATUS_LABELS,
    orders: store.all(),
    chats,
    menu: bot.config.menu.map((i) => ({ ...i, available: i.available !== false })),
  };
}

// ---- Routes ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const is = (method, route) => req.method === method && p === route;

  try {
    if (is('GET', '/') || is('GET', '/index.html')) return page(res, 'index.html');
    if (is('GET', '/dashboard')) return page(res, 'dashboard.html');
    if (is('GET', '/healthz')) return json(res, 200, { ok: true });
    // Public privacy policy — Meta requires a URL for it before the app can be published.
    if (is('GET', '/privacy')) return page(res, 'privacy.html');
    if (is('GET', '/api/business')) {
      return json(res, 200, { businessName: bot.config.businessName, contactEmail: bot.config.contactEmail || null });
    }

    // Login
    if (is('POST', '/api/login')) {
      const { password } = await readBody(req);
      if (!DASH_PASSWORD) return json(res, 200, { ok: true });
      if (!passwordOk(password)) return json(res, 401, { error: 'Wrong password' });
      const t = crypto.randomBytes(24).toString('hex');
      tokens.add(t);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `dash=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
    }
    if (is('POST', '/api/logout')) {
      tokens.delete(cookie(req, 'dash'));
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'dash=; Path=/; Max-Age=0' });
    }

    // WhatsApp Cloud API webhook — verification handshake
    if (is('GET', '/webhook')) {
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === WA_VERIFY) {
        res.writeHead(200);
        return res.end(url.searchParams.get('hub.challenge'));
      }
      res.writeHead(403);
      return res.end();
    }
    // WhatsApp Cloud API webhook — incoming messages
    if (is('POST', '/webhook')) {
      const body = await readBody(req);
      json(res, 200, { ok: true }); // acknowledge fast so Meta doesn't retry
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          for (const msg of change.value?.messages || []) {
            const text = msg.text?.body ?? msg.button?.text ?? msg.interactive?.button_reply?.title;
            console.log(`📩 ${msg.from}: ${text ?? `[${msg.type}]`}`);
            if (text) await receive(msg.from, text);
            else await send(msg.from, 'Please reply with text 🙏 (e.g. *menu*)');
          }
        }
      }
      return;
    }

    // Everything below needs the dashboard password (when one is set).
    if (p.startsWith('/api/') && !authed(req)) return json(res, 401, { error: 'login required' });

    if (is('GET', '/api/me')) return json(res, 200, { ok: true, businessName: bot.config.businessName });
    if (is('GET', '/api/dashboard')) return json(res, 200, dashboardData());

    // Simulator
    if (is('POST', '/api/sim/send')) {
      const { phone, text } = await readBody(req);
      if (!phone?.startsWith('sim-') || !text) return json(res, 400, { error: 'phone (sim-*) and text required' });
      await receive(phone, String(text).slice(0, 1000));
      return json(res, 200, { ok: true });
    }
    if (is('GET', '/api/sim/messages')) {
      const phone = url.searchParams.get('phone');
      const after = Number(url.searchParams.get('after') || 0);
      return json(res, 200, (conversations.get(phone) || []).filter((m) => m.id > after));
    }
    if (is('POST', '/api/sim/reset')) {
      const { phone } = await readBody(req);
      bot.reset(phone);
      conversations.delete(phone);
      humanRequests.delete(phone);
      return json(res, 200, { ok: true });
    }

    // Orders
    let m = p.match(/^\/api\/orders\/([A-Z0-9]+)\/status$/);
    if (req.method === 'POST' && m) {
      const { status } = await readBody(req);
      if (!bot.STATUS_LABELS[status]) return json(res, 400, { error: 'bad status' });
      const order = store.setStatus(m[1], status);
      if (!order) return json(res, 404, { error: 'not found' });
      await send(order.phone, bot.statusMessage(order));
      return json(res, 200, order);
    }

    // Chats
    m = p.match(/^\/api\/chats\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const phone = decodeURIComponent(m[1]);
      return json(res, 200, { phone, messages: conversations.get(phone) || [], needsHuman: humanRequests.has(phone) });
    }
    m = p.match(/^\/api\/chats\/([^/]+)\/reply$/);
    if (req.method === 'POST' && m) {
      const phone = decodeURIComponent(m[1]);
      const { text } = await readBody(req);
      if (!text?.trim()) return json(res, 400, { error: 'text required' });
      await send(phone, String(text).slice(0, 2000), 'owner');
      return json(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/chats\/([^/]+)\/release$/);
    if (req.method === 'POST' && m) {
      const phone = decodeURIComponent(m[1]);
      humanRequests.delete(phone);
      bot.releaseHuman(phone);
      await send(phone, '🤖 Thanks for chatting with us! Reply *menu* anytime to order.');
      return json(res, 200, { ok: true });
    }

    // Menu
    if (is('POST', '/api/menu')) {
      const { name, price } = await readBody(req);
      if (!String(name || '').trim() || !(Number(price) > 0)) return json(res, 400, { error: 'name and price required' });
      bot.config.menu.push({ name: String(name).trim().slice(0, 80), price: Math.round(Number(price)), available: true });
      bot.saveConfig();
      return json(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/menu\/(\d+)$/);
    if (m && (req.method === 'POST' || req.method === 'DELETE')) {
      const item = bot.config.menu[Number(m[1])];
      if (!item) return json(res, 404, { error: 'not found' });
      if (req.method === 'DELETE') {
        bot.config.menu.splice(Number(m[1]), 1);
      } else {
        const { available, price } = await readBody(req);
        if (typeof available === 'boolean') item.available = available;
        if (price !== undefined) {
          if (!(Number(price) > 0)) return json(res, 400, { error: 'bad price' });
          item.price = Math.round(Number(price));
        }
      }
      bot.saveConfig();
      return json(res, 200, { ok: true });
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

server.listen(PORT, () => {
  const lan = lanAddress();
  console.log(`🍲 ${bot.config.businessName} bot running`);
  console.log(`   Demo (phone + dashboard): http://localhost:${PORT}`);
  console.log(`   Owner dashboard:          http://localhost:${PORT}/dashboard`);
  if (lan) console.log(`   On your phone (same Wi-Fi): http://${lan}:${PORT}/dashboard`);
  console.log(WA_TOKEN ? '✅ WhatsApp Cloud API connected' : 'ℹ️  Demo mode (no WhatsApp credentials set)');
  if (!DASH_PASSWORD) console.log('⚠️  No DASHBOARD_PASSWORD set — dashboard is open to anyone on this network.');
});
