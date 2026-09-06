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

async function render() {
  const s = await chrome.storage.local.get([
    'connected',
    'lastStatusAt',
    'lastPushAt',
    'lastPushOk',
    'lastPushCount',
    'lastError',
  ]);
  const dot = document.getElementById('dot');
  const status = document.getElementById('status');
  const shared = document.getElementById('shared');

  if (s.connected) {
    dot.className = 'dot ok';
    status.textContent = 'Connected to QuickListing ✓';
  } else {
    dot.className = 'dot bad';
    status.textContent = 'QuickListing not reachable';
  }

  if (s.lastPushAt) {
    const when = ago(s.lastPushAt);
    shared.textContent = s.lastPushOk
      ? 'Session shared ' + when + ' (' + (s.lastPushCount || 0) + ' cookies)'
      : 'Last share failed (' + when + ')';
  } else {
    shared.textContent = 'No session shared yet.';
  }
}

// Ask the worker to refresh status immediately, then render.
chrome.runtime.sendMessage({ type: 'ping' }, () => {
  // ignore response; storage is the source of truth
  render();
});
render();
