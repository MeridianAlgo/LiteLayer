// ── Pi terminal (xterm.js over a websocket PTY) ────────────────────────────────
// Lazy-loads xterm from a CDN (same pattern as the markdown/docx viewers), then
// bridges keystrokes <-> the /api/system/terminal websocket.
let _term = null, _termFit = null, _termWs = null, _termResizeHandler = null;

async function _loadXterm() {
  if (window.Terminal && window.FitAddon) return;
  if (!document.getElementById('xterm-css')) {
    const link = document.createElement('link');
    link.id = 'xterm-css'; link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css';
    document.head.appendChild(link);
  }
  const load = src => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  await load('https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js');
  await load('https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js');
}

async function openTerminal() {
  // Respect the on/off switch — don't even open the overlay when disabled.
  try {
    const r = await api('/api/system/terminal/status');
    if (r?.ok && !(await r.json()).enabled) {
      toast('Terminal is disabled. Enable it in Settings → System.', 'info', 3500); return;
    }
  } catch {}
  show('terminal-overlay'); document.body.style.overflow = 'hidden';
  const status = document.getElementById('term-status');
  status.textContent = 'Connecting…';
  try {
    await _loadXterm();
  } catch { status.textContent = 'Failed to load terminal'; toast('Could not load terminal', 'error'); return; }

  const body = document.getElementById('term-body');
  body.innerHTML = '';
  _term = new Terminal({fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace", fontSize: 13, cursorBlink: true,
                        theme: {background: '#0c0c12'}});
  _termFit = new FitAddon.FitAddon();
  _term.loadAddon(_termFit);
  _term.open(body);
  _termFit.fit();

  // ws:// or wss:// to the same host. Token rides in the query — browsers can't
  // set headers on a WebSocket.
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/api/system/terminal?token=${encodeURIComponent(authToken || '')}`;
  _termWs = new WebSocket(url);
  _termWs.binaryType = 'arraybuffer';

  _termWs.onopen = () => {
    status.textContent = 'Connected';
    document.getElementById('term-reconnect').style.display = 'none';
    _sendResize();
    _term.focus();
  };
  _termWs.onmessage = ev => {
    _term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  };
  _termWs.onclose = ev => {
    status.textContent = 'Disconnected';
    _term?.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n');
    // 4401 = the app session expired → re-sign in just for the terminal,
    // no need to log out of the whole app. Other closes → offer a reconnect.
    if (ev.code === 4401) _termReauth();
    else document.getElementById('term-reconnect').style.display = '';
  };
  _termWs.onerror = () => { status.textContent = 'Connection error'; };

  _term.onData(d => { if (_termWs?.readyState === 1) _termWs.send(d); });
  _termResizeHandler = () => { _termFit?.fit(); _sendResize(); };
  window.addEventListener('resize', _termResizeHandler);
}

// Session expired mid-terminal — re-authenticate without leaving the app.
async function _termReauth() {
  const status = document.getElementById('term-status');
  status.textContent = 'Session expired';
  const pw = await askPassword('Session expired', `Signed-in session timed out. Enter ${currentUsername}'s password to reconnect the terminal.`);
  if (pw == null) { document.getElementById('term-reconnect').style.display = ''; return; }
  try {
    const r = await fetch(API + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({username: currentUsername, password: pw})});
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || 'Login failed');
    authToken = d.token;
    openTerminal();   // reconnect with the fresh token
  } catch (e) {
    toast('Reconnect failed: ' + e.message, 'error', 4000);
    document.getElementById('term-reconnect').style.display = '';
  }
}

function reconnectTerminal() { openTerminal(); }

function _sendResize() {
  if (_termWs?.readyState === 1 && _term)
    _termWs.send(JSON.stringify({resize: [_term.cols, _term.rows]}));
}

function closeTerminal() {
  hide('terminal-overlay'); document.body.style.overflow = '';
  if (_termResizeHandler) { window.removeEventListener('resize', _termResizeHandler); _termResizeHandler = null; }
  try { _termWs?.close(); } catch {}
  try { _term?.dispose(); } catch {}
  _termWs = null; _term = null; _termFit = null;
}
