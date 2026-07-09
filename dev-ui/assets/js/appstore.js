// App Store — curated apps you can install and run with one click.
// Each entry rides the existing Programs pipeline (clone → install deps →
// systemd unit), so an installed app shows up and is managed under Programs.
// ponytail: static catalog array, updated with LiteLayer itself via OTA;
// move to a fetched catalog.json if it ever needs to update out-of-band.

const _APP_CATALOG = [
  {
    name: 'uptime-kuma', title: 'Uptime Kuma', icon: '📈', category: 'Monitoring',
    repo: 'https://github.com/louislam/uptime-kuma', port: 3001,
    // dist isn't in the git repo — fetch it once, then just run.
    cmd: '[ -d dist ] || npm run download-dist; node server/server.js',
    desc: 'Uptime monitoring with a beautiful dashboard — ping your sites and services, get alerts when they go down.',
  },
  {
    name: 'changedetection', title: 'changedetection.io', icon: '👁️', category: 'Monitoring',
    repo: 'https://github.com/dgtlmoon/changedetection.io', port: 5000,
    cmd: '.venv/bin/python changedetection.py -d data -p $PORT',
    desc: 'Watch any web page for changes — price drops, restocks, new posts — and get notified.',
  },
  {
    name: 'dumbpad', title: 'DumbPad', icon: '📝', category: 'Productivity',
    repo: 'https://github.com/DumbWareio/DumbPad', port: 3020, cmd: null,
    desc: 'Stupid-simple notepad in your browser. Notes save as you type, stored on your Pi.',
  },
  {
    name: 'dumbdrop', title: 'DumbDrop', icon: '📥', category: 'Files',
    repo: 'https://github.com/DumbWareio/DumbDrop', port: 3030, cmd: null,
    desc: 'A drop zone for files — anyone you share the link with can upload straight to your Pi.',
  },
  {
    name: 'dumbwhois', title: 'DumbWhois', icon: '🔎', category: 'Utilities',
    repo: 'https://github.com/DumbWareio/DumbWhois', port: 3040, cmd: null,
    desc: 'Look up WHOIS, DNS and IP info for any domain from a clean little web page.',
  },
];

async function _loadAppStore() {
  const box = document.getElementById('appstore-list');
  if (!box) return;
  // Which catalog apps are already installed (by name) under Programs?
  const r = await api('/api/programs', {bg: true});
  const installed = new Set(r?.ok ? (await r.json()).programs.map(p => p.name) : []);
  box.innerHTML = _APP_CATALOG.map((a, i) => {
    const isIn = installed.has(a.name);
    return `<div class="store-card">
      <div class="store-icon">${a.icon}</div>
      <div class="store-body">
        <div class="store-head">
          <span class="store-title">${esc(a.title)}</span>
          <span class="store-cat">${esc(a.category)}</span>
        </div>
        <div class="store-desc">${esc(a.desc)}</div>
        <a class="store-repo" href="${esc(a.repo)}" target="_blank" rel="noopener">${esc(a.repo.replace('https://github.com/', ''))}</a>
      </div>
      ${isIn
        ? `<button class="btn btn-ghost btn-sm" onclick="setSettingsTab('programs')" title="Manage it under Programs">Installed ✓</button>`
        : `<button class="btn btn-primary btn-sm" id="store-btn-${i}" onclick="installCatalogApp(${i})">Install</button>`}
    </div>`;
  }).join('');
}

async function installCatalogApp(i) {
  const a = _APP_CATALOG[i];
  const btn = document.getElementById(`store-btn-${i}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const r = await api('/api/programs', {method: 'POST', body: JSON.stringify({
      repo_url: a.repo, name: a.name, start_command: a.cmd, web_port: a.port})});
    if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Install failed', 'error', 5000); return; }
    toast(`Installing ${a.title} — it will appear under Programs`, 'info', 4000);
    _loadAppStore();
  } finally { if (btn) { btn.disabled = false; btn.textContent = 'Install'; } }
}
