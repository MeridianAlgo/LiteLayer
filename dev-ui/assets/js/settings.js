let _settingsTab = 'appearance';

function openSettings() {
  buildColorPickers();
  applyTheme(_currentTheme);
  applyLoginAnim();   // reflect the saved state on the Appearance toggle
  _reflectLoginGradUI();
  document.getElementById('settings-username-display').textContent = currentUsername;
  ['settings-cur-pass','settings-new-user','settings-new-pass','settings-conf-pass'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('settings-error').style.display = 'none';
  if (_otaData) updateVersionChip(_otaData);
  setSettingsTab(_settingsTab);
  show('settings-overlay');
}

function closeSettings() { hide('settings-overlay'); }

function setSettingsTab(tab) {
  _settingsTab = tab;
  ['appearance','account','devices','system','photos','shortcuts','about'].forEach(t => {
    document.getElementById(`stab-${t}`)?.classList.toggle('hidden', t !== tab);
    document.getElementById(`snav-${t}`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'about')   _loadAbout();
  if (tab === 'system')  _loadSystem();
  if (tab === 'devices') _loadDevices();
  if (tab === 'account') _loadTwoFA();
  if (tab === 'photos')  _loadPhotos();
}

// ── Two-factor auth ─────────────────────────────────────────────────────────────

async function _loadTwoFA() {
  const box = document.getElementById('twofa-box');
  if (!box) return;
  const r = await api('/api/auth/2fa');
  const on = r?.ok && (await r.json()).enabled;
  box.innerHTML = on
    ? `<div class="toggle-row"><div class="toggle-row-text" style="color:var(--green)">✓ Two-factor is on</div>
         <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="disable2FA()">Turn off</button></div>`
    : `<button class="btn btn-primary btn-sm" onclick="setup2FA()">Set up two-factor</button>`;
}

async function setup2FA() {
  const pw = await askPassword('Set up two-factor', 'Enter your password to begin.');
  if (pw == null) return;
  const r = await api('/api/auth/2fa/setup', { method: 'POST', body: JSON.stringify({ password: pw }) });
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not start setup', 'error'); return; }
  const d = await r.json();
  const box = document.getElementById('twofa-box');
  box.innerHTML = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
      <div style="width:160px;background:#fff;padding:8px;border-radius:8px">${d.qr_svg}</div>
      <div style="flex:1;min-width:200px">
        <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">Scan with your authenticator app, or enter this key manually:</div>
        <div style="font-family:var(--mono);font-size:12px;word-break:break-all;margin-bottom:12px">${esc(d.secret)}</div>
        <div class="field"><label>Enter the 6-digit code to confirm</label><input id="twofa-code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"></div>
        <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="confirm2FA()">Confirm & enable</button>
      </div>
    </div>`;
}

async function confirm2FA() {
  const code = document.getElementById('twofa-code').value.trim();
  const r = await api('/api/auth/2fa/confirm', { method: 'POST', body: JSON.stringify({ code }) });
  if (r?.ok) { toast('Two-factor enabled', 'success'); _loadTwoFA(); }
  else { const e = await r.json().catch(() => ({})); toast(e.detail || 'Wrong code', 'error'); }
}

async function disable2FA() {
  const pw = await askPassword('Turn off two-factor', 'Enter your password to disable 2FA.');
  if (pw == null) return;
  const r = await api('/api/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ password: pw }) });
  if (r?.ok) { toast('Two-factor disabled', 'success'); _loadTwoFA(); }
  else { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not disable', 'error'); }
}

async function signOutOthers() {
  if (!confirm('Sign out every other device? They will need to sign in again.')) return;
  const r = await api('/api/auth/signout-others', { method: 'POST' });
  if (r?.ok) { toast(`Ended ${(await r.json()).ended} other session(s)`, 'success'); _loadDevices(); }
}

// ── Devices tab (trusted-device allowlist) ──────────────────────────────────────

async function _loadDevices() {
  const sw = document.getElementById('devices-enforce-sw');
  const list = document.getElementById('devices-list');
  const r = await api('/api/devices');
  if (!r?.ok) { if (list) list.innerHTML = '<div style="color:var(--text-3);font-size:12px">Could not load devices.</div>'; return; }
  const d = await r.json();
  sw?.classList.toggle('on', d.enforce);
  if (!d.devices.length) { list.innerHTML = '<div style="color:var(--text-3);font-size:12px">No devices yet.</div>'; return; }
  const ago = ts => { const s = Date.now()/1000 - ts; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s/60)+'m ago'; if (s < 86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; };
  list.innerHTML = d.devices.map(dev => `
    <div class="toggle-row" style="align-items:center">
      <div class="toggle-row-text">${esc(dev.label || 'Device')}${dev.current ? ' <span style="color:var(--accent);font-size:10px;font-weight:600">· this device</span>' : ''}
        <small>${esc(dev.last_ip || '—')} · last seen ${ago(dev.last_seen || 0)}</small>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-xs" onclick="renameDevice('${esc(dev.id)}','${esc(dev.label || '')}')">Rename</button>
        ${dev.current && d.enforce ? '' : `<button class="btn btn-ghost btn-xs" style="color:var(--red)" onclick="removeDevice('${esc(dev.id)}','${esc(dev.label || 'this device')}')">Remove</button>`}
      </div>
    </div>`).join('');
  _loadSessions();
  _loadAudit();
}

async function _loadSessions() {
  const box = document.getElementById('sessions-list'); if (!box) return;
  const r = await api('/api/sessions'); if (!r?.ok) { box.innerHTML = ''; return; }
  const ago = ts => { const s = Date.now()/1000 - ts; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s/60)+'m ago'; if (s < 86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; };
  box.innerHTML = (await r.json()).sessions.map(s =>
    `<div style="font-size:12px;color:var(--text-3);padding:3px 0">${esc(s.ip || '—')} · started ${ago(s.created)}${s.current ? ' <span style="color:var(--accent);font-weight:600">· this session</span>' : ''}</div>`
  ).join('') || '<div style="font-size:12px;color:var(--text-3)">—</div>';
}

async function _loadAudit() {
  const box = document.getElementById('audit-list'); if (!box) return;
  const r = await api('/api/audit'); if (!r?.ok) { box.innerHTML = ''; return; }
  const when = ts => new Date(ts * 1000).toLocaleString();
  box.innerHTML = (await r.json()).events.slice(0, 30).map(e =>
    `<div style="padding:2px 0">${when(e.ts)} · <b>${esc(e.event)}</b>${e.user ? ' · ' + esc(e.user) : ''}${e.ip ? ' · ' + esc(e.ip) : ''}${e.detail ? ' · ' + esc(e.detail) : ''}</div>`
  ).join('') || '<div>No activity yet.</div>';
}

async function toggleDevicesEnforce() {
  const sw = document.getElementById('devices-enforce-sw');
  const enabling = !sw.classList.contains('on');
  const r = await api('/api/devices/enforce', { method: 'POST', body: JSON.stringify({ enabled: enabling }) });
  if (!r) return;
  if (r.ok) { sw.classList.toggle('on', enabling); toast(enabling ? 'Only trusted devices can sign in now' : 'Device restriction off', 'success'); _loadDevices(); }
  else { const e = await r.json(); toast(e.detail || 'Could not change setting', 'error', 5000); }
}

async function renameDevice(id, current) {
  const label = prompt('Name this device:', current);
  if (label == null) return;
  const r = await api(`/api/devices/${encodeURIComponent(id)}/rename`, { method: 'POST', body: JSON.stringify({ label: label.trim() }) });
  if (r?.ok) { toast('Renamed', 'success', 1500); _loadDevices(); }
}

async function removeDevice(id, label) {
  if (!confirm(`Remove "${label}"? It will need to sign in again, and won't be allowed to if the restriction is on.`)) return;
  const r = await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r) return;
  if (r.ok) { toast('Device removed', 'success'); _loadDevices(); }
  else { const e = await r.json(); toast(e.detail || 'Could not remove device', 'error', 5000); }
}

// ── System tab ─────────────────────────────────────────────────────────────────

async function _loadSystem() {
  document.getElementById('boot-drive-sw')?.classList.toggle('on', localStorage.getItem('ll-boot-drive') === '1');
  document.getElementById('folder-tree-sw')?.classList.toggle('on', localStorage.getItem('ll-folder-tree') !== '0');
  document.getElementById('single-click-sw')?.classList.toggle('on', localStorage.getItem('ll-single-click') === '1');
  document.getElementById('stats-pills-sw')?.classList.toggle('on', localStorage.getItem('ll-hide-stats') !== '1');

  // Terminal on/off — backend is the source of truth.
  const tSw = document.getElementById('terminal-sw');
  if (tSw) {
    try { const r = await api('/api/system/terminal/status'); if (r?.ok) tSw.classList.toggle('on', (await r.json()).enabled); } catch {}
  }

  // Keep-drives-mounted preference (source of truth is the backend state file).
  const amSw = document.getElementById('auto-mount-sw');
  if (amSw) {
    try {
      const r = await api('/api/drives/auto-mount');
      if (r?.ok) amSw.classList.toggle('on', (await r.json()).enabled);
    } catch {}
  }

  _loadCloudflare();

  // VPN — show installed VPNs grouped local-mesh vs remote-access and let the
  // user switch to any installed one (backend turns the others off, no reboot).
  const box = document.getElementById('vpn-list');
  if (!box) return;
  box.innerHTML = `<div class="cl-loading" style="padding:10px"><span class="spinner" style="width:14px;height:14px;border-width:2px"></span>Checking…</div>`;
  try {
    const r = await api('/api/system/vpns');
    const vpns = r?.ok ? (await r.json()).vpns : [];
    const by = Object.fromEntries(vpns.map(v => [v.name, v]));
    const groups = {'Local mesh': ['ZeroTier', 'WireGuard'], 'Global / remote access': ['Tailscale', 'Cloudflare Tunnel']};
    let html = '';
    for (const [label, names] of Object.entries(groups)) {
      html += `<div class="color-group-label">${label}</div>`;
      for (const name of names) {
        const v = by[name] || {installed: false, active: false};
        const badge = v.active ? `<span class="vpn-row-badge active">In use</span>`
                    : v.installed ? `<span class="vpn-row-badge">Installed</span>`
                                  : `<span class="vpn-row-badge">Not installed</span>`;
        const btn = v.installed && !v.active
          ? `<button class="btn btn-ghost btn-xs" onclick="switchVpn('${esc(name)}')">Use this</button>` : '';
        html += `<div class="vpn-row"><span class="vpn-row-name">${esc(name)}</span>${badge}${btn}</div>`;
      }
    }
    box.innerHTML = html + `<div class="vpn-help-note">Install a VPN once over SSH; then switch between the installed ones right here — "Use this" turns the chosen VPN on and the others off (no reboot). See <code>docs/networking.md</code>.</div>`;
  } catch {
    box.innerHTML = `<div style="font-size:12px;color:var(--text-3)">Could not read VPN status</div>`;
  }
}

// ── Cloudflare Tunnel ────────────────────────────────────────────────────────

async function _loadCloudflare() {
  const box = document.getElementById('cf-box');
  if (!box) return;
  let d;
  try { const r = await api('/api/system/cloudflare'); d = r?.ok ? await r.json() : null; } catch {}
  if (!d) { box.innerHTML = `<div style="font-size:12px;color:var(--text-3)">Could not read Cloudflare status</div>`; return; }
  const on = d.active, quickOn = on && d.mode === 'quick';
  const url = d.url ? (d.url.startsWith('http') ? d.url : 'https://' + d.url) : '';
  let urlHtml = '';
  if (on && url) {
    urlHtml = `<div class="cf-url"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(d.url)}</a>
      <button class="btn btn-ghost btn-xs" onclick="navigator.clipboard.writeText('${esc(url)}').then(()=>toast('Copied','success',1500))">Copy</button></div>`;
  } else if (on && d.mode === 'token') {
    // Token tunnels are remotely-managed — the hostname lives in your Cloudflare
    // dashboard, so there's no local URL to show, just the connected state.
    urlHtml = `<div style="font-size:12px;color:var(--green);margin-top:8px">Connected — your tunnel is live at your Cloudflare domain.</div>`;
  } else if (on) {
    urlHtml = `<div style="font-size:12px;color:var(--text-3);margin-top:8px">Tunnel starting — the public URL appears here in a few seconds.</div>`;
  }
  box.innerHTML = `
    <div class="toggle-row">
      <div class="toggle-row-text">Public URL (quick tunnel)
        <small>Installs cloudflared and serves LiteLayer at a free https://…trycloudflare.com address. No Cloudflare account needed. The URL changes if the tunnel restarts.</small>
      </div>
      <div class="toggle-sw ${quickOn ? 'on' : ''}" onclick="toggleCloudflareQuick(${quickOn})"></div>
    </div>
    ${urlHtml}
    <details class="cf-token" ${d.mode === 'token' ? 'open' : ''}>
      <summary>Use your own domain (Cloudflare token)</summary>
      <div style="font-size:12px;color:var(--text-3);margin:8px 0">Create a tunnel in the Cloudflare Zero Trust dashboard, copy its connector token, and paste it here for a stable custom domain.${d.mode === 'token' ? ' <b>Connected.</b>' : ''}</div>
      <div class="cf-token-row">
        <input id="cf-token-input" type="password" placeholder="eyJh…  (tunnel token)" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary btn-sm" onclick="connectCloudflareToken()">Connect</button>
      </div>
    </details>`;
}

async function toggleCloudflareQuick(isOn) {
  if (isOn) {
    if (!confirm('Turn off the Cloudflare tunnel? The public URL will stop working.')) return;
    const r = await api('/api/system/cloudflare', {method: 'POST', body: JSON.stringify({action: 'disable'})});
    if (!r?.ok) { toast('Could not turn off the tunnel', 'error'); return; }
    toast('Cloudflare tunnel off', 'success'); _loadCloudflare(); return;
  }
  const r = await api('/api/system/cloudflare', {method: 'POST', body: JSON.stringify({action: 'enable', mode: 'quick'})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not start the tunnel', 'error', 5000); return; }
  toast('Starting Cloudflare tunnel — fetching your public URL…', 'info', 4000);
  _cfPoll();
}

async function connectCloudflareToken() {
  const t = (document.getElementById('cf-token-input')?.value || '').trim();
  if (!t) { toast('Paste your Cloudflare tunnel token first', 'error'); return; }
  const r = await api('/api/system/cloudflare', {method: 'POST', body: JSON.stringify({action: 'enable', mode: 'token', token: t})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Could not connect', 'error', 6000); return; }
  toast('Connecting your domain via Cloudflare…', 'info', 4000);
  _cfPoll();
}

// Poll until the public URL is up (or the worker reports an error). The first
// enable also downloads + installs cloudflared, so give it up to ~2 min.
function _cfPoll(n = 0) {
  if (n > 40) { _loadCloudflare(); return; }
  setTimeout(async () => {
    try {
      const r = await api('/api/system/cloudflare', {bg: true});
      const d = r?.ok ? await r.json() : null;
      const s = await api('/api/system/vpn/status', {bg: true}).then(x => x?.ok ? x.json() : null).catch(() => null);
      if (s?.error) { toast(s.error, 'error', 7000); _loadCloudflare(); return; }
      // Quick mode needs the URL; token mode is "done" once the unit is active.
      if (d?.active && (d.url || d.mode === 'token')) { _loadCloudflare(); toast(d.url ? 'Public URL ready' : 'Cloudflare tunnel connected', 'success'); return; }
    } catch {}
    _cfPoll(n + 1);
  }, 3000);
}

async function switchVpn(name) {
  if (!confirm(`Switch to ${name}? This turns any other VPN off.`)) return;
  const r = await api('/api/system/vpn/switch', {method: 'POST', body: JSON.stringify({name})});
  if (!r?.ok) { const d = await r.json().catch(() => ({})); toast(d.detail || 'Could not switch VPN', 'error', 5000); return; }
  toast(`Switched to ${name}`, 'success'); _loadSystem();
}

async function toggleAutoMount() {
  const sw = document.getElementById('auto-mount-sw');
  const enabled = !sw.classList.contains('on');
  const r = await api('/api/drives/auto-mount', {method: 'POST', body: JSON.stringify({enabled})});
  if (!r?.ok) { toast('Failed to update setting', 'error'); return; }
  sw.classList.toggle('on', enabled);
  toast(enabled ? 'Drives will stay mounted' : 'Auto-mount off', 'success', 2500);
  loadDrives();
}

// Resource pills in the top bar — show/hide preference (default shown).
function applyStatsPillsPref() {
  const el = document.getElementById('stat-pills');
  if (el) el.style.display = localStorage.getItem('ll-hide-stats') === '1' ? 'none' : '';
}

function toggleStatsPills() {
  const sw = document.getElementById('stats-pills-sw');
  const show = !sw.classList.contains('on');      // "on" = pills shown
  sw.classList.toggle('on', show);
  localStorage.setItem('ll-hide-stats', show ? '0' : '1');
  applyStatsPillsPref();
  toast(show ? 'Resource pills shown' : 'Resource pills hidden', 'success', 2000);
}

function toggleFolderTree() {
  const sw = document.getElementById('folder-tree-sw');
  const on = !sw.classList.contains('on');
  sw.classList.toggle('on', on);
  localStorage.setItem('ll-folder-tree', on ? '1' : '0');
  loadDrives();   // re-render the sidebar with/without trees
  toast(on ? 'Folder tree shown' : 'Folder tree hidden', 'success', 2000);
}

function toggleSingleClick() {
  const sw = document.getElementById('single-click-sw');
  const on = !sw.classList.contains('on');
  sw.classList.toggle('on', on);
  localStorage.setItem('ll-single-click', on ? '1' : '0');
  toast(on ? 'Single-click to open' : 'Double-click to open', 'success', 2000);
}

// Promise-based masked password prompt (re-enabling terminal, sensitive actions).
// Resolves with the typed password, or null if cancelled.
function askPassword(title, msg) {
  return new Promise(resolve => {
    const modal = document.getElementById('pw-modal');
    const input = document.getElementById('pw-modal-input');
    const err   = document.getElementById('pw-modal-error');
    const ok    = document.getElementById('pw-modal-confirm');
    document.getElementById('pw-modal-title').textContent = title || 'Confirm password';
    document.getElementById('pw-modal-msg').textContent   = msg || 'Enter your password to continue.';
    input.value = ''; err.style.display = 'none';
    show('pw-modal'); setTimeout(() => input.focus(), 50);

    let done = false;
    const finish = val => { if (done) return; done = true; cleanup(); hide('pw-modal'); resolve(val); };
    const onOk = () => { if (!input.value) { err.textContent = 'Password required.'; err.style.display = 'block'; return; } finish(input.value); };
    const onKey = e => { if (e.key === 'Enter') onOk(); else if (e.key === 'Escape') finish(null); };
    const onX = () => finish(null);
    function cleanup() {
      ok.removeEventListener('click', onOk);
      input.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBackdrop);
    }
    const onBackdrop = e => { if (e.target === modal) finish(null); };
    ok.addEventListener('click', onOk);
    input.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBackdrop);
    window._pwModalCancel = onX;  // close button hook
  });
}
function closePwModal() { if (window._pwModalCancel) window._pwModalCancel(); else hide('pw-modal'); }

async function toggleTerminal() {
  const sw = document.getElementById('terminal-sw');
  const enable = !sw.classList.contains('on');
  let password = null;
  if (enable) {
    password = await askPassword('Re-enable terminal', 'The terminal is a root shell. Enter your password to turn it back on.');
    if (password == null) return;  // cancelled
  } else {
    if (!confirm('Disable the Pi terminal? The shell will be turned off until you re-enable it with your password.')) return;
  }
  const r = await api('/api/system/terminal/toggle', {method: 'POST', body: JSON.stringify({enabled: enable, password})});
  if (!r?.ok) { const d = await r.json().catch(() => ({})); toast(d.detail || 'Could not change terminal setting', 'error', 4000); return; }
  sw.classList.toggle('on', enable);
  toast(enable ? 'Terminal enabled' : 'Terminal disabled', 'success', 2500);
}

async function toggleBootDrive() {
  const sw = document.getElementById('boot-drive-sw');
  const enabled = !sw.classList.contains('on');
  if (enabled && !confirm('Show the boot/system drive with full read-write access?\n\nEditing system files can break the Pi. Continue?')) return;
  const r = await api('/api/system/boot-drive', {method: 'POST', body: JSON.stringify({enabled})});
  if (!r?.ok) { toast('Failed to toggle boot drive', 'error'); return; }
  sw.classList.toggle('on', enabled);
  localStorage.setItem('ll-boot-drive', enabled ? '1' : '0');
  toast(enabled ? 'Boot drive shown' : 'Boot drive hidden', 'success', 2500);
  loadDrives();
}

async function resetPi() {
  if (!confirm('Reset LiteLayer and reinstall the latest version?\n\nThe Pi will reboot and may be offline for a few minutes.')) return;
  const password = await askPassword('Confirm reset', 'Enter your password to reset & reinstall LiteLayer.');
  if (password == null) return;  // cancelled
  const r = await api('/api/system/reset', {method: 'POST', body: JSON.stringify({password})});
  if (!r?.ok) { const d = await r.json().catch(() => ({})); toast(d.detail || 'Reset failed to start', 'error', 8000); return; }
  // Kick the user out behind a full-screen loader; reload once the Pi is back.
  authToken = null; try { localStorage.removeItem('ll-token'); } catch {}
  closeSettings();
  document.getElementById('reset-overlay')?.classList.remove('hidden');
  _waitForRebootThenReload();
}

function _waitForRebootThenReload() {
  let wentDown = false, tries = 0;
  const status = document.getElementById('reset-status');
  const tick = setInterval(async () => {
    tries++;
    try {
      const r = await fetch(`${API}/api/ota/status`, {cache: 'no-store'});
      if (wentDown && r) {  // back online after a reboot → reload to the login page
        clearInterval(tick); window.location.reload(); return;
      }
    } catch {
      wentDown = true;  // connection dropped = the Pi is rebooting
      if (status) status.textContent = 'The Pi is rebooting… reconnecting automatically when it comes back.';
    }
    if (tries > 150) { clearInterval(tick); window.location.reload(); }  // ~5 min hard stop
  }, 2000);
}

// ── Photo Inbox tab ───────────────────────────────────────────────────────────

let _piCfg = null, _piAiPoll = null;

async function _loadPhotos() {
  const r = await api('/api/photos/config');
  if (!r?.ok) return;
  _piCfg = await r.json();
  document.getElementById('pi-enabled-sw').classList.toggle('on', _piCfg.enabled);
  document.getElementById('pi-ai-sw').classList.toggle('on', _piCfg.ai_enabled);
  document.getElementById('pi-host').value = _piCfg.imap_host || '';
  document.getElementById('pi-port').value = _piCfg.imap_port || 993;
  document.getElementById('pi-user').value = _piCfg.imap_user || '';
  const pw = document.getElementById('pi-pass');
  pw.value = ''; pw.placeholder = _piCfg.password_set ? '•••••••• (saved — type to replace)' : 'App password';
  document.getElementById('pi-senders').value = (_piCfg.allowed_senders || []).join(', ');
  document.getElementById('pi-path').value = _piCfg.path || '/Photos';

  // Destination drive dropdown — mounted drives only, boot drive excluded.
  const dr = await api('/api/drives');
  const drives = dr?.ok ? (await dr.json()).filter(d => d.id !== 'system-root') : [];
  document.getElementById('pi-drive').innerHTML =
    `<option value="">— pick a drive —</option>` + drives.map(d =>
      `<option value="${esc(d.id)}"${d.id === _piCfg.drive ? ' selected' : ''}>${esc(d.label)} (${esc(d.fstype)})</option>`).join('');

  renderPiCats();
  _refreshPhotoStatus();
}

function renderPiCats() {
  const box = document.getElementById('pi-cats');
  const cats = _piCfg.categories || [];
  box.innerHTML = cats.map((c, i) => `
    <div class="pi-cat-row">
      <input type="text" value="${esc(c.name)}" placeholder="Folder name" oninput="_piCfg.categories[${i}].name=this.value" style="flex:1">
      <input type="text" value="${esc(c.hint)}" placeholder="What goes here? e.g. receipts and documents" oninput="_piCfg.categories[${i}].hint=this.value" style="flex:2">
      <button class="icon-btn" title="Remove" onclick="_piCfg.categories.splice(${i},1);renderPiCats()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>`).join('') || `<div style="font-size:12px;color:var(--text-3)">No folders yet — add one, e.g. “Family”, “Screenshots”, “Receipts”.</div>`;
}

function addPiCat() {
  (_piCfg.categories = _piCfg.categories || []).push({name: '', hint: ''});
  renderPiCats();
  const inputs = document.querySelectorAll('#pi-cats .pi-cat-row input');
  inputs[inputs.length - 2]?.focus();
}

function _piCollect() {
  return {
    imap_host: document.getElementById('pi-host').value.trim(),
    imap_port: parseInt(document.getElementById('pi-port').value) || 993,
    imap_user: document.getElementById('pi-user').value.trim(),
    imap_password: document.getElementById('pi-pass').value,   // blank = keep saved
    allowed_senders: document.getElementById('pi-senders').value.split(',').map(s => s.trim()).filter(Boolean),
    drive: document.getElementById('pi-drive').value,
    path: document.getElementById('pi-path').value.trim() || '/Photos',
    categories: (_piCfg.categories || []).filter(c => c.name.trim()),
  };
}

async function savePhotoInbox() {
  const btn = document.getElementById('pi-save-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/photos/config', {method: 'PUT', body: JSON.stringify(_piCollect())});
    if (!r?.ok) { const e = await r?.json().catch(() => ({})); toast(e.detail || 'Could not save', 'error', 4000); return; }
    toast('Photo Inbox saved', 'success');
    _loadPhotos();
  } finally { btn.disabled = false; }
}

async function togglePhotoInbox() {
  const sw = document.getElementById('pi-enabled-sw');
  const enabling = !sw.classList.contains('on');
  if (enabling && !(_piCfg?.imap_user && (_piCfg?.password_set || document.getElementById('pi-pass').value))) {
    toast('Set up the mailbox below first, then turn this on', 'info', 4000); return;
  }
  const r = await api('/api/photos/config', {method: 'PUT', body: JSON.stringify({enabled: enabling, ..._piCollect()})});
  if (!r?.ok) { toast('Could not change setting', 'error'); return; }
  _piCfg = await r.json();
  sw.classList.toggle('on', enabling);
  toast(enabling ? 'Photo Inbox on — checking your mail' : 'Photo Inbox off', 'success', 2500);
  if (enabling) setTimeout(_refreshPhotoStatus, 4000);
}

async function togglePhotoAI() {
  const sw = document.getElementById('pi-ai-sw');
  const enabling = !sw.classList.contains('on');
  const r = await api('/api/photos/config', {method: 'PUT', body: JSON.stringify({ai_enabled: enabling})});
  if (!r?.ok) { toast('Could not change setting', 'error'); return; }
  sw.classList.toggle('on', enabling);
  _piCfg.ai_enabled = enabling;
  _refreshPhotoStatus();   // shows the "install the model" button if it's missing
}

async function testPhotoEmail() {
  const c = _piCollect();
  toast('Testing sign-in…', 'info', 2000);
  const r = await api('/api/photos/test', {method: 'POST', body: JSON.stringify({
    imap_host: c.imap_host, imap_port: c.imap_port, imap_user: c.imap_user, imap_password: c.imap_password,
  })});
  if (r?.ok) { const d = await r.json(); toast(`Signed in ✓ — ${d.unseen} unread message${d.unseen !== 1 ? 's' : ''} waiting`, 'success', 4000); }
  else { const e = await r?.json().catch(() => ({})); toast(e.detail || 'Sign-in failed', 'error', 6000); }
}

async function pollPhotosNow() {
  await api('/api/photos/poll', {method: 'POST'});
  toast('Checking your mailbox…', 'info', 2500);
  setTimeout(_refreshPhotoStatus, 4000);
}

async function setupPhotoAI() {
  const r = await api('/api/photos/ai/setup', {method: 'POST'});
  if (!r?.ok) { const e = await r?.json().catch(() => ({})); toast(e.detail || 'Could not start setup', 'error'); return; }
  toast('Downloading the model — a few minutes on Pi Wi-Fi', 'info', 4000);
  clearInterval(_piAiPoll);
  _piAiPoll = setInterval(async () => {
    const ok = await _refreshPhotoStatus();
    if (ok?.ai && !ok.ai.installing) {
      clearInterval(_piAiPoll); _piAiPoll = null;
      toast(ok.ai.ready ? 'AI model ready' : (ok.ai.error || 'Setup failed'), ok.ai.ready ? 'success' : 'error', 5000);
    }
  }, 2500);
}

async function _refreshPhotoStatus() {
  const r = await api('/api/photos/status', {bg: true});
  if (!r?.ok) return null;
  const s = await r.json();

  const line = document.getElementById('pi-status-line');
  if (line) {
    const bits = [];
    if (s.last_check) bits.push(`last check ${fmtRelative(new Date(s.last_check * 1000).toISOString())}`);
    if (s.saved) bits.push(`${s.saved} photo${s.saved !== 1 ? 's' : ''} saved`);
    if (s.last_error) bits.push(`⚠ ${s.last_error}`);
    line.textContent = bits.join(' · ');
    line.style.color = s.last_error ? 'var(--red)' : 'var(--text-3)';
  }

  const ai = document.getElementById('pi-ai-box');
  if (ai) {
    if (s.ai.ready) {
      ai.innerHTML = `<div class="pi-ai-status ok">✓ Model installed and ready — CLIP ViT-B/32 (quantized), running on the Pi's CPU</div>`;
    } else if (s.ai.installing) {
      const pct = Math.round((s.ai.progress || 0) * 100);
      ai.innerHTML = `<div class="pi-ai-status">${esc(s.ai.step || 'Setting up…')}</div>
        <div class="ota-bar-track"><div class="ota-bar-fill" style="width:${pct}%"></div></div>`;
      if (!_piAiPoll) setupPhotoAIPollOnly();
    } else {
      ai.innerHTML = `<div class="pi-ai-status">${s.ai.error ? `⚠ ${esc(s.ai.error)}` : 'The model isn’t installed yet (~170 MB, one time).'}</div>
        <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="setupPhotoAI()">${s.ai.error ? 'Retry install' : 'Install AI model'}</button>`;
    }
  }

  const rec = document.getElementById('pi-recent');
  if (rec) {
    rec.innerHTML = (s.recent || []).map(x =>
      `<div class="pi-recent-row"><span class="pi-recent-name">${esc(x.name)}</span>
        <span class="pi-recent-folder">${x.folder ? '→ ' + esc(x.folder) : ''}</span>
        <span class="pi-recent-ts">${fmtRelative(new Date(x.ts * 1000).toISOString())}</span></div>`
    ).join('') || 'Nothing yet — email a photo to your inbox address and it appears here.';
  }
  return s;
}

// Resume polling an install that was already running when the tab opened.
function setupPhotoAIPollOnly() {
  clearInterval(_piAiPoll);
  _piAiPoll = setInterval(async () => {
    const s = await _refreshPhotoStatus();
    if (s?.ai && !s.ai.installing) { clearInterval(_piAiPoll); _piAiPoll = null; }
  }, 2500);
}

// ── Color pickers ─────────────────────────────────────────────────────────────

function buildColorPickers() {
  const grid = document.getElementById('color-pickers-grid');
  if (!grid) return;
  const saved   = JSON.parse(localStorage.getItem('ll-custom-colors') || '{}');
  const defs    = _COLOR_DEFAULTS[_currentTheme] || _COLOR_DEFAULTS.dark;
  let lastGroup = '';
  grid.innerHTML = COLOR_VARS.map(({key, label, group}) => {
    const val = saved[key] || document.documentElement.style.getPropertyValue(key) || defs[key] || '#000000';
    const groupHdr = group !== lastGroup ? `<div class="color-group-label">${esc(group)}</div>` : '';
    lastGroup = group;
    return `${groupHdr}<div class="color-picker-row">
      <span class="color-picker-label">${esc(label)}</span>
      <div class="color-picker-well">
        <input type="color" class="color-swatch-input" data-color-key="${esc(key)}" value="${val}" oninput="applyCustomColor('${esc(key)}',this.value)" title="${esc(key)}">
        <span class="color-picker-hex" onclick="this.previousElementSibling.click()">${val}</span>
      </div>
    </div>`;
  }).join('');

  // Keep hex readout in sync
  grid.querySelectorAll('.color-swatch-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const hex = inp.nextElementSibling;
      if (hex) hex.textContent = inp.value;
    });
  });
}

// ── About tab ─────────────────────────────────────────────────────────────────

async function _loadAbout() {
  const urlEl = document.getElementById('about-url');
  if (urlEl) urlEl.textContent = window.location.origin;

  const shaEl = document.getElementById('about-sha');
  if (shaEl && _otaData?.current_sha) shaEl.textContent = _otaData.current_sha;

  const vpnEl = document.getElementById('about-vpn');
  if (!vpnEl) return;
  try {
    const r = await api('/api/system/info');
    if (!r?.ok) { vpnEl.textContent = '—'; return; }
    const d = await r.json();
    const hn = document.getElementById('about-hostname');
    if (hn) hn.textContent = d.hostname && d.hostname !== 'unknown' ? `http://${d.hostname}.local` : '—';
    // Cloudflare Tunnel public URL — only shown when a tunnel is up.
    const cfRow = document.getElementById('about-cf-row'), cf = document.getElementById('about-cf');
    if (cfRow && cf) {
      if (d.cloudflare_domain) {
        const url = d.cloudflare_domain.startsWith('http') ? d.cloudflare_domain : `https://${d.cloudflare_domain}`;
        cf.textContent = d.cloudflare_domain; cf.href = url; cfRow.style.display = '';
      } else cfRow.style.display = 'none';
    }
    if (!d.vpns?.length) {
      vpnEl.textContent = 'None';
    } else {
      vpnEl.innerHTML = d.vpns.map(v =>
        `<span class="vpn-pill">${esc(v.name)}${v.ip ? ' · ' + esc(v.ip) : ''}</span>`
      ).join(' ');
    }
  } catch { vpnEl.textContent = '—'; }
}

// ── Account ───────────────────────────────────────────────────────────────────

async function saveSettings() {
  const cur  = document.getElementById('settings-cur-pass').value;
  const user = document.getElementById('settings-new-user').value.trim();
  const pass = document.getElementById('settings-new-pass').value;
  const conf = document.getElementById('settings-conf-pass').value;
  const err  = document.getElementById('settings-error'), btn = document.getElementById('settings-save-btn');
  err.style.display = 'none';
  if (!cur)  { err.textContent = 'Current password is required.'; err.style.display = 'block'; return; }
  if (pass && pass !== conf) { err.textContent = 'New passwords do not match.'; err.style.display = 'block'; return; }
  if (pass && pass.length < 8) { err.textContent = 'New password must be at least 8 characters.'; err.style.display = 'block'; return; }
  if (!user && !pass) { err.textContent = 'Nothing to change.'; err.style.display = 'block'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
  try {
    const r = await api('/api/auth/update-credentials', {method:'POST', body: JSON.stringify({current_password:cur, new_username:user||null, new_password:pass||null})});
    const d = await r.json(); if (!r.ok) throw new Error(d.detail || 'Failed');
    closeSettings();
    if (d.relogin_required) { toast('Username changed — please sign in again', 'info', 3000); setTimeout(() => { authToken = null; showLogin(); }, 1500); }
    else { setUser(user || currentUsername); toast('Credentials updated', 'success'); }
  } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  finally { btn.disabled = false; btn.textContent = 'Save Changes'; }
}
