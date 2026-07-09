// Programs tab — import runnable programs from GitHub, keep them running,
// link to their web UI on the LAN and (via the Cloudflare tunnel) globally.

let _progPollTimer = null;

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
  const progs = (await r.json()).programs;
  if (!progs.length) {
    box.innerHTML = `<div class="prog-empty">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
      <div style="font-weight:600;color:var(--text-2)">No programs yet</div>
      <div>Paste a GitHub repository above to import your first one.</div>
    </div>`;
    return;
  }
  box.innerHTML = progs.map(_progCard).join('');
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

function _progCard(p) {
  const st = _PROG_STATUS[p.status] || _PROG_STATUS.unknown;
  const repoPath = p.repo_url.replace('https://github.com/', '');
  const lanUrl = p.web_port ? `http://${window.location.hostname}:${p.web_port}` : null;

  const settled = !['importing', 'error'].includes(p.status);
  let links = '';
  if (lanUrl) {
    links += `<a class="prog-chip" href="${esc(lanUrl)}" target="_blank" rel="noopener" title="Open on your local network">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>LAN · :${p.web_port}</a>`;
    links += p.global_url
      ? `<a class="prog-chip global" href="${esc(p.global_url)}" target="_blank" rel="noopener" title="Public link through the Cloudflare tunnel — works from anywhere">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>Global</a>
         <button class="prog-chip toggle ${p.public ? '' : 'private'}" onclick="toggleProgramPublic('${esc(p.name)}',${p.public})" title="${p.public ? 'Anyone with the link can open it. Click to require a LiteLayer sign-in.' : 'Sign-in required. Click to make the link public.'}">${p.public ? 'Public' : 'Private'}</button>`
      : `<span class="prog-chip dim" title="Turn on the Cloudflare tunnel in Settings → System to get a public link">Global link needs the Cloudflare tunnel</span>`;
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
  const ota  = document.getElementById('prog-ota-input').value;
  const btn  = document.getElementById('prog-import-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const r = await api('/api/programs', {method: 'POST',
      body: JSON.stringify({repo_url: repo, name, start_command: cmd, web_port: port, ota})});
    if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Import failed', 'error', 5000); return; }
    ['prog-repo-input','prog-name-input','prog-cmd-input','prog-port-input'].forEach(id => document.getElementById(id).value = '');
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
