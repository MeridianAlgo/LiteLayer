// Cross-device settings sync. The browser keeps the live copy in localStorage;
// these keys are mirrored to the Pi (encrypted at rest) so a second device pulls
// the same look on login. ponytail: wrap localStorage instead of editing every
// setter — any write to a synced key auto-pushes (debounced).

const SYNC_KEYS = [
  'll-theme', 'll-accent', 'll-accent-hex', 'll-custom-colors',
  'll-single-click', 'll-hide-stats', 'll-boot-drive', 'll-login-anim',
];

let _applyingSync = false;   // true while pull writes localStorage — don't echo back
let _syncReady = false;      // only push once we've pulled (i.e. we're logged in)
let _pushTimer = null;

function pushSettings() {
  if (_applyingSync || !_syncReady) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    const out = {};
    for (const k of SYNC_KEYS) { const v = localStorage.getItem(k); if (v != null) out[k] = v; }
    api('/api/settings', {method: 'PUT', bg: true, body: JSON.stringify({settings: out})}).catch(() => {});
  }, 600);
}

// Re-apply every visual pref from the current localStorage values.
function _applySynced() {
  applyTheme(localStorage.getItem('ll-theme') || 'dark');
  const ac = localStorage.getItem('ll-accent') || 'purple';
  if (ac === 'custom') applyAccentColor(localStorage.getItem('ll-accent-hex') || '#7c3aed');
  else applyAccent(ac);
  _restoreCustomColors();
  if (typeof applyStatsPillsPref === 'function') applyStatsPillsPref();
  if (typeof applyLoginAnim === 'function') applyLoginAnim();
}

async function pullSettings() {
  try {
    const r = await api('/api/settings', {bg: true});
    if (!r?.ok) { _syncReady = true; return; }
    const data = (await r.json()).settings;
    if (data && typeof data === 'object') {
      _applyingSync = true;
      try { for (const k of SYNC_KEYS) if (data[k] != null) localStorage.setItem(k, data[k]); }
      finally { _applyingSync = false; }
      _applySynced();
      // Boot-drive is a backend flag that resets on restart — re-assert it.
      api('/api/system/boot-drive', {bg: true, method: 'POST',
        body: JSON.stringify({enabled: localStorage.getItem('ll-boot-drive') === '1'})}).catch(() => {});
    }
  } catch {}
  _syncReady = true;   // from now on, local changes sync up
}

// Wrap localStorage so existing setters (theme.js, settings.js) sync for free.
(function () {
  const _set = localStorage.setItem.bind(localStorage);
  const _rem = localStorage.removeItem.bind(localStorage);
  localStorage.setItem = (k, v) => { _set(k, v); if (!_applyingSync && SYNC_KEYS.includes(k)) pushSettings(); };
  localStorage.removeItem = (k) => { _rem(k); if (!_applyingSync && SYNC_KEYS.includes(k)) pushSettings(); };
})();
