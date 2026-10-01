// Simple JSON-file order storage. Swap for a real database (or Google Sheets) later.
const fs = require('fs');
const path = require('path');

// DATA_DIR points at a persistent disk in production (see render.yaml).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'orders.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

let orders = load();

function save() {
  fs.writeFileSync(FILE, JSON.stringify(orders, null, 2));
}

function nextId() {
  const max = orders.reduce((m, o) => Math.max(m, parseInt(o.id.slice(2), 10) || 0), 1000);
  return 'MT' + (max + 1);
}

function create(order) {
  const full = { id: nextId(), status: 'pending_payment', createdAt: new Date().toISOString(), ...order };
  orders.push(full);
  save();
  return full;
}

function all() {
  return [...orders].reverse();
}

function get(id) {
  return orders.find((o) => o.id === id);
}

function latestFor(phone) {
  return [...orders].reverse().find((o) => o.phone === phone);
}

function setStatus(id, status) {
  const o = get(id);
  if (!o) return null;
  o.status = status;
  o.updatedAt = new Date().toISOString();
  save();
  return o;
}

module.exports = { create, all, get, latestFor, setStatus };
