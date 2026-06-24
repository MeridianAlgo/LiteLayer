let _cmdFocused = -1, _cmdResults = [];
const CMD_RECENT_KEY = 'll-cmd-recent';

function openCmdPalette() {
  show('cmd-palette');
  const input = document.getElementById('cmd-input');
  input.value = ''; _cmdFocused = -1; _cmdResults = [];
  renderCmdResults('');
  requestAnimationFrame(() => input.focus());
}

function closeCmdPalette() { hide('cmd-palette'); _cmdFocused = -1; }

function _cmdKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeCmdPalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); _cmdFocused = Math.min(_cmdFocused + 1, _cmdResults.length - 1); _renderCmdFocus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); _cmdFocused = Math.max(_cmdFocused - 1, 0); _renderCmdFocus(); }
  else if (e.key === 'Enter') { e.preventDefault(); _cmdActivate(_cmdFocused >= 0 ? _cmdFocused : 0); }
}

function _renderCmdFocus() {
  document.querySelectorAll('.cmd-result-item').forEach((el, i) => el.classList.toggle('focused', i === _cmdFocused));
}

function _cmdActivate(i) {
  const item = _cmdResults[i]; if (!item) return;
  closeCmdPalette();
  if (item.type === 'dir') { openDir(item.path, item.name); }
  else if (item.type === 'file') {
    const idx = dirEntries.findIndex(e => e.path === item.path);
    if (idx >= 0) handleFileClick(idx, {});
  } else if (item.type === 'recent') {
    const sep = item.path.indexOf(':');
    const driveId = item.path.slice(0, sep), path = item.path.slice(sep + 1);
    if (driveId === currentDriveId) openDir(path, path.split('/').pop() || '/');
  }
  _saveCmdRecent(item);
}

function _saveCmdRecent(item) {
  if (item.type === 'recent') return;
  try {
    const key = `${currentDriveId}:${item.path}`;
    const arr = JSON.parse(localStorage.getItem(CMD_RECENT_KEY) || '[]');
    localStorage.setItem(CMD_RECENT_KEY, JSON.stringify([key, ...arr.filter(x => x !== key)].slice(0, 10)));
  } catch {}
}

function renderCmdResults(q) {
  const box = document.getElementById('cmd-results');
  const input = q.trim(); _cmdResults = [];

  if (input.startsWith('/')) {
    _cmdResults = [{type:'dir', path:input, name:input}];
    _cmdFocused = 0;
    box.innerHTML = `<div class="cmd-path-hint">Navigate to: ${esc(input)}</div>
      <div class="cmd-result-item focused" onclick="_cmdActivate(0)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        <span class="cmd-result-name">${esc(input)}</span><span class="cmd-result-path">Go to path</span>
      </div>`;
    return;
  }

  const lq = input.toLowerCase();
  if (currentDriveId && dirEntries.length) {
    dirEntries.filter(e => !lq || e.name.toLowerCase().includes(lq)).slice(0, 10).forEach(e => {
      _cmdResults.push({type: e.is_dir ? 'dir' : 'file', path: e.path, name: e.name, size: e.is_dir ? null : e.size_bytes});
    });
  }

  if (!_cmdResults.length && !lq) {
    try {
      const arr = JSON.parse(localStorage.getItem(CMD_RECENT_KEY) || '[]');
      if (!arr.length) { box.innerHTML = `<div class="cmd-empty">Type to search files, or / to navigate</div>`; return; }
      _cmdResults = arr.slice(0, 6).map(raw => {
        const sep = raw.indexOf(':'); return {type:'recent', path:raw, name:raw.slice(sep + 1).split('/').pop() || '/'};
      });
      _cmdFocused = 0;
      box.innerHTML = `<div class="cmd-section-label">Recent</div>` + _cmdResults.map((r, i) => `
        <div class="cmd-result-item${i === 0 ? ' focused' : ''}" onclick="_cmdActivate(${i})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.29-5.36"/></svg>
          <span class="cmd-result-name">${esc(r.name)}</span><span class="cmd-result-path">${esc(r.path.slice(r.path.indexOf(':') + 1))}</span>
        </div>`).join('');
    } catch { box.innerHTML = `<div class="cmd-empty">Type to search</div>`; }
    return;
  }

  if (!_cmdResults.length) { box.innerHTML = `<div class="cmd-empty">No results for "${esc(lq)}"</div>`; _cmdFocused = -1; return; }

  _cmdFocused = 0;
  const dirIcon  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;
  const fileIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  box.innerHTML = (lq ? '<div class="cmd-section-label">Results</div>' : '') + _cmdResults.map((r, i) => `
    <div class="cmd-result-item${i === 0 ? ' focused' : ''}" onclick="_cmdActivate(${i})">
      ${r.type === 'dir' ? dirIcon : fileIcon}
      <span class="cmd-result-name">${esc(r.name)}</span>
      <span class="cmd-result-path">${r.size != null ? fmt(r.size) : ''}</span>
    </div>`).join('');
}
