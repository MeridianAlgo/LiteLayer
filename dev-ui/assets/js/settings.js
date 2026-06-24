let _settingsTab = 'appearance';

function openSettings() {
  buildAccentGrid();
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

let _vpnPoll = null;

async function _loadSystem() {
  document.getElementById('boot-drive-sw')?.classList.toggle('on', localStorage.getItem('ll-boot-drive') === '1');
  const box = document.getElementById('vpn-list');
  if (!box) return;
  try {
    const r = await api('/api/system/vpns');
    if (!r?.ok) { box.innerHTML = `<div style="font-size:12px;color:var(--text-3)">Could not load VPNs</div>`; return; }
    const d = await r.json();
    const active = d.vpns.find(v => v.active);
    const cur = `<div class="vpn-current">Current VPN: <strong>${active ? esc(active.name) : 'None'}</strong></div>`;
    box.innerHTML = cur + d.vpns.map(v => {
      const state = v.active ? 'active' : v.installed ? (v.enabled ? 'enabled' : 'installed') : 'not installed';
      const useBtn = v.active
        ? `<button class="btn btn-ghost btn-xs" disabled>In use</button>`
        : v.installed
          ? `<button class="btn btn-ghost btn-xs" onclick="switchVpn('${esc(v.name)}')">Use this</button>`
          : `<button class="btn btn-primary btn-xs" onclick="installVpn('${esc(v.name)}')">Install &amp; sign in</button>`;
      const rmBtn = v.installed
        ? `<button class="btn btn-danger btn-xs" onclick="uninstallVpn('${esc(v.name)}')" title="Uninstall ${esc(v.name)}">Uninstall</button>` : '';
      return `<div class="vpn-row">
        <span class="vpn-row-name">${esc(v.name)}</span>
        <span class="vpn-row-badge${v.active ? ' active' : ''}">${state}</span>
        ${useBtn}${rmBtn}
      </div>${_vpnClientHelp(v.name)}`;
    }).join('') + `<div id="vpn-error" class="vpn-error" style="display:none"></div><div id="vpn-progress"></div>`;
  } catch { box.innerHTML = `<div style="font-size:12px;color:var(--text-3)">Could not load VPNs</div>`; }
}

// Per-VPN: download link for your own computer + any setup notes.
const _VPN_CLIENT = {
  'Tailscale': 'https://tailscale.com/download',
  'WireGuard': 'https://www.wireguard.com/install/',
  'ZeroTier':  'https://www.zerotier.com/download/',
};
function _vpnClientHelp(name) {
  const url = _VPN_CLIENT[name];
  let html = url ? `<a class="vpn-help-link" href="${url}" target="_blank" rel="noopener">Download ${esc(name)} for your computer →</a>` : '';
  if (name === 'ZeroTier') {
    html += `<div class="vpn-help-note">Authorizing your devices in ZeroTier:
      <ol style="margin:6px 0 0 16px;padding:0">
        <li>Install ZeroTier on your laptop, then <b>Join Network</b> using the same network ID this Pi joined.</li>
        <li>Open <a href="https://my.zerotier.com/network" target="_blank" rel="noopener">my.zerotier.com</a> → your network → <b>Members</b>.</li>
        <li>Tick the <b>Auth?</b> checkbox next to both the Pi and your laptop so they can talk.</li>
        <li>Use the Pi's ZeroTier IP (shown under Members, e.g. <code>10.147.x.x</code>) to reach LiteLayer — <code>.local</code> names don't cross ZeroTier.</li>
      </ol></div>`;
  }
  return html;
}

// Persistent, dismissable error panel for VPN ops (toasts vanish too fast to read).
function _showVpnError(msg) {
  const el = document.getElementById('vpn-error');
  if (!el) { toast(msg, 'error', 15000); return; }
  el.style.display = '';
  el.innerHTML = `<div class="vpn-error-msg">${esc(msg)}</div><button class="btn btn-ghost btn-xs" onclick="document.getElementById('vpn-error').style.display='none'">Dismiss</button>`;
}

async function uninstallVpn(name) {
  if (!confirm(`Uninstall ${name} from this Pi? This removes the VPN software.`)) return;
  const r = await api('/api/system/vpn/uninstall', {method: 'POST', body: JSON.stringify({name})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); _showVpnError(e.detail || 'Uninstall failed to start'); return; }
  toast(`Uninstalling ${name}…`, 'info', 4000);
  _pollVpnInstall();
}

async function installVpn(name) {
  let networkId = null;
  if (name === 'ZeroTier') {
    networkId = prompt('ZeroTier network ID to join (leave blank to join later):') || null;
  }
  if (!confirm(`Install ${name} on this device and switch to it now?\n\nThis turns off any other VPN once it's connected.`)) return;
  const r = await api('/api/system/vpn/install', {method: 'POST', body: JSON.stringify({name, network_id: networkId})});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); _showVpnError(e.detail || 'Install failed to start'); return; }
  toast(`Installing ${name}…`, 'info', 3000);
  _pollVpnInstall();
}

function _pollVpnInstall() {
  if (_vpnPoll) clearInterval(_vpnPoll);
  const prog = () => document.getElementById('vpn-progress');
  _vpnPoll = setInterval(async () => {
    const r = await api('/api/system/vpn/status');
    if (!r?.ok) return;
    const s = await r.json();
    const box = prog();
    if (box) {
      let html = s.running ? `<div class="vpn-installing"><span class="spinner" style="width:13px;height:13px;border-width:2px"></span> Working on ${esc(s.name || '')}…</div>` : '';
      if (s.auth_url) html += `<a class="btn btn-primary btn-xs" href="${esc(s.auth_url)}" target="_blank" rel="noopener" style="margin-top:8px">Sign in to ${esc(s.name || 'VPN')} →</a>`;
      box.innerHTML = html;
    }
    if (s.error) _showVpnError(s.error);   // persistent — doesn't vanish
    if (!s.running) {
      clearInterval(_vpnPoll); _vpnPoll = null;
      if (!s.error) toast('Done' + (s.auth_url ? ' — finish sign-in via the link' : ''), 'success', 6000);
      const url = s.auth_url, nm = s.name, zt = s.zt_node;
      await _loadSystem();
      const b = prog();
      if (b) {
        let h = '';
        if (url) h += `<a class="btn btn-primary btn-xs" href="${esc(url)}" target="_blank" rel="noopener">Sign in to ${esc(nm || 'VPN')} →</a>`;
        if (zt && nm === 'ZeroTier') h += `<div class="vpn-current" style="margin-top:8px">This Pi's ZeroTier node: <strong>${esc(zt)}</strong> — install ZeroTier on your laptop and join the same network.</div>`;
        b.innerHTML = h;
      }
    }
  }, 2500);
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

async function switchVpn(name) {
  if (!confirm(`Make ${name} the active VPN now?`)) return;
  const r = await api('/api/system/vpn/switch', {method: 'POST', body: JSON.stringify({name})});
  if (!r?.ok) { const d = await r.json().catch(() => ({})); _showVpnError(d.detail || 'Switch failed'); return; }
  toast(`${name} is now active`, 'success', 5000);
  _loadSystem();
}

async function resetPi() {
  if (!confirm('Reset LiteLayer and reinstall the latest version?\n\nThe Pi will reboot and may be offline for a few minutes.')) return;
  if (!confirm('Are you sure? This re-runs the full installer from scratch.')) return;
  const r = await api('/api/system/reset', {method: 'POST'});
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
