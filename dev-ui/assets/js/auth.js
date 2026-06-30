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
      if (r.ok) { hide('twofa-modal'); authToken = data.token; setUser(username); showApp(); loadDrives(); return; }
      if (data.detail === '2fa_required' || (code != null && data.detail === 'Invalid 2FA code')) {
        attempt = 0;  // 2FA retries don't count against the password attempt budget
        code = await askTwoFactor(data.detail === 'Invalid 2FA code' ? 'That code was wrong — try the current one.' : '');
        if (code == null) break;          // cancelled
        continue;                          // resubmit with the code
      }
      throw new Error(data.detail || 'Login failed');
    }
    hide('twofa-modal');
    err.textContent = 'Sign-in cancelled.'; err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign In';
  } catch (e) {
    hide('twofa-modal');
    err.textContent = e.message; err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

// Promise-based 6-digit 2FA prompt. Resolves with the code, or null if cancelled.
// Auto-submits once 6 digits are entered.
function askTwoFactor(errorMsg) {
  return new Promise(resolve => {
    const modal = document.getElementById('twofa-modal');
    const input = document.getElementById('twofa-input');
    const err   = document.getElementById('twofa-error');
    const ok    = document.getElementById('twofa-verify');
    const cancel = document.getElementById('twofa-cancel');
    input.value = '';
    err.textContent = errorMsg || ''; err.style.display = errorMsg ? 'block' : 'none';
    show('twofa-modal'); setTimeout(() => input.focus(), 50);

    let done = false;
    const finish = val => { if (done) return; done = true; cleanup(); resolve(val); };
    const submit = () => { const c = input.value.trim(); if (c.length === 6) finish(c); };
    const onInput = () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); if (input.value.length === 6) submit(); };
    const onKey = e => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') finish(null); };
    const onCancel = () => finish(null);
    const onBackdrop = e => { if (e.target === modal) finish(null); };
    function cleanup() {
      ok.removeEventListener('click', submit);
      cancel.removeEventListener('click', onCancel);
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBackdrop);
    }
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', onCancel);
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBackdrop);
  });
}

async function doLogout() {
  try { await api('/api/logout', {method: 'POST'}); } catch {}
  authToken = null;
  // Hard reload → guarantees a fresh, wired-up login page (the in-place
  // showLogin() left the Sign In button dead).
  location.reload();
}
