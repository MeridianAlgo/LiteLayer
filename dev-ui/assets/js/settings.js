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
  ['appearance','account','about','updates'].forEach(t => {
    document.getElementById(`stab-${t}`)?.classList.toggle('hidden', t !== tab);
    document.getElementById(`snav-${t}`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'updates') loadChangelog();
  if (tab === 'about')   _loadAbout();
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
