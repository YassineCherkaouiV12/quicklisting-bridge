// QuickListing Connector — MV3 service worker (PROTOTYPE).
//
// Purpose: when the QuickListing desktop app loses its Facebook session AND the
// server-side cookies are dead (so the app's own cookie vault can't recover),
// this companion extension — running in the dealer's REAL Chrome where they're
// still logged into FB — hands the app a FRESH live session over loopback.
//
// How it works:
//   • On a gentle poll (every ~30s) it GETs the app's loopback status endpoint.
//   • Only when the app answers {needed:true} (app session dead + bridge enabled)
//     does it read the full facebook.com cookie set + the browser User-Agent and
//     POST them to the app. Pull-on-demand ONLY — never continuous streaming.
//   • The app injects them and aligns its FB tab's UA so FB sees the same device.
//
// Security (prototype — see the app's sessionBridge.ts for the matching TODOs):
//   • Talks ONLY to http://127.0.0.1 (the app's loopback receiver). No external
//     hosts. The app binds 127.0.0.1 only.
//   • Auth is a single FIXED shared token (must match the app's BRIDGE_TOKEN).
//     TODO(prod): proper pairing — the app mints a random per-install token and
//     the dealer completes a one-time consent handshake; rotate the token.
//   • This shares real FB auth cookies with a local app. It is same-machine and
//     opt-in, but it IS sensitive — production must add a user-consent step.

const APP_BASE = 'http://127.0.0.1:47615';
// MUST match BRIDGE_TOKEN in gemini_desktop/src/main/facebook/sessionBridge.ts.
const TOKEN = 'ql-cookie-bridge-proto-8f3a2c';
const AUTH_HEADER = { Authorization: 'Bearer ' + TOKEN };
const POLL_ALARM = 'ql-bridge-poll';

async function setState(patch) {
  try {
    await chrome.storage.local.set(patch);
  } catch (_e) {
    /* storage best-effort */
  }
}

async function getStatus() {
  const res = await fetch(APP_BASE + '/bridge/status', { headers: AUTH_HEADER });
  if (!res.ok) throw new Error('status HTTP ' + res.status);
  return res.json();
}

async function collectAndPush() {
  // domain:'facebook.com' matches facebook.com + every subdomain, so this is the
  // FULL auth cookie set (c_user, xs, datr, sb, fr, …).
  const cookies = await chrome.cookies.getAll({ domain: 'facebook.com' });
  const mapped = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
  }));
  const body = JSON.stringify({ cookies: mapped, userAgent: navigator.userAgent });
  const res = await fetch(APP_BASE + '/bridge/cookies', {
    method: 'POST',
    headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
    body,
  });
  const ok = res.ok;
  // Store COUNTS/PRESENCE only for the popup — never cookie values.
  await setState({ lastPushAt: Date.now(), lastPushOk: ok, lastPushCount: mapped.length });
  return ok;
}

async function tick() {
  try {
    const status = await getStatus();
    await setState({ connected: true, lastStatusAt: Date.now(), lastError: null });
    if (status && status.needed) {
      await collectAndPush();
    }
  } catch (e) {
    await setState({ connected: false, lastError: String((e && e.message) || e) });
  }
}

function ensureAlarm() {
  // 0.5 min = 30s. MV3 service workers are killed between events, so we drive the
  // poll off an alarm rather than setInterval.
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  tick();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  tick();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) tick();
});

// Let the popup trigger an immediate status refresh when opened.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'ping') {
    tick().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});
