// The conversation engine. It doesn't know about WhatsApp or the simulator —
// it takes (phone, text) and returns the replies to send back.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const store = require('./store');

// In production the menu lives on the persistent disk so dashboard edits survive
// redeploys. The first boot copies the config.json from the repo there.
const CONFIG_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'config.json') : path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_FILE)) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'config.json'), CONFIG_FILE);
}
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

// Items the owner has marked sold out are hidden from customers.
const availableMenu = () => config.menu.filter((i) => i.available !== false);
const events = new EventEmitter();
const sessions = new Map();

const STATUS_LABELS = {
  pending_payment: '⏳ Awaiting payment',
  paid: '✅ Payment confirmed',
  preparing: '👩🏾‍🍳 Being prepared',
  out_for_delivery: '🛵 Out for delivery',
  ready_for_pickup: '🛍️ Ready for pickup',
  delivered: '🎉 Delivered',
  cancelled: '❌ Cancelled',
};

const STATUS_MESSAGES = {
  paid: (o) => `✅ Payment received for order *${o.id}*. Thank you! We're starting on your food now.`,
  preparing: (o) => `👩🏾‍🍳 Your order *${o.id}* is being prepared.`,
  out_for_delivery: (o) => `🛵 Your order *${o.id}* is on its way to:\n${o.address}`,
  ready_for_pickup: (o) => `🛍️ Your order *${o.id}* is ready for pickup at:\n${config.location}`,
  delivered: (o) => `🎉 Order *${o.id}* delivered. Enjoy your meal! Reply *menu* to order again.`,
  cancelled: (o) => `❌ Order *${o.id}* has been cancelled. Reply *5* if you'd like to talk to us.`,
};

const naira = (n) => config.currency + Number(n).toLocaleString('en-NG');

function session(phone) {
  if (!sessions.has(phone)) sessions.set(phone, { state: 'NEW', cart: [], draft: {} });
  return sessions.get(phone);
}

function reset(phone) {
  sessions.delete(phone);
}

const subtotal = (cart) => cart.reduce((sum, i) => sum + i.price * i.qty, 0);

function mainMenu() {
  return (
    `👋 Welcome to *${config.businessName}*!\n\n` +
    `Reply with a number:\n` +
    `1️⃣ Order food\n` +
    `2️⃣ View my cart\n` +
    `3️⃣ Opening hours & location\n` +
    `4️⃣ Track my order\n` +
    `5️⃣ Talk to a person`
  );
}

function menuText() {
  const menu = availableMenu();
  if (!menu.length) return "😔 Sorry, everything is sold out right now. Please check back later!\n\n*0* = main menu";
  const items = menu.map((it, i) => `*${i + 1}.* ${it.name} — ${naira(it.price)}`).join('\n');
  return `🍽️ *Our Menu*\n\n${items}\n\nReply with an item number to add it to your cart.\n*C* = checkout · *0* = main menu`;
}

function cartText(cart) {
  if (!cart.length) return '🛒 Your cart is empty.';
  const lines = cart.map((i) => `• ${i.qty} × ${i.name} — ${naira(i.price * i.qty)}`).join('\n');
  return `🛒 *Your cart*\n\n${lines}\n\nSubtotal: *${naira(subtotal(cart))}*`;
}

function summary(s) {
  const fee = s.draft.mode === 'delivery' ? config.deliveryFee : 0;
  const total = subtotal(s.cart) + fee;
  const where = s.draft.mode === 'delivery' ? `🛵 Delivery to: ${s.draft.address}` : `🛍️ Pickup at: ${config.location}`;
  return (
    `📋 *Order summary*\n\n` +
    s.cart.map((i) => `• ${i.qty} × ${i.name} — ${naira(i.price * i.qty)}`).join('\n') +
    `\n\nSubtotal: ${naira(subtotal(s.cart))}` +
    (fee ? `\nDelivery: ${naira(fee)}` : '') +
    `\n*Total: ${naira(total)}*\n\n` +
    `👤 ${s.draft.name}\n${where}\n\n` +
    `1️⃣ Confirm order\n2️⃣ Cancel`
  );
}

function startCheckout(s) {
  if (!s.cart.length) {
    s.state = 'BROWSE';
    return ['🛒 Your cart is empty. Add something first 👇', menuText()];
  }
  s.state = 'NAME';
  return ['👤 What name should we put on this order?'];
}

async function placeOrder(phone, s) {
  const fee = s.draft.mode === 'delivery' ? config.deliveryFee : 0;
  const order = store.create({
    phone,
    name: s.draft.name,
    mode: s.draft.mode,
    address: s.draft.address || null,
    items: s.cart.map(({ name, price, qty }) => ({ name, price, qty })),
    subtotal: subtotal(s.cart),
    deliveryFee: fee,
    total: subtotal(s.cart) + fee,
  });

  s.cart = [];
  s.draft = {};
  s.state = 'MAIN';
  events.emit('order', order);

  let pay =
    `🎉 Order *${order.id}* received!\n\n` +
    `💳 Please pay *${naira(order.total)}* to:\n` +
    `${config.bank.name}\n${config.bank.accountNumber}\n${config.bank.accountName}\n\n` +
    `Use *${order.id}* as the transfer description.`;

  const link = await paymentLink(order);
  if (link) pay += `\n\nOr pay online with card/transfer:\n${link}`;

  return [pay, `We'll message you here once payment is confirmed. Reply *4* anytime to track your order.`];
}

// Optional: creates a real Paystack checkout link when PAYSTACK_SECRET_KEY is set.
async function paymentLink(order) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.PAYSTACK_FALLBACK_EMAIL || 'orders@example.com',
        amount: order.total * 100, // kobo
        reference: `${order.id}-${Date.now()}`,
        metadata: { orderId: order.id },
      }),
    });
    const json = await res.json();
    return json?.data?.authorization_url || null;
  } catch (err) {
    console.error('Paystack error:', err.message);
    return null;
  }
}

function trackText(phone) {
  const o = store.latestFor(phone);
  if (!o) return "You don't have any orders yet. Reply *1* to order.";
  return `📦 Order *${o.id}* — ${naira(o.total)}\nStatus: *${STATUS_LABELS[o.status] || o.status}*`;
}

async function handle(phone, rawText) {
  const text = (rawText || '').trim();
  const cmd = text.toLowerCase();
  const s = session(phone);

  // While a person is handling the chat, the bot stays quiet.
  if (s.state === 'HUMAN') {
    if (cmd === 'menu') {
      s.state = 'MAIN';
      return [mainMenu()];
    }
    return [];
  }

  if (s.state === 'NEW' || ['hi', 'hello', 'hey', 'menu', 'start', '0'].includes(cmd)) {
    s.state = 'MAIN';
    return [mainMenu()];
  }
  if (cmd === 'cancel') {
    s.cart = [];
    s.draft = {};
    s.state = 'MAIN';
    return ['🗑️ Cancelled and cart cleared.', mainMenu()];
  }

  switch (s.state) {
    case 'MAIN':
      if (cmd === '1') {
        s.state = 'BROWSE';
        return [menuText()];
      }
      if (cmd === '2') {
        s.state = 'CART';
        return [cartText(s.cart) + (s.cart.length ? '\n\n*C* = checkout · *1* = add more · *X* = clear cart' : '\n\nReply *1* to see the menu.')];
      }
      if (cmd === '3') return [`🕘 *Opening hours*\n${config.hours}\n\n📍 *Location*\n${config.location}`];
      if (cmd === '4') return [trackText(phone)];
      if (cmd === '5') {
        s.state = 'HUMAN';
        events.emit('human', phone);
        return ["🙋🏾 No problem! Someone from our team will reply you here shortly.\n\n(Reply *menu* to go back to the bot.)"];
      }
      return ["Sorry, I didn't get that 🙏", mainMenu()];

    case 'BROWSE': {
      if (cmd === 'c') return startCheckout(s);
      const n = parseInt(cmd, 10);
      const item = availableMenu()[n - 1];
      if (!item || String(n) !== cmd) return ['Please reply with an item number from the menu, *C* to checkout or *0* for main menu.'];
      s.pending = { name: item.name, price: item.price };
      s.state = 'QTY';
      return [`How many *${item.name}*? (e.g. 2)`];
    }

    case 'QTY': {
      const q = parseInt(cmd, 10);
      if (!(q >= 1 && q <= 50) || String(q) !== cmd) return ['Please reply with a quantity between 1 and 50.'];
      if (config.menu.find((i) => i.name === s.pending.name)?.available === false) {
        s.pending = null;
        s.state = 'BROWSE';
        return ['😔 Sorry, that item just sold out.', menuText()];
      }
      const existing = s.cart.find((i) => i.name === s.pending.name);
      if (existing) existing.qty += q;
      else s.cart.push({ ...s.pending, qty: q });
      const added = s.pending;
      s.pending = null;
      s.state = 'BROWSE';
      return [
        `✅ Added ${q} × ${added.name}\nCart subtotal: *${naira(subtotal(s.cart))}*\n\n` +
          `Reply another item number to add more, *C* to checkout, or *0* for main menu.`,
      ];
    }

    case 'CART':
      if (cmd === 'c') return startCheckout(s);
      if (cmd === '1') {
        s.state = 'BROWSE';
        return [menuText()];
      }
      if (cmd === 'x') {
        s.cart = [];
        s.state = 'MAIN';
        return ['🗑️ Cart cleared.', mainMenu()];
      }
      return ['*C* = checkout · *1* = add more · *X* = clear cart · *0* = main menu'];

    case 'NAME':
      if (text.length < 2) return ['Please enter your name.'];
      s.draft.name = text;
      s.state = 'MODE';
      return [`Thanks, ${text}! How would you like to get your order?\n\n1️⃣ Delivery (+${naira(config.deliveryFee)})\n2️⃣ Pickup`];

    case 'MODE':
      if (cmd === '1') {
        s.draft.mode = 'delivery';
        s.state = 'ADDRESS';
        return ['📍 Please send your full delivery address (with a landmark).'];
      }
      if (cmd === '2') {
        s.draft.mode = 'pickup';
        s.state = 'CONFIRM';
        return [summary(s)];
      }
      return ['Reply *1* for Delivery or *2* for Pickup.'];

    case 'ADDRESS':
      if (text.length < 5) return ['Please send a fuller address so our rider can find you.'];
      s.draft.address = text;
      s.state = 'CONFIRM';
      return [summary(s)];

    case 'CONFIRM':
      if (cmd === '1') return placeOrder(phone, s);
      if (cmd === '2') {
        s.draft = {};
        s.state = 'MAIN';
        return ['Order not placed. Your cart is still saved 🛒', mainMenu()];
      }
      return ['Reply *1* to confirm or *2* to cancel.'];
  }

  s.state = 'MAIN';
  return [mainMenu()];
}

// Called when the owner changes an order's status from the dashboard.
function statusMessage(order) {
  const fn = STATUS_MESSAGES[order.status];
  return fn ? fn(order) : null;
}

// Owner finished chatting with a customer — give the chat back to the bot.
function releaseHuman(phone) {
  const s = session(phone);
  s.state = 'MAIN';
}

module.exports = { handle, reset, releaseHuman, events, statusMessage, config, saveConfig, STATUS_LABELS };
