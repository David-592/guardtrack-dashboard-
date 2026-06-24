// GuardTrack live dashboard glue
// Drop this into your existing dashboard HTML with:
//   <script src="/live-dashboard.js"></script>
// just before </body>.
//
// Then add data-gt-* attributes to the elements you want to bind, e.g.:
//   <span data-gt-conn-pill></span>
//   <span data-gt-seconds-since></span>
//   <span data-gt-gps-lat></span>     <span data-gt-gps-lon></span>
//   <span data-gt-gsm-rssi></span>
//   <span data-gt-fp-count></span>    <span data-gt-fp-capacity></span>
//   <button data-gt-cmd="kill">Kill ignition</button>
//   <button data-gt-cmd="unlock">Unlock</button>
//   <div    data-gt-events></div>
//   <body   data-gt-state-class>      <!-- toggles .gt-online / .gt-offline -->
//
// Style the offline state however you like:
//   body.gt-offline .live-only { opacity: 0.35; pointer-events: none; }
//   body.gt-offline .gt-conn-pill { background: #b04848; }
//   body.gt-online  .gt-conn-pill { background: #2f8f4f; }

(function () {
  const POLL_MS = 3000;

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const setText = (sel, val) => {
    const el = $(sel);
    if (el) el.textContent = val == null ? '—' : String(val);
  };

  function applyState(s) {
    // Connection pill + body class toggle
    const body = $('[data-gt-state-class]') || document.body;
    body.classList.toggle('gt-online',  s.online);
    body.classList.toggle('gt-offline', !s.online);

    const pill = $('[data-gt-conn-pill]');
    if (pill) {
      pill.textContent = s.online ? 'Online' : 'Offline';
      pill.classList.toggle('gt-conn-pill', true);
    }

    setText('[data-gt-seconds-since]',
      s.secondsSinceSeen == null ? 'never' :
      s.secondsSinceSeen < 60 ? `${s.secondsSinceSeen}s ago` :
      `${Math.floor(s.secondsSinceSeen / 60)} min ago`);

    setText('[data-gt-gps-lat]',
      s.gps && s.gps.valid && s.gps.lat != null ? s.gps.lat.toFixed(6) : '—');
    setText('[data-gt-gps-lon]',
      s.gps && s.gps.valid && s.gps.lon != null ? s.gps.lon.toFixed(6) : '—');
    setText('[data-gt-gps-status]',
      !s.online ? 'no signal'
      : s.gps && s.gps.valid ? 'Strong' : 'searching…');

    setText('[data-gt-gsm-rssi]',
      s.gsm && s.gsm.rssiDbm != null ? `${s.gsm.rssiDbm} dBm` : '—');
    setText('[data-gt-gsm-network]',
      s.gsm && s.gsm.network ? s.gsm.network : '—');

    setText('[data-gt-fp-count]',
      s.fingerprint ? s.fingerprint.enrolled : 0);
    setText('[data-gt-fp-capacity]',
      s.fingerprint ? s.fingerprint.capacity : 5);

    setText('[data-gt-rfid-count]',
      s.rfid ? s.rfid.enrolled : 0);
    setText('[data-gt-rfid-capacity]',
      s.rfid ? s.rfid.capacity : 2);

    setText('[data-gt-contacts-count]',
      s.contacts ? s.contacts.numbers.length : 0);
    setText('[data-gt-contacts-capacity]',
      s.contacts ? s.contacts.capacity : 2);

    // Render RFID card list
    const rfidRoot = $('[data-gt-rfid-list]');
    if (rfidRoot && s.rfid && Array.isArray(s.rfid.cards)) {
      rfidRoot.innerHTML = '';
      for (const c of s.rfid.cards) {
        const row = document.createElement('div');
        row.className = 'gt-rfid-row';
        row.innerHTML = `
          <span class="gt-rfid-label">${escapeHtml(c.label || '(no label)')}</span>
          <span class="gt-rfid-uid">${escapeHtml(c.uid)}</span>
          <button data-gt-rfid-remove="${escapeHtml(c.uid)}">Remove</button>
        `;
        rfidRoot.appendChild(row);
      }
    }

    // Render contact list
    const contactRoot = $('[data-gt-contacts-list]');
    if (contactRoot && s.contacts && Array.isArray(s.contacts.numbers)) {
      contactRoot.innerHTML = '';
      for (const c of s.contacts.numbers) {
        const row = document.createElement('div');
        row.className = 'gt-contact-row';
        row.innerHTML = `
          <span class="gt-contact-label">${escapeHtml(c.label || '(no label)')}</span>
          <span class="gt-contact-number">${escapeHtml(c.number)}</span>
          <button data-gt-contact-remove="${escapeHtml(c.number)}">Remove</button>
        `;
        contactRoot.appendChild(row);
      }
    }

    // Disable "add" buttons at capacity
    const addContact = $('[data-gt-contact-add]');
    if (addContact && s.contacts) {
      addContact.disabled = s.contacts.numbers.length >= s.contacts.capacity;
    }
    const addRfid = $('[data-gt-rfid-add]');
    if (addRfid && s.rfid) {
      addRfid.disabled = s.rfid.cards && s.rfid.cards.length >= s.rfid.capacity;
    }

    setText('[data-gt-immobilizer]',
      s.immobilizer ? (s.immobilizer.armed ? 'Immobilized' : 'Unlocked') : '—');

    // Events table
    const evRoot = $('[data-gt-events]');
    if (evRoot && Array.isArray(s.events)) {
      evRoot.innerHTML = '';
      for (const ev of s.events.slice(0, 8)) {
        const row = document.createElement('div');
        row.className = 'gt-event-row';
        const grant = ev.granted === true  ? 'Granted'
                    : ev.granted === false ? 'Denied'
                    : '';
        row.innerHTML = `
          <span class="gt-event-kind">${escapeHtml(ev.kind || '')}</span>
          <span class="gt-event-detail">${escapeHtml(ev.detail || '')}</span>
          <span class="gt-event-ts">${escapeHtml(ev.ts || '')}</span>
          <span class="gt-event-grant">${escapeHtml(grant)}</span>
        `;
        evRoot.appendChild(row);
      }
    }

    // Disable command buttons when offline
    for (const btn of $$('[data-gt-cmd]')) {
      btn.disabled = !s.online;
      btn.classList.toggle('gt-disabled', !s.online);
    }
  }

  function escapeHtml(s) {
    return (s || '').replace(/[<>&"']/g, c => (
      { '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  }

  async function poll() {
    let s;
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      s = r.ok ? await r.json() : { online: false, secondsSinceSeen: null, events: [] };
    } catch {
      s = { online: false, secondsSinceSeen: null, events: [] };
    }
    applyState(s);
    // Fire custom event so the page can react (FP slot grid, map link, etc.)
    document.dispatchEvent(new CustomEvent('gt:state', { detail: s }));
  }

  async function sendCommand(type, payload = {}) {
    const r = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    });
    return r.ok ? r.json() : null;
  }

  function wireButtons() {
    for (const btn of $$('[data-gt-cmd]')) {
      btn.addEventListener('click', async (e) => {
        const type = btn.getAttribute('data-gt-cmd');
        if (type === 'kill' && !confirm('Cut ignition relay now?')) return;
        btn.disabled = true;
        await sendCommand(type);
        setTimeout(poll, 500);
        setTimeout(() => { btn.disabled = false; }, 1500);
      });
    }

    // Contact add
    const addContact = $('[data-gt-contact-add]');
    if (addContact) {
      addContact.addEventListener('click', async () => {
        const label  = ($('[data-gt-contact-label-input]')  || {}).value || '';
        const number = ($('[data-gt-contact-number-input]') || {}).value || '';
        const r = await fetch('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, number }),
        });
        if (!r.ok) alert((await r.json()).error || 'failed');
        else {
          const lbl = $('[data-gt-contact-label-input]');
          const num = $('[data-gt-contact-number-input]');
          if (lbl) lbl.value = '';
          if (num) num.value = '';
        }
        poll();
      });
    }
    // Contact remove (event delegation)
    document.addEventListener('click', async (e) => {
      const t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-gt-contact-remove')) {
        const number = t.getAttribute('data-gt-contact-remove');
        await fetch('/api/contacts/' + encodeURIComponent(number), { method: 'DELETE' });
        poll();
      }
      if (t && t.hasAttribute && t.hasAttribute('data-gt-rfid-remove')) {
        const uid = t.getAttribute('data-gt-rfid-remove');
        await fetch('/api/rfid/' + encodeURIComponent(uid), { method: 'DELETE' });
        poll();
      }
    });

    // RFID add
    const addRfid = $('[data-gt-rfid-add]');
    if (addRfid) {
      addRfid.addEventListener('click', async () => {
        const label = ($('[data-gt-rfid-label-input]') || {}).value || '';
        const uid   = ($('[data-gt-rfid-uid-input]')   || {}).value || '';
        const r = await fetch('/api/rfid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, uid }),
        });
        if (!r.ok) alert((await r.json()).error || 'failed');
        else {
          const lbl = $('[data-gt-rfid-label-input]');
          const u   = $('[data-gt-rfid-uid-input]');
          if (lbl) lbl.value = '';
          if (u)   u.value   = '';
        }
        poll();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireButtons();
    poll();
    setInterval(poll, POLL_MS);
  });
})();
