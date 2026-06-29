let _settingsTab = 'appearance';

function openSettings() {
  buildColorPickers();
  applyTheme(_currentTheme);
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
  ['appearance','account','about','system'].forEach(t => {
    document.getElementById(`stab-${t}`)?.classList.toggle('hidden', t !== tab);
    document.getElementById(`snav-${t}`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'about')   _loadAbout();
  if (tab === 'system')  _loadSystem();
}

// ── System tab ─────────────────────────────────────────────────────────────────

async function _loadSystem() {
  document.getElementById('boot-drive-sw')?.classList.toggle('on', localStorage.getItem('ll-boot-drive') === '1');
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

// Poll until the public URL is up (or the worker reports an error).
function _cfPoll(n = 0) {
  if (n > 12) { _loadCloudflare(); return; }
  setTimeout(async () => {
    try {
      const r = await api('/api/system/cloudflare', {bg: true});
      const d = r?.ok ? await r.json() : null;
      const s = await api('/api/system/vpn/status', {bg: true}).then(x => x?.ok ? x.json() : null).catch(() => null);
      if (s?.error) { toast(s.error, 'error', 7000); _loadCloudflare(); return; }
      if (d?.active && d.url) { _loadCloudflare(); toast('Public URL ready', 'success'); return; }
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
