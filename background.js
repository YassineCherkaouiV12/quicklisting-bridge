// QuickListing Connector — MV3 service worker (PROTOTYPE).
//
// Purpose: when the QuickListing desktop app loses its Facebook session AND the
// server-side cookies are dead (so the app's own cookie vault can't recover),
// this companion extension — running in the dealer's REAL Chrome where they're
// still logged into FB — hands the app a FRESH live session over loopback.
//
// How it works:
//   • On a gentle poll (every ~30s) it GETs the app's loopback status endpoint,
//     which answers { needed, expectedCUser }.
//   • Only when needed:true (app session dead/absent + bridge enabled) does it
//     act — and it ONLY grabs the account the app actually posts with:
//       - reads the browser's ACTIVE facebook.com c_user,
//       - if it equals expectedCUser (or expectedCUser is null → no constraint)
//         it pushes the full cookie set + User-Agent (pull-on-demand, never
//         streaming),
//       - if it DIFFERS it does NOT push the wrong account — it reports the
//         mismatch to /bridge/wrong-account so the app can tell the dealer,
//       - if there's no c_user (not logged into FB in this browser) it pushes
//         nothing and just records "no session".
//   • The app injects the (matching) cookies and aligns its FB tab's UA so FB
//     sees the same device.
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

/** The browser's currently-active facebook.com c_user (the FB account the dealer
 *  is signed into in THIS Chrome), or null when not logged into FB. */
async function getActiveCUser() {
  try {
    const c = await chrome.cookies.get({ url: 'https://www.facebook.com', name: 'c_user' });
    return c && c.value ? c.value : null;
  } catch (_e) {
    return null;
  }
}

/** Tell the app the browser is signed into a DIFFERENT FB than the dealer posts
 *  with — so it can surface it to the dealer. We do NOT push the wrong account. */
async function reportWrongAccount(expected, browserCUser) {
  await setState({
    lastWrongAccount: { expected: expected || null, browser: browserCUser },
    lastWrongAt: Date.now(),
    lastPushOk: false,
  });
  try {
    await fetch(APP_BASE + '/bridge/wrong-account', {
      method: 'POST',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected: expected || null, browserCUser }),
    });
  } catch (_e) {
    /* best-effort — the app will retry status next poll */
  }
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
    // Account-targeted: only ever grab the account the app posts with.
    const expected = status && status.expectedCUser ? String(status.expectedCUser) : null;
    const active = await getActiveCUser();
    // PERSISTENT account-match state for the popup — computed on EVERY poll, not
    // only when a push is needed. Otherwise, while the app already has a session
    // (needed:false) the popup would show a plain green "Connected" even when this
    // browser is signed into a DIFFERENT Facebook than the dealer posts with. Now
    // the popup always tells the truth about the account match.
    const accountMismatch = Boolean(expected && active && active !== expected);
    await setState({
      connected: true,
      lastStatusAt: Date.now(),
      lastError: null,
      accountMismatch,
      hasBrowserSession: Boolean(active),
    });
    if (!status || !status.needed) return;

    if (!active) {
      // Dealer isn't logged into Facebook in this browser — nothing to share.
      await setState({ lastNoSessionAt: Date.now() });
      return;
    }
    if (!expected || active === expected) {
      // Matches the dealer's posting account (or no constraint) → safe to push.
      await setState({ lastWrongAccount: null });
      await collectAndPush();
    } else {
      // Browser is signed into a DIFFERENT FB → never push the wrong account.
      await reportWrongAccount(expected, active);
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
