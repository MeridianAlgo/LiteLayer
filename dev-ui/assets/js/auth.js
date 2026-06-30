async function checkAuth() {
  try {
    const r = await fetch(API + '/api/me', {credentials: 'include'});
    if (r.ok) {
      const d = await r.json();
      setUser(d.username); showApp(); loadDrives(); return;
    }
  } catch {}
  showLogin();
}

function setUser(u) {
  currentUsername = u;
  document.getElementById('settings-username-display').textContent = u;
}

function showLogin() {
  hide('view-app'); show('view-login');
  setTimeout(() => document.getElementById('login-user').focus(), 50);
}

function showApp() {
  hide('view-login'); show('view-app'); startOtaPoll(); startStatsPoll();
  pullSettings();   // pull this account's synced theme/look from the Pi
  applyStatsPillsPref();
  // Re-apply boot-drive visibility (backend flag resets on restart)
  if (localStorage.getItem('ll-boot-drive') === '1') {
    api('/api/system/boot-drive', {method: 'POST', body: JSON.stringify({enabled: true})}).catch(() => {});
  }
}

document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-user').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-pass').focus(); });

async function doLogin() {
  const btn = document.getElementById('login-btn'), err = document.getElementById('login-error');
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  if (!username || !password) { err.textContent = 'Enter username and password.'; err.style.display = 'block'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…'; err.style.display = 'none';
  try {
    let code = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = JSON.stringify(code == null ? {username, password} : {username, password, code});
      const r = await fetch(API + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body});
      const data = await r.json();
      if (r.ok) { authToken = data.token; setUser(username); showApp(); loadDrives(); return; }
      if (data.detail === '2fa_required' || (code != null && data.detail === 'Invalid 2FA code')) {
        code = prompt(data.detail === 'Invalid 2FA code' ? 'That code was wrong — enter the current 6-digit code:' : 'Enter your 6-digit authentication code:');
        if (code == null) break;          // cancelled
        continue;                          // resubmit with the code
      }
      throw new Error(data.detail || 'Login failed');
    }
    err.textContent = 'Sign-in cancelled.'; err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign In';
  } catch (e) {
    err.textContent = e.message; err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

async function doLogout() {
  try { await api('/api/logout', {method: 'POST'}); } catch {}
  authToken = null;
  // Hard reload → guarantees a fresh, wired-up login page (the in-place
  // showLogin() left the Sign In button dead).
  location.reload();
}
