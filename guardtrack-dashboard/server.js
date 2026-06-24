// GuardTrack backend - single-file Express server
// Tracks device heartbeats, exposes telemetry to the dashboard,
// and queues commands (kill ignition, unlock, enroll) for the device to fetch.
//
// Render deploy:
//   1. Push this folder to GitHub.
//   2. Render -> New -> Web Service -> connect the repo.
//   3. Build:   npm install
//   4. Start:   npm start
//   5. Add env var DEVICE_TOKEN = <a long random string>. The ESP32 sends
//      this in an X-Device-Auth header so randos can't push fake telemetry.
//
// All state is in memory. Restarting the service wipes it. For a final-year
// project that's fine. If you want persistence, replace `state` reads/writes
// with a tiny JSON file or SQLite later.

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT              = process.env.PORT || 3000;
const DEVICE_TOKEN      = process.env.DEVICE_TOKEN || 'change-me';
const HEARTBEAT_MS      = 30_000;   // device should POST every 30 s
const OFFLINE_AFTER_MS  = 90_000;   // 3 missed beats => offline

// Capacities — change in ONE place
const FINGERPRINT_CAPACITY = 5;     // max enrolled fingers
const RFID_CAPACITY        = 2;     // max enrolled RFID cards
const CONTACT_CAPACITY     = 2;     // max SMS alert numbers

// ---------- In-memory state ----------
const state = {
  lastSeenAt: null,                 // ms epoch of most recent telemetry POST
  device: {
    fwVersion: null,
    boardId:   null,
  },
  gps: {
    valid: false, lat: null, lon: null,
    altM: null, speedKn: null, utc: null,
  },
  gsm: {
    rssiDbm: null, network: null, registered: false,
  },
  fingerprint: { enrolled: 0, capacity: FINGERPRINT_CAPACITY, slots: [] }, // [{id,label,programmed,registeredAt}]
  rfid:        { enrolled: 0, capacity: RFID_CAPACITY, cards: [] },
  contacts:    { capacity: CONTACT_CAPACITY, numbers: [] }, // [{label, number}]
  immobilizer: { armed: true, reason: 'awaiting_auth' },
  events: [],                       // ring buffer of recent access events
};

const MAX_EVENTS = 40;
const pendingCommands = [];         // FIFO of unacked commands

// ---------- Helpers ----------
function isOnline() {
  return state.lastSeenAt != null && (Date.now() - state.lastSeenAt) < OFFLINE_AFTER_MS;
}

function pushEvent(ev) {
  state.events.unshift({ ...ev, ts: ev.ts || new Date().toISOString() });
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
}

function deviceAuth(req, res, next) {
  if (req.get('X-Device-Auth') !== DEVICE_TOKEN) {
    return res.status(401).json({ error: 'bad device token' });
  }
  next();
}

function newCmdId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(join(__dirname, 'public')));

// Health check (Render pings this)
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ----- Dashboard-facing API -----

// One-shot snapshot used by the dashboard's polling loop.
app.get('/api/state', (_req, res) => {
  res.json({
    online: isOnline(),
    lastSeenAt: state.lastSeenAt,
    secondsSinceSeen: state.lastSeenAt
      ? Math.floor((Date.now() - state.lastSeenAt) / 1000)
      : null,
    device:      state.device,
    gps:         state.gps,
    gsm:         state.gsm,
    fingerprint: state.fingerprint,
    rfid:        state.rfid,
    contacts:    state.contacts,
    immobilizer: state.immobilizer,
    events:      state.events,
    pendingCommands: pendingCommands.length,
  });
});

// --- Contact management (SMS alert numbers) ---
app.post('/api/contacts', (req, res) => {
  const { label = '', number } = req.body || {};
  if (typeof number !== 'string' || !/^\+?\d{6,16}$/.test(number)) {
    return res.status(400).json({ error: 'bad number; use E.164 like +5926...' });
  }
  if (state.contacts.numbers.length >= state.contacts.capacity) {
    return res.status(400).json({ error: `max ${state.contacts.capacity} contacts` });
  }
  if (state.contacts.numbers.some(c => c.number === number)) {
    return res.status(400).json({ error: 'already added' });
  }
  state.contacts.numbers.push({ label: String(label).slice(0, 20), number });
  pushEvent({ kind: 'contact_added', detail: number, granted: true });
  res.json({ ok: true, contacts: state.contacts });
});

app.delete('/api/contacts/:number', (req, res) => {
  const before = state.contacts.numbers.length;
  state.contacts.numbers = state.contacts.numbers.filter(c => c.number !== req.params.number);
  if (state.contacts.numbers.length === before) return res.status(404).json({ error: 'not found' });
  pushEvent({ kind: 'contact_removed', detail: req.params.number, granted: null });
  res.json({ ok: true, contacts: state.contacts });
});

// --- RFID card management ---
app.post('/api/rfid', (req, res) => {
  const { label = '', uid } = req.body || {};
  if (typeof uid !== 'string' || !/^[0-9A-Fa-f:]{4,}$/.test(uid)) {
    return res.status(400).json({ error: 'bad uid' });
  }
  if (state.rfid.cards.length >= state.rfid.capacity) {
    return res.status(400).json({ error: `max ${state.rfid.capacity} cards` });
  }
  if (state.rfid.cards.some(c => c.uid.toUpperCase() === uid.toUpperCase())) {
    return res.status(400).json({ error: 'already registered' });
  }
  state.rfid.cards.push({ label: String(label).slice(0, 20), uid: uid.toUpperCase() });
  state.rfid.enrolled = state.rfid.cards.length;
  pushEvent({ kind: 'rfid_added', detail: uid, granted: true });
  res.json({ ok: true, rfid: state.rfid });
});

app.delete('/api/rfid/:uid', (req, res) => {
  const target = req.params.uid.toUpperCase();
  const before = state.rfid.cards.length;
  state.rfid.cards = state.rfid.cards.filter(c => c.uid.toUpperCase() !== target);
  if (state.rfid.cards.length === before) return res.status(404).json({ error: 'not found' });
  state.rfid.enrolled = state.rfid.cards.length;
  pushEvent({ kind: 'rfid_removed', detail: req.params.uid, granted: null });
  res.json({ ok: true, rfid: state.rfid });
});

// --- Fingerprint slot management (reserves a slot/label; device confirms via telemetry) ---
app.post('/api/fingerprints', (req, res) => {
  const { id, label = '' } = req.body || {};
  const slot = parseInt(id, 10);
  if (!slot || slot < 1 || slot > FINGERPRINT_CAPACITY) {
    return res.status(400).json({ error: `slot must be 1..${FINGERPRINT_CAPACITY}` });
  }
  if (state.fingerprint.slots.some(s => s.id === slot)) {
    return res.status(400).json({ error: 'slot already in use' });
  }
  state.fingerprint.slots.push({
    id: slot, label: String(label).slice(0, 20),
    programmed: false, registeredAt: new Date().toISOString(),
  });
  state.fingerprint.enrolled = state.fingerprint.slots.length;
  pushEvent({ kind: 'fp_reserved', detail: `slot ${slot} (${label})`, granted: true });
  res.json({ ok: true, fingerprint: state.fingerprint });
});

app.delete('/api/fingerprints/:id', (req, res) => {
  const slot = parseInt(req.params.id, 10);
  const before = state.fingerprint.slots.length;
  state.fingerprint.slots = state.fingerprint.slots.filter(s => s.id !== slot);
  if (state.fingerprint.slots.length === before) return res.status(404).json({ error: 'not found' });
  state.fingerprint.enrolled = state.fingerprint.slots.length;
  pushEvent({ kind: 'fp_removed', detail: `slot ${slot}`, granted: null });
  res.json({ ok: true, fingerprint: state.fingerprint });
});

// Dashboard queues a command for the device to pick up.
// Body: { type: 'kill'|'unlock'|'enroll_fp'|'enroll_rfid', payload?: {...} }
app.post('/api/commands', (req, res) => {
  const { type, payload = {} } = req.body || {};
  const allowed = new Set(['kill', 'unlock', 'enroll_fp', 'enroll_rfid']);
  if (!allowed.has(type)) {
    return res.status(400).json({ error: 'unknown command type' });
  }
  const cmd = { id: newCmdId(), type, payload, createdAt: new Date().toISOString() };
  pendingCommands.push(cmd);
  pushEvent({ kind: 'command_queued', detail: `queued ${type}`, granted: null });
  res.json({ ok: true, command: cmd });
});

// ----- Device-facing API (auth required) -----

// Device pushes its current readings. Updates lastSeenAt.
app.post('/api/telemetry', deviceAuth, (req, res) => {
  const t = req.body || {};
  state.lastSeenAt = Date.now();
  if (t.device)      Object.assign(state.device, t.device);
  if (t.gps)         Object.assign(state.gps, t.gps);
  if (t.gsm)         Object.assign(state.gsm, t.gsm);
  if (t.fingerprint) Object.assign(state.fingerprint, t.fingerprint);
  if (t.rfid)        Object.assign(state.rfid, t.rfid);
  if (t.immobilizer) Object.assign(state.immobilizer, t.immobilizer);
  if (Array.isArray(t.events)) t.events.forEach(pushEvent);
  res.json({ ok: true, t: state.lastSeenAt });
});

// Device polls for queued commands (returns at most one).
app.get('/api/commands/pending', deviceAuth, (_req, res) => {
  const next = pendingCommands[0] || null;
  res.json({ command: next });
});

// Device acks a command after acting on it.
app.post('/api/commands/:id/ack', deviceAuth, (req, res) => {
  const idx = pendingCommands.findIndex(c => c.id === req.params.id);
  if (idx >= 0) {
    const [done] = pendingCommands.splice(idx, 1);
    pushEvent({ kind: 'command_done', detail: `acked ${done.type}`, granted: true });
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'command not found' });
});

app.listen(PORT, () => {
  console.log(`GuardTrack backend listening on :${PORT}`);
  console.log(`Heartbeat window: ${HEARTBEAT_MS} ms; offline after ${OFFLINE_AFTER_MS} ms`);
});
