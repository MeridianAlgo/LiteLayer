let _settingsTab = 'appearance';

function openSettings() {
  buildAccentGrid();
  applyTheme(_currentTheme);
  document.getElementById('settings-username-display').textContent = currentUsername;
  ['settings-cur-pass','settings-new-user','settings-new-pass','settings-conf-pass'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('settings-error').style.display = 'none';
  if (_otaData) updateVersionChip(_otaData);
  setSettingsTab('appearance');
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
}

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
