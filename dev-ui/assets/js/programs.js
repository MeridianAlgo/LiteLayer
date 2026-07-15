// Programs tab — import runnable programs from GitHub, keep them running,
// link to their web UI on the LAN and (via the Cloudflare tunnel) globally.

let _progPollTimer = null;

// Hand this to any AI along with a project and the result imports cleanly.
// Kept in sync with the copy in docs/programs.md.
const _PROG_AI_PROMPT = `Convert this project into a self-hostable, always-running program that a home
server (LiteLayer, a Raspberry Pi NAS) can import from GitHub and keep running
24/7 as a background service. Apply ALL of the following:

1. Long-running: the app must be a persistent process (a server or a worker
   loop) that never exits on its own. No one-shot scripts — the supervisor
   restarts exited processes forever, so a script that finishes becomes a
   crash loop. Crashing on a fatal error is fine; it gets restarted.
2. Start command: make it auto-detectable — a package.json "start" script, a
   main.py / app.py / server.py entry file (Python), or index.js (Node). If
   none of those fit, state the exact one-line start command in the README
   (it runs from the repo root via bash).
3. Dependencies: declare ALL of them in requirements.txt (Python — installed
   into a private venv) or package.json (Node — npm install --omit=dev).
   Nothing else gets installed for you.
4. Config and secrets: read every key, token and setting from environment
   variables (os.environ / process.env), with sensible defaults where
   possible. Never commit secrets — the host injects them as env vars.
5. If it serves a web page: listen on 0.0.0.0 at the port given by the PORT
   environment variable (fall back to a fixed default and say what it is).
   It is also reverse-proxied under the path /apps/<name>/, so use relative
   URLs for every asset and link (no absolute /static/... paths), and stick
   to plain HTTP — WebSockets and server-sent events don't pass the proxy.
   A web page is optional; a headless worker is fine.
6. Data: write any files or state to a path inside the app's own folder
   (relative paths) or one taken from an env var — it runs from its cloned
   repo directory.
7. Finish by telling me: the GitHub repo to import, the start command (if
   not auto-detectable), and the web port (if any).`;

async function copyProgramPrompt() {
  try {
    await navigator.clipboard.writeText(_PROG_AI_PROMPT);
  } catch {
    // Clipboard API needs HTTPS/localhost — fall back for plain-HTTP LAN.
    const ta = document.createElement('textarea');
    ta.value = _PROG_AI_PROMPT; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  toast('Prompt copied — paste it into any AI along with your project', 'success', 3500);
}

const _PROG_STATUS = {
  active:        {label: 'Running',       cls: 'run'},
  inactive:      {label: 'Stopped',       cls: 'stop'},
  failed:        {label: 'Failed',        cls: 'fail'},
  activating:    {label: 'Starting…',     cls: 'wait'},
  importing:     {label: 'Importing…',    cls: 'wait'},
  needs_command: {label: 'Needs command', cls: 'wait'},
  error:         {label: 'Import failed', cls: 'fail'},
  unknown:       {label: 'Unknown',       cls: 'stop'},
};

async function _loadPrograms() {
  const box = document.getElementById('programs-list');
  if (!box) return;
  const r = await api('/api/programs', {bg: true});
  if (!r?.ok) { box.innerHTML = '<div style="font-size:12px;color:var(--text-3)">Could not load programs.</div>'; return; }
  const data = await r.json();
  const progs = data.programs;
  if (!progs.length) {
    box.innerHTML = `<div class="prog-empty">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
      <div style="font-weight:600;color:var(--text-2)">No programs yet</div>
      <div>Paste a GitHub repository above to import your first one.</div>
    </div>`;
    return;
  }
  box.innerHTML = progs.map(p => _progCard(p, data.monitor)).join('');
  // Keep polling while anything is importing/starting so status flips live.
  clearTimeout(_progPollTimer);
  if (progs.some(p => p.status === 'importing' || p.status === 'activating')) {
    _progPollTimer = setTimeout(_loadPrograms, 3000);
  }
  // OTA check in the background — flags cards whose GitHub repo moved ahead.
  if (progs.some(p => p.ota !== 'self' && p.status !== 'importing')) _checkProgUpdates();
}

async function _checkProgUpdates() {
  const r = await api('/api/programs/updates', {bg: true});
  if (!r?.ok) return;
  const updates = (await r.json()).updates;
  for (const [name, u] of Object.entries(updates)) {
    if (!u.update_available) continue;
    document.getElementById(`prog-upd-${name}`)?.classList.remove('hidden');
    const btn = document.getElementById(`prog-updbtn-${name}`);
    if (btn) { btn.classList.remove('btn-ghost'); btn.classList.add('btn-primary'); }
  }
}

// esc() covers double quotes; inline onclick args sit in single quotes, so a
// start command like "python -c 'x'" needs its own quoting.
const _jsq = s => esc(String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));

function _progCard(p, mon) {
  const st = _PROG_STATUS[p.status] || _PROG_STATUS.unknown;
  const repoPath = p.repo_url.replace('https://github.com/', '');
  const lanUrl = p.web_port ? `http://${window.location.hostname}:${p.web_port}` : null;

  const settled = !['importing', 'error'].includes(p.status);
  let links = '';
  if (lanUrl) {
    links += `<a class="prog-chip" href="${esc(lanUrl)}" target="_blank" rel="noopener" title="Open on your local network">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>LAN · :${p.web_port}</a>`;
    links += p.global_url
      ? `<a class="prog-chip global" href="${esc(p.global_url)}" target="_blank" rel="noopener" title="${p.global_via === 'tailscale' ? 'Link through Tailscale — works on any device signed in to your tailnet' : 'Public link through the Cloudflare tunnel — works from anywhere'}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>Global${p.global_via === 'tailscale' ? ' · Tailscale' : ''}</a>
         <button class="prog-chip toggle ${p.public ? '' : 'private'}" onclick="toggleProgramPublic('${esc(p.name)}',${p.public})" title="${p.public ? 'Anyone with the link can open it. Click to require a LiteLayer sign-in.' : 'Sign-in required. Click to make the link public.'}">${p.public ? 'Public' : 'Private'}</button>`
      : `<span class="prog-chip dim" title="Turn on the Cloudflare tunnel or Tailscale in Settings → System to get a global link">Global link needs the Cloudflare tunnel or Tailscale</span>`;
  }
  // Monitor chip: always available for web-UI programs — with no monitor
  // attached, turning it on arms the kiosk to display when one is plugged in.
  if (settled && p.web_port) {
    links += `<button class="prog-chip toggle ${p.on_monitor ? '' : 'dim'}" onclick="toggleProgramMonitor('${esc(p.name)}',${p.on_monitor})"
      title="${p.on_monitor ? 'Showing fullscreen on the Pi’s monitor. Click to turn off.' : mon?.connected ? 'Show this program fullscreen on the monitor plugged into the Pi.' : 'No monitor detected right now — turning this on shows the program the moment one is plugged into the Pi.'}">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>${p.on_monitor ? 'On monitor' : 'Show on monitor'}</button>`;
  }
  if (settled && p.has_token) {
    links += `<button class="prog-chip toggle private" onclick="setProgramToken('${esc(p.name)}')"
      title="Cloned with a GitHub access token — update checks and pulls use it too. Click to replace or remove the token.">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Private repo</button>`;
  }
  if (settled) {
    links += `<button class="prog-chip toggle ${p.ota === 'self' ? 'private' : ''}" onclick="toggleProgramOta('${esc(p.name)}','${esc(p.ota)}')"
      title="${p.ota === 'self' ? 'This program runs its own updater — LiteLayer stays out of the way. Click to let LiteLayer check GitHub instead.' : 'LiteLayer checks GitHub for new commits and flags them here. Click if the program manages its own updates.'}">
      OTA · ${p.ota === 'self' ? 'Self-managed' : 'GitHub'}</button>`;
  }

  const canRun = !!p.start_command && !['importing', 'error'].includes(p.status);
  const actions = p.status === 'importing' ? '' : `
    <div class="prog-actions">
      ${p.status === 'needs_command' || !p.start_command
        ? `<button class="btn btn-primary btn-xs" onclick="setProgramCommand('${esc(p.name)}','${_jsq(p.start_command)}')">Set start command</button>`
        : p.status === 'active' || p.status === 'activating'
          ? `<button class="btn btn-ghost btn-xs" onclick="programAction('${esc(p.name)}','stop')">Stop</button>
             <button class="btn btn-ghost btn-xs" onclick="programAction('${esc(p.name)}','restart')">Restart</button>`
          : canRun ? `<button class="btn btn-primary btn-xs" onclick="programAction('${esc(p.name)}','start')">Start</button>` : ''}
      ${p.status !== 'error' ? `${p.ota !== 'self' ? `<button class="btn btn-ghost btn-xs" id="prog-updbtn-${esc(p.name)}" onclick="updateProgram('${esc(p.name)}')" title="git pull the latest code, reinstall dependencies, restart">Update</button>` : ''}
      <button class="btn btn-ghost btn-xs" onclick="toggleProgramSecrets('${esc(p.name)}')" title="KEY=VALUE environment variables, stored on the Pi and injected at start">Secrets</button>
      ${p.web_port ? `<button class="btn btn-ghost btn-xs" onclick="setProgramMonitorCommand('${esc(p.name)}','${_jsq(p.monitor_command)}')" title="Optional command run every time this program goes on the monitor">Monitor cmd${p.monitor_command ? ' ·✓' : ''}</button>` : ''}
      ${!p.has_token ? `<button class="btn btn-ghost btn-xs" onclick="setProgramToken('${esc(p.name)}')" title="Repo gone private (or imported before tokens existed)? Add a GitHub access token — update checks and pulls will use it">Add token</button>` : ''}
      <button class="btn btn-ghost btn-xs" onclick="setProgramPort('${esc(p.name)}',${p.web_port || 'null'})" title="The port the program's web UI listens on — the LAN link, global link and monitor kiosk all point here">Web port${p.web_port ? ` · ${p.web_port}` : ''}</button>
      <button class="btn btn-ghost btn-xs" onclick="toggleProgramLogs('${esc(p.name)}')">Logs</button>` : ''}
      <button class="btn btn-ghost btn-xs" style="color:var(--red)" onclick="removeProgram('${esc(p.name)}')">Remove</button>
    </div>`;

  return `<div class="prog-card" id="prog-card-${esc(p.name)}">
    <div class="prog-head">
      <span class="prog-led ${st.cls}"></span>
      <span class="prog-name">${esc(p.name)}</span>
      <span class="prog-badge ${st.cls}">${p.status === 'importing' && p.phase ? esc(p.phase) + '…' : st.label}</span>
      <span class="prog-badge upd hidden" id="prog-upd-${esc(p.name)}" title="A newer commit is on GitHub — click Update to pull it">Update available</span>
      <a class="prog-repo" href="${esc(p.repo_url)}" target="_blank" rel="noopener" title="Open the repository on GitHub">${esc(repoPath)}</a>
    </div>
    ${p.start_command && p.status !== 'importing' ? `<div class="prog-cmd" title="Start command — click to change" onclick="setProgramCommand('${esc(p.name)}','${_jsq(p.start_command)}')">$ ${esc(p.start_command)}</div>` : ''}
    ${p.error && (p.status === 'error' || p.status === 'failed') ? `<div class="vpn-error"><div class="vpn-error-msg">${esc(p.error)}</div></div>` : ''}
    ${links ? `<div class="prog-links">${links}</div>` : ''}
    ${actions}
    <div class="prog-secrets hidden" id="prog-secrets-${esc(p.name)}">
      <textarea id="prog-secrets-ta-${esc(p.name)}" spellcheck="false" placeholder="API_KEY=abc123&#10;DATABASE_URL=postgres://…&#10;# one KEY=VALUE per line"></textarea>
      <div class="prog-secrets-foot">
        <span>Stored on the Pi only (root-readable file) · injected as environment variables · saving restarts a running program</span>
        <button class="btn btn-ghost btn-xs" onclick="toggleProgramSecrets('${esc(p.name)}')">Cancel</button>
        <button class="btn btn-primary btn-xs" onclick="saveProgramSecrets('${esc(p.name)}')">Save secrets</button>
      </div>
    </div>
    <pre class="prog-logs hidden" id="prog-logs-${esc(p.name)}"></pre>
  </div>`;
}

async function importProgram() {
  const repo = document.getElementById('prog-repo-input').value.trim();
  if (!repo) { toast('Paste a GitHub repository URL first', 'error'); return; }
  const name = document.getElementById('prog-name-input').value.trim() || null;
  const cmd  = document.getElementById('prog-cmd-input').value.trim() || null;
  const port = parseInt(document.getElementById('prog-port-input').value, 10) || null;
  const token = document.getElementById('prog-token-input').value.trim() || null;
  const ota  = document.getElementById('prog-ota-input').value;
  const btn  = document.getElementById('prog-import-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const r = await api('/api/programs', {method: 'POST',
      body: JSON.stringify({repo_url: repo, name, start_command: cmd, web_port: port, token, ota})});
    if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Import failed', 'error', 5000); return; }
    ['prog-repo-input','prog-name-input','prog-cmd-input','prog-port-input','prog-token-input'].forEach(id => document.getElementById(id).value = '');
    toast(`Importing ${(await r.json()).name} — cloning from GitHub…`, 'info', 3500);
    _loadPrograms();
  } finally { btn.disabled = false; btn.textContent = 'Import'; }
}

async function programAction(name, action) {
  const r = await api(`/api/programs/${encodeURIComponent(name)}/action`, {method: 'POST', body: JSON.stringify({action})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || `Could not ${action} ${name}`, 'error', 5000); return; }
  toast({start: 'Started', stop: 'Stopped', restart: 'Restarted'}[action] + ` ${name}`, 'success', 2000);
  _loadPrograms();
}

async function updateProgram(name) {
  toast(`Updating ${name} from GitHub…`, 'info', 2500);
  const r = await api(`/api/programs/${encodeURIComponent(name)}/update`, {method: 'POST'});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Update failed', 'error', 6000); return; }
  toast(`${name} updated`, 'success');
  _loadPrograms();
}

async function removeProgram(name) {
  if (!confirm(`Remove "${name}"? This stops it and deletes its files from the Pi. The GitHub repository is untouched.`)) return;
  const r = await api(`/api/programs/${encodeURIComponent(name)}`, {method: 'DELETE'});
  if (!r?.ok) { toast('Could not remove program', 'error'); return; }
  toast(`Removed ${name}`, 'success');
  _loadPrograms();
}

async function setProgramCommand(name, current) {
  const cmd = prompt(`Start command for "${name}" — runs from the program's folder:`, current || '');
  if (cmd == null) return;
  const r = await api(`/api/programs/${encodeURIComponent(name)}`, {method: 'PUT', body: JSON.stringify({start_command: cmd})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not save command', 'error', 5000); return; }
  toast('Start command saved', 'success', 2000);
  _loadPrograms();
}

async function toggleProgramPublic(name, isPublic) {
  const r = await api(`/api/programs/${encodeURIComponent(name)}`, {method: 'PUT', body: JSON.stringify({public: !isPublic})});
  if (!r?.ok) { toast('Could not change link visibility', 'error'); return; }
  toast(!isPublic ? 'Link is public — anyone with it can open the program' : 'Link is private — a LiteLayer sign-in is required', 'success', 3000);
  _loadPrograms();
}

async function toggleProgramOta(name, current) {
  const next = current === 'self' ? 'github' : 'self';
  const r = await api(`/api/programs/${encodeURIComponent(name)}`, {method: 'PUT', body: JSON.stringify({ota: next})});
  if (!r?.ok) { toast('Could not change update mode', 'error'); return; }
  toast(next === 'self'
    ? `${name} now manages its own updates — LiteLayer will stop checking GitHub`
    : `LiteLayer now checks GitHub for ${name} updates`, 'success', 3000);
  _loadPrograms();
}

async function setProgramPort(name, current) {
  const v = prompt(`Web port for "${name}" — the port its web UI actually listens on (1024–65535, not 8000). Leave empty to remove the web links:`, current || '');
  if (v == null) return;
  const port = parseInt(v, 10);
  if (v.trim() !== '' && !(port >= 1024 && port <= 65535)) { toast('Port must be 1024–65535', 'error'); return; }
  const body = v.trim() === '' ? {clear_port: true} : {web_port: port};
  const r = await api(`/api/programs/${encodeURIComponent(name)}`, {method: 'PUT', body: JSON.stringify(body)});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not save port', 'error', 5000); return; }
  toast(v.trim() ? `Web port set to ${port} — links and the monitor kiosk now point there` : 'Web port removed', 'success', 3500);
  _loadPrograms();
}

async function setProgramToken(name) {
  const t = prompt(`GitHub access token for "${name}" — used for update checks and pulls. Leave empty to remove it:`);
  if (t == null) return;
  const r = await api(`/api/programs/${encodeURIComponent(name)}`, {method: 'PUT', body: JSON.stringify({token: t})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not save token', 'error', 5000); return; }
  toast(t.trim() ? 'Token saved — it stays on the Pi and is never shown again' : 'Token removed', 'success', 3500);
  _loadPrograms();
}

async function setProgramMonitorCommand(name, current) {
  const cmd = prompt(`Monitor command for "${name}" — runs from the program's folder every time it goes on the monitor. Leave empty to remove:`, current || '');
  if (cmd == null) return;
  const r = await api(`/api/programs/${encodeURIComponent(name)}`, {method: 'PUT', body: JSON.stringify({monitor_command: cmd})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not save monitor command', 'error', 5000); return; }
  toast(cmd.trim() ? 'Monitor command saved — it runs on every kiosk start' : 'Monitor command removed', 'success', 3000);
  _loadPrograms();
}

async function toggleProgramMonitor(name, on) {
  const r = await api(`/api/programs/${encodeURIComponent(name)}/monitor`, {method: 'POST', body: JSON.stringify({on: !on})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not change the monitor', 'error', 6000); return; }
  const d = await r.json();
  toast(on ? 'Monitor turned off'
    : d.connected ? `${name} is now fullscreen on the Pi's monitor`
    : `${name} will show fullscreen as soon as a monitor is plugged into the Pi`, 'success', 3500);
  _loadPrograms();
}

async function toggleProgramSecrets(name) {
  const box = document.getElementById(`prog-secrets-${name}`);
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  const ta = document.getElementById(`prog-secrets-ta-${name}`);
  const r = await api(`/api/programs/${encodeURIComponent(name)}/secrets`);
  ta.value = r?.ok ? (await r.json()).env : '';
  box.classList.remove('hidden');
  ta.focus();
}

async function saveProgramSecrets(name) {
  const ta = document.getElementById(`prog-secrets-ta-${name}`);
  const r = await api(`/api/programs/${encodeURIComponent(name)}/secrets`, {method: 'PUT', body: JSON.stringify({env: ta.value})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not save secrets', 'error', 5000); return; }
  const d = await r.json();
  toast(d.restarted ? 'Secrets saved — program restarted with the new values' : 'Secrets saved', 'success', 3000);
  document.getElementById(`prog-secrets-${name}`)?.classList.add('hidden');
}

async function toggleProgramLogs(name) {
  const pre = document.getElementById(`prog-logs-${name}`);
  if (!pre) return;
  if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return; }
  pre.textContent = 'Loading…'; pre.classList.remove('hidden');
  const r = await api(`/api/programs/${encodeURIComponent(name)}/logs`, {bg: true});
  pre.textContent = r?.ok ? (await r.json()).logs : 'Could not load logs.';
  pre.scrollTop = pre.scrollHeight;
}
