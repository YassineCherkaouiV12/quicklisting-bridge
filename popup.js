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
    'lastWrongAccount',
    'lastWrongAt',
  ]);
  const shared = document.getElementById('shared');

  // A recent wrong-account signal takes precedence — the dealer needs to fix
  // which Facebook their browser is signed into.
  const wrongRecent =
    s.lastWrongAccount && s.lastWrongAt && Date.now() - s.lastWrongAt < 5 * 60 * 1000;

  // States:
  //   bad  (red)   — wrong FB in browser, OR last share failed
  //   ok   (green) — reachable + healthy
  //   idle (grey)  — app not running / not reachable
  if (s.connected && wrongRecent) {
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

  if (s.connected && wrongRecent) {
    shared.textContent =
      'Sign into the Facebook account this dealer posts with, then reload Facebook.';
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
