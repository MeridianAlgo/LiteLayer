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
  hide('view-login'); show('view-app'); startOtaPoll();
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
    const r = await fetch(API + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify({username, password})});
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'Login failed');
    authToken = data.token; setUser(username); showApp(); loadDrives();
  } catch (e) {
    err.textContent = e.message; err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

async function doLogout() {
  await api('/api/logout', {method: 'POST'});
  authToken = null; showLogin(); toast('Signed out', 'info', 2000);
}
