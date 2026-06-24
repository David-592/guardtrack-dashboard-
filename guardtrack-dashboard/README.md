# GuardTrack backend

Small Node + Express service that turns the existing GuardTrack dashboard from a static mockup into a live view of the real device. The dashboard goes Online only when the ESP32 + SIM7600 are checking in, and Offline (with last-seen timestamp) when they're not.

## Capacities (change in one place)

These constants at the top of `server.js`:

```js
const FINGERPRINT_CAPACITY = 5;
const RFID_CAPACITY        = 2;
const CONTACT_CAPACITY     = 2;
```

To change the limits later, edit those three lines and redeploy. The dashboard JS and firmware will pick the new numbers up automatically because the values are sent to the dashboard in the `/api/state` payload.

## What it gives you

| Endpoint | Who calls it | Purpose |
|---|---|---|
| `GET  /api/state`             | Dashboard | One-shot snapshot of online status, telemetry, events, lists |
| `POST /api/contacts`          | Dashboard | Add SMS alert number (E.164 like `+5926...`) |
| `DELETE /api/contacts/:number`| Dashboard | Remove SMS alert number |
| `POST /api/rfid`              | Dashboard | Register an RFID card by UID |
| `DELETE /api/rfid/:uid`       | Dashboard | Remove a registered card |
| `POST /api/commands`          | Dashboard | Queue command for device (kill / unlock / enroll_fp / enroll_rfid) |
| `POST /api/telemetry`         | **Device** | Push heartbeat + sensor state |
| `GET  /api/commands/pending`  | **Device** | Pull next queued command |
| `POST /api/commands/:id/ack`  | **Device** | Mark a command done |

Device endpoints require an `X-Device-Auth` header equal to the `DEVICE_TOKEN` env var.

## Deploy to Render

1. Put `server.js`, `package.json`, and the `public/` folder in a git repo and push to GitHub.
2. On Render: **New → Web Service**, connect the repo.
3. **Build command:** `npm install`. **Start command:** `npm start`.
4. Under **Environment**, add `DEVICE_TOKEN` with a long random string. This is the only thing standing between your dashboard and someone else's ESP32 — make it long.
5. Deploy. Note the public URL Render gives you.

## Wire your existing dashboard to it

Two choices:

**Option A (cleanest)** — replace the static deploy with this Node service. Put your existing `index.html`, `style.css`, and any other assets into the `public/` folder, then add this one line before `</body>`:

```html
<script src="/live-dashboard.js"></script>
```

Then sprinkle `data-gt-*` attributes on the elements that should go live. The script binds them automatically:

```html
<body data-gt-state-class>
  <span data-gt-conn-pill></span>           <!-- "Online" / "Offline" -->
  <span data-gt-seconds-since></span>       <!-- "12s ago" / "4 min ago" / "never" -->

  <span data-gt-gps-lat></span>
  <span data-gt-gps-lon></span>
  <span data-gt-gps-status></span>          <!-- Strong / searching… / no signal -->

  <span data-gt-gsm-rssi></span>
  <span data-gt-gsm-network></span>

  <span data-gt-fp-count></span> / <span data-gt-fp-capacity></span>
  <span data-gt-rfid-count></span> / <span data-gt-rfid-capacity></span>
  <span data-gt-contacts-count></span> / <span data-gt-contacts-capacity></span>

  <span data-gt-immobilizer></span>         <!-- "Immobilized" / "Unlocked" -->

  <button data-gt-cmd="kill">Kill ignition</button>
  <button data-gt-cmd="unlock">Unlock vehicle</button>

  <!-- Access log -->
  <div data-gt-events></div>

  <!-- Contacts -->
  <input data-gt-contact-label-input  placeholder="Label (e.g. Owner)">
  <input data-gt-contact-number-input placeholder="+5926...">
  <button data-gt-contact-add>Add number</button>
  <div data-gt-contacts-list></div>

  <!-- RFID -->
  <input data-gt-rfid-label-input placeholder="Card name">
  <input data-gt-rfid-uid-input   placeholder="UID e.g. 9B:27:2C:1F">
  <button data-gt-rfid-add>Register card</button>
  <div data-gt-rfid-list></div>

  <script src="/live-dashboard.js"></script>
</body>
```

Add a tiny bit of CSS for the online/offline visual:

```css
body.gt-offline .live-only { opacity: .35; pointer-events: none; }
body.gt-offline [data-gt-conn-pill] { background: #b04848; color: #fff; }
body.gt-online  [data-gt-conn-pill] { background: #2f8f4f; color: #fff; }
```

**Option B (keep your existing static deploy)** — add this backend as a separate Render service and edit your dashboard's JS to fetch from the new service's URL. Slightly more setup; only worth it if you can't redeploy the static dashboard.

## Wire the firmware

In `guardtrack-firmware/guardtrack_telemetry.ino`:

```c
const char* GT_SERVER       = "https://YOUR-SERVICE.onrender.com";   // your Render URL
const char* GT_DEVICE_TOKEN = "the-long-random-string-you-set-in-Render";
const char* GT_APN          = "internet";                            // Digicel Guyana
```

Flash, power on. Watch the Render logs — you should see `POST /api/telemetry` every 30 s, and the dashboard pill should flip to **Online** within seconds.

## Demo script for the viva

1. Open the dashboard on a laptop. Show it sitting at **Offline / last seen never**.
2. Power on the ESP32 + SIM7600 box. Watch the pill go **Online** within ~30 s and GPS coordinates appear.
3. From the dashboard, hit **Kill ignition** → the relay clicks, the ignition test bulb goes out.
4. Place a registered finger on the AS608 → access-log row appears within ~30 s, immobilizer state flips.
5. Place an unknown finger → "Denied" row, SMS arrives on the owner's phone within seconds.

That's the full demo loop. Three to five minutes if you've practised it.

## Things this backend does *not* do (intentionally)

- No database. In-memory only. If Render restarts the service the lists reset. For a final-year project that's fine; if you want persistence later, dump `state` to a JSON file on every change.
- No login on the dashboard. Anyone with the URL can press buttons. For a real product you'd want session auth; for a viva demo, fine.
- No HTTPS for the device. The SIM7600's HTTP stack handles TLS automatically because the URL is `https://`, so the data is encrypted in flight, but mutual auth is only one-way (token in header).
