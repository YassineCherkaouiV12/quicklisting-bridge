// Popup: shows whether we can reach the QuickListing app + when a session was
// last shared. Reads counts/timestamps only — never cookie values.

function ago(ts) {
  if (!ts) return null;
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins <= 0) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? '1 hr ago' : hrs + ' hrs ago';
}

function setPill(kind, text) {
  const pill = document.getElementById('pill');
  const status = document.getElementById('status');
  pill.className = 'pill ' + kind; // ok | idle | bad
  status.textContent = text;
}

async function render() {
  const s = await chrome.storage.local.get([
    'connected',
    'lastStatusAt',
    'lastPushAt',
    'lastPushOk',
    'lastPushCount',
    'lastError',
    'accountMismatch',
    'hasBrowserSession',
  ]);
  const shared = document.getElementById('shared');

  // Persistent account-match state (recomputed every poll): true whenever this
  // browser's Facebook is a DIFFERENT account than the one this dealer posts
  // with. Shown as long as it's true — NOT a 5-minute window — so "Connected ✓"
  // never masks a wrong account.
  const mismatch = Boolean(s.accountMismatch);

  // States:
  //   bad  (red)   — wrong FB in browser, OR last share failed
  //   ok   (green) — reachable + healthy (and the right account)
  //   idle (grey)  — app not running / not reachable
  if (s.connected && mismatch) {
    setPill('bad', 'Wrong Facebook in this browser');
  } else if (s.connected) {
    if (s.lastPushOk === false) {
      setPill('bad', 'Connected — last share failed');
    } else {
      setPill('ok', 'Connected to QuickListing ✓');
    }
  } else {
    setPill('idle', 'QuickListing app not running');
  }

  if (s.connected && mismatch) {
    shared.textContent =
      'This browser is signed into a different Facebook than this dealer posts with. Sign into the correct account here, then reload Facebook.';
  } else if (s.lastPushAt) {
    const when = ago(s.lastPushAt);
    shared.innerHTML = s.lastPushOk
      ? 'Session shared <b>' + when + '</b>'
      : 'Last share failed <b>' + when + '</b>';
  } else {
    shared.textContent = s.connected
      ? 'No session shared yet — nothing needed.'
      : 'Open the QuickListing app to connect.';
  }
}

// Ask the worker to refresh status immediately, then render.
try {
  chrome.runtime.sendMessage({ type: 'ping' }, () => {
    void chrome.runtime.lastError; // ignore "no receiver"; storage is the source of truth
    render();
  });
} catch (_e) {
  render();
}
render();
