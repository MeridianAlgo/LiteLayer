// ── Thumbnails ────────────────────────────────────────────────────────────────

const _thumbCache = new Map();
let _thumbObserver = null;

function _initThumbObserver() {
  if (_thumbObserver) return;
  _thumbObserver = new IntersectionObserver(entries => {
    entries.filter(e => e.isIntersecting).forEach(e => {
      const cell = e.target, src = cell.dataset.previewSrc;
      if (!src || cell.dataset.thumbLoaded) return;
      cell.dataset.thumbLoaded = '1'; _thumbObserver.unobserve(cell);
      const cached = _thumbCache.get(src);
      if (cached) { _applyThumb(cell, cached); return; }
      fetch(src, {headers: authToken ? {Authorization:`Bearer ${authToken}`} : {}, credentials:'include'})
        .then(r => r.blob()).then(b => {
          const u = URL.createObjectURL(b); _thumbCache.set(src, u); _applyThumb(cell, u);
        }).catch(() => {});
    });
  }, {rootMargin: '120px'});
}

function _applyThumb(cell, url) {
  const img = cell.querySelector('.file-cell-thumb');
  if (img) img.style.backgroundImage = `url(${url})`;
}

// ── Type filter + sort ────────────────────────────────────────────────────────

let _typeFilter = 'all';
let _sortKey    = 'name';  // 'name' | 'size' | 'modified'
let _sortAsc    = true;
let _searchResults = null; // recursive matches from across the whole drive, or null
let _searchSeq  = 0;       // guards against out-of-order responses
let _searchTimer = null;

const _TYPE_EXTS = {
  image:   new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif','heic','raw','tiff']),
  doc:     new Set(['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','log','csv','odt','rtf']),
  video:   new Set(['mp4','mov','avi','mkv','wmv','flv','m4v','webm']),
  audio:   new Set(['mp3','flac','wav','aac','ogg','m4a','wma']),
  archive: new Set(['zip','tar','gz','7z','rar','bz2','xz']),
  code:    new Set(['py','js','ts','jsx','tsx','html','css','sh','rb','go','rs','c','cpp','java','php','vue','json','yaml','yml','xml','toml','ini','sql']),
};

function setTypeFilter(type) {
  _typeFilter = type;
  document.querySelectorAll('.type-pill').forEach(el => el.classList.toggle('active', el.dataset.type === type));
  applyView();
}

function setSort(key) {
  if (_sortKey === key) _sortAsc = !_sortAsc; else { _sortKey = key; _sortAsc = key === 'name'; }
  document.querySelectorAll('.sort-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.sort === key);
    if (el.dataset.sort === key) el.dataset.dir = _sortAsc ? 'asc' : 'desc';
  });
  applyView();
}

// Search box: debounce, then walk the WHOLE drive on the server for matches.
function filterFiles(q) {
  clearTimeout(_searchTimer);
  const text = (document.getElementById('file-search')?.value || '').trim();
  if (!text) { _searchResults = null; applyView(); return; }
  _searchTimer = setTimeout(runSearch, 250);
}

async function runSearch() {
  const text = (document.getElementById('file-search')?.value || '').trim();
  if (!text || !currentDriveId) { _searchResults = null; applyView(); return; }
  const seq = ++_searchSeq;
  const r = await api(`/api/files/search?drive=${currentDriveId}&q=${encodeURIComponent(text)}`, { bg: true });
  if (!r || seq !== _searchSeq) return;   // a newer keystroke already fired
  if (!r.ok) { toast('Search failed', 'error', 2500); return; }
  const data = await r.json();
  _searchResults = data.entries.filter(e => e.name !== 'System Volume Information');
  applyView();
  if (data.truncated) toast(`Showing the first ${_searchResults.length} matches — refine your search`, 'info', 3000);
}

// Apply the active type filter + sort to whatever base set we're showing (the
// drive-wide search results when searching, else the current folder).
function applyView() {
  const searching = _searchResults !== null;
  let entries = [...(searching ? _searchResults : dirEntries)];

  if (_typeFilter !== 'all') {
    entries = entries.filter(e => {
      if (_typeFilter === 'folder') return e.is_dir;
      const ext = (e.name.split('.').pop() || '').toLowerCase();
      return (_TYPE_EXTS[_typeFilter] || new Set()).has(ext);
    });
  }

  entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let av, bv;
    if (_sortKey === 'size')     { av = a.size_bytes;  bv = b.size_bytes; }
    else if (_sortKey === 'modified') { av = a.modified; bv = b.modified; }
    else                         { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
    if (av < bv) return _sortAsc ? -1 : 1;
    if (av > bv) return _sortAsc ?  1 : -1;
    return 0;
  });

  _filtered = (searching || _typeFilter !== 'all') ? entries : null;
  clearSel(false);
  renderFiles(_filtered || dirEntries, currentPath, searching);
}

function applyFilters() { applyView(); }   // back-compat for other callers

// ── File browser ──────────────────────────────────────────────────────────────

async function browseFiles(driveId, driveLabel, path = '/') {
  if (driveNeedsPin(driveId) && !await unlockDrivePrompt(driveId)) return;  // locked → require PIN
  currentDriveId = driveId; currentDriveLabel = driveLabel; currentPath = path;
  _filtered = null; _typeFilter = 'all'; _sortKey = 'name'; _sortAsc = true;
  document.getElementById('file-search').value = '';
  document.querySelectorAll('.type-pill').forEach(el => el.classList.toggle('active', el.dataset.type === 'all'));
  hide('view-welcome'); show('files-area');
  document.querySelectorAll('.sb-drive').forEach(el => el.classList.remove('active'));
  const card = document.getElementById(`sbcard-${driveId}`);
  if (card) card.classList.add('active');
  loadFiles(path);
  setBreadcrumb(_crumbsFor(path));
  document.querySelector('.app-body')?.classList.add('viewing-files');  // mobile: slide to Files screen
}

// Mobile: pop back to the Drives screen (no-op visual change on desktop).
function backToDrives() {
  document.querySelector('.app-body')?.classList.remove('viewing-files');
}

function setBreadcrumb(crumbs) {
  const nav = document.getElementById('breadcrumb');
  if (!crumbs.length) { nav.innerHTML = `<span class="crumb-current" style="color:var(--text-3)">Select a drive</span>`; return; }
  const parts = [];
  crumbs.forEach((c, i) => {
    if (i > 0) parts.push(`<span class="crumb-sep">/</span>`);
    if (i < crumbs.length - 1) parts.push(`<a onclick="loadFiles('${esc(c.path)}')">${esc(c.label)}</a>`);
    else parts.push(`<span class="crumb-current">${esc(c.label)}</span>`);
  });
  nav.innerHTML = parts.join('');
}

let _revealPath = null;   // a file to select once its folder finishes loading

function revealInFolder(path) {
  _revealPath = path;
  const parent = path.split('/').slice(0, -1).join('/') || '/';
  openDir(parent);   // exits search (loadFiles clears it) and selects the file
}

async function loadFiles(path) {
  currentPath = path; _filtered = null; _searchResults = null;
  document.getElementById('file-search').value = '';
  clearSel(false);
  const container = document.getElementById('files-container');
  container.innerHTML = '<div class="skeleton" style="height:33px;margin-bottom:2px;border-radius:7px"></div>'.repeat(8);
  const r = await api(`/api/files?drive=${currentDriveId}&path=${encodeURIComponent(path)}`);
  if (!r) return;
  if (!r.ok) {
    const d = await r.json(); toast(d.detail || 'Failed to load', 'error');
    container.innerHTML = `<div class="empty-state">${esc(d.detail || 'Error')}</div>`; return;
  }
  // Hide the Windows-created "System Volume Information" folder (per-drive system metadata).
  const data = await r.json(); dirEntries = data.entries.filter(e => e.name !== 'System Volume Information'); renderFiles(dirEntries, path);
  if (treeEnabled()) _renderTree(currentDriveId);   // keep the sidebar tree highlight in step
  // If we navigated here to reveal a search hit, select it now.
  if (_revealPath) {
    const rp = _revealPath; _revealPath = null;
    const i = dirEntries.findIndex(e => e.path === rp);
    if (i >= 0) {
      _sel = new Set([rp]); _lastClickIdx = i; updateSelBar(); renderFiles(dirEntries, path);
      document.querySelector(`.file-row[data-idx="${i}"], .file-cell[data-idx="${i}"]`)?.scrollIntoView({ block: 'center' });
    }
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────

// Windows-Explorer style: single click selects, double click opens.
function handleFileClick(idx, e) {
  const entries = _filtered || dirEntries, entry = entries[idx];
  if (!entry) return;

  // Checkbox click → pure toggle-select, never open (even in single-click mode).
  // Lets you tick several items without each one opening.
  if (e.target.closest('.file-row-check')) {
    if (_sel.has(entry.path)) _sel.delete(entry.path); else _sel.add(entry.path);
    _lastClickIdx = idx; updateSelBar(); renderFiles(entries, currentPath); return;
  }

  if (e.shiftKey && _lastClickIdx >= 0) {
    const lo = Math.min(_lastClickIdx, idx), hi = Math.max(_lastClickIdx, idx);
    const next = new Set(_sel);
    for (let i = lo; i <= hi; i++) { const k = (entries[i] || {}).path; if (k) next.add(k); }
    _sel = next; updateSelBar(); renderFiles(entries, currentPath); return;
  }

  if (e.ctrlKey || e.metaKey) {
    if (_sel.has(entry.path)) _sel.delete(entry.path); else _sel.add(entry.path);
    _lastClickIdx = idx; updateSelBar(); renderFiles(entries, currentPath); return;
  }

  // plain click → open directly if single-click mode is on, else just select.
  if (localStorage.getItem('ll-single-click') === '1') { _sel.clear(); handleFileOpen(idx); return; }
  _sel = new Set([entry.path]); _lastClickIdx = idx;
  updateSelBar(); renderFiles(entries, currentPath);
}

function handleFileOpen(idx) {
  const entries = _filtered || dirEntries, entry = entries[idx];
  if (!entry) return;
  if (entry.is_dir) { openDir(entry.path, entry.name); return; }
  // A search hit lives in another folder — jump to it there (where previews/actions
  // have the right context), selecting the file on arrival.
  if (_searchResults !== null) { revealInFolder(entry.path); return; }
  if (isImageFile(entry.name)) { const fi = dirEntries.findIndex(x => x.path === entry.path); openImageViewer(fi >= 0 ? fi : idx); return; }
  if (isPdfFile(entry.name))   { const fi = dirEntries.findIndex(x => x.path === entry.path); openPdfViewer(fi >= 0 ? fi : idx); return; }
  if (isDocxFile(entry.name))  { openDocxViewer(idx); return; }
  if (isTextFile(entry.name))  { openTextViewer(idx); return; }
  downloadFile(entry.path, entry.name);
}

function updateSelBar() {
  const bar = document.getElementById('sel-bar'), label = document.getElementById('sel-label');
  if (!_sel.size) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  label.textContent = `${_sel.size} item${_sel.size !== 1 ? 's' : ''} selected`;
}

function clearSel(rerender = true) {
  _sel.clear(); _lastClickIdx = -1;
  document.getElementById('sel-bar').classList.add('hidden');
  if (rerender && dirEntries.length) renderFiles(_filtered || dirEntries, currentPath);
}

async function downloadSelected() {
  const toDownload = dirEntries.filter(e => !e.is_dir && _sel.has(e.path));
  if (!toDownload.length) { toast('No files selected', 'info', 2000); return; }
  for (const e of toDownload) downloadFile(e.path, e.name);
  toast(`Downloading ${toDownload.length} file${toDownload.length !== 1 ? 's' : ''}…`, 'success', 2500);
}

// ── Editable address bar (Windows Explorer style) ─────────────────────────────

function _crumbsFor(path) {
  const segs = path.split('/').filter(Boolean);
  const crumbs = [{label: currentDriveLabel, path: '/'}];
  let built = ''; segs.forEach(s => { built += '/' + s; crumbs.push({label: s, path: built}); });
  return crumbs;
}

// Click a parent crumb (<a>) navigates; click anywhere else in the bar → type a path.
function breadcrumbClick(e) {
  if (e.target.closest('a')) return;
  if (currentDriveId) editPath();
}

function editPath() {
  if (!currentDriveId) return;
  const nav = document.getElementById('breadcrumb');
  nav.innerHTML = `<input id="path-input" class="path-input" value="${esc(currentPath || '/')}" spellcheck="false" autocomplete="off">`;
  const inp = document.getElementById('path-input');
  inp.focus(); inp.select();
  const restore = () => setBreadcrumb(_crumbsFor(currentPath));
  inp.onblur = restore;
  inp.onkeydown = ev => {
    if (ev.key === 'Enter')      { inp.onblur = null; commitPath(inp.value); }
    else if (ev.key === 'Escape') { inp.onblur = null; restore(); }
  };
}

function commitPath(value) {
  let p = (value || '').trim().replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1) p = p.replace(/\/+$/, '');   // strip trailing slashes
  openDir(p, p.split('/').filter(Boolean).pop() || currentDriveLabel);
}

// ── Make-writable helper (drives mount read-only by default) ───────────────────

async function ensureWritable() {
  if (!currentDriveId) return false;
  const r = await api(`/api/drives/${currentDriveId}/enable-write`, {method: 'POST'});
  if (r && !r.ok) { const d = await r.json().catch(() => ({})); toast(d.detail || 'Could not enable write', 'error', 4000); }
  return !!(r && r.ok);
}

async function renameEntry(idx) {
  const entries = _filtered || dirEntries, entry = entries[idx];
  if (!entry) return;
  // Show only the base name; re-attach the original extension unless the user
  // types their own, so renaming a file never means re-typing ".pdf"/".txt".
  const dot = entry.is_dir ? -1 : entry.name.lastIndexOf('.');
  const ext = dot > 0 ? entry.name.slice(dot) : '';
  const base = ext ? entry.name.slice(0, dot) : entry.name;
  // ponytail: native prompt — swap for inline edit if it needs polish
  const input = prompt('Rename to:', base);
  if (input == null) return;
  let newName = input.trim();
  if (ext && !newName.includes('.')) newName += ext;
  if (!newName || newName === entry.name) return;
  if (!await ensureWritable()) return;
  const r = await api('/api/files/rename', {method: 'POST', body: JSON.stringify({drive: currentDriveId, path: entry.path, new_name: newName})});
  if (!r) return;
  if (r.ok) { toast('Renamed', 'success'); loadFiles(currentPath); }
  else { const d = await r.json().catch(() => ({})); toast(d.detail || 'Rename failed', 'error', 4000); }
}

// ── Rubber-band drag selection ────────────────────────────────────────────────

let _rbActive = false, _rbStart = {x:0, y:0}, _rbBase = null, _rbDownTarget = null, _rbMoved = false;

function _startRubberBand(e) {
  if (e.button !== 0) return;
  // Marquee only starts on empty space. On a file item, mousedown means either a
  // click (handled by onclick) or the start of a native drag — arming the marquee
  // here would wipe the selection mid-drag, so only one item ends up dragged.
  if (e.target.closest('.btn, .file-row-check, .file-row-dl, .sel-bar, .files-toolbar, .file-row, .file-cell')) return;
  _rbActive = true; _rbMoved = false; _rbStart = {x: e.clientX, y: e.clientY};
  _rbDownTarget = e.target;
  // Additive only when Ctrl/Cmd held; otherwise a fresh marquee replaces the selection.
  _rbBase = (e.ctrlKey || e.metaKey) ? new Set(_sel) : new Set();
  const r = document.getElementById('rb-rect');
  r.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;display:block`;
  document.addEventListener('mousemove', _rbMove);
  document.addEventListener('mouseup', _rbEnd, {once: true});
}

function _rbMove(e) {
  if (!_rbActive) return;
  const x = Math.min(e.clientX, _rbStart.x), y = Math.min(e.clientY, _rbStart.y);
  const w = Math.abs(e.clientX - _rbStart.x), h = Math.abs(e.clientY - _rbStart.y);
  if (w > 5 || h > 5) _rbMoved = true;
  const r = document.getElementById('rb-rect');
  r.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;display:block`;
  if (!_rbMoved) return;

  // Live highlight: selection = base ∪ items touching the marquee. Toggle the
  // .selected class directly (blue highlight) instead of re-rendering each frame.
  const x2 = x + w, y2 = y + h, entries = _filtered || dirEntries;
  _sel = new Set(_rbBase);
  document.querySelectorAll('.file-row[data-idx], .file-cell[data-idx]').forEach(el => {
    const b = el.getBoundingClientRect();
    const entry = entries[parseInt(el.dataset.idx)];
    if (entry?.path && b.right > x && b.left < x2 && b.bottom > y && b.top < y2) _sel.add(entry.path);
    el.classList.toggle('selected', !!entry && _sel.has(entry.path));
  });
  updateSelBar();
}

function _rbEnd(e) {
  if (!_rbActive) return;
  _rbActive = false;
  document.removeEventListener('mousemove', _rbMove);
  document.getElementById('rb-rect').style.display = 'none';

  if (!_rbMoved) {
    // No drag → a plain click. On empty space (not a file), deselect everything.
    if (_rbDownTarget && !_rbDownTarget.closest('.file-row, .file-cell')) clearSel();
    return;
  }
  // Drag done — _sel is already live from _rbMove; re-render to sync the checkmarks.
  renderFiles(_filtered || dirEntries, currentPath);
}

async function deleteSelected() {
  const entries = _filtered || dirEntries;
  const paths = entries.filter(e => _sel.has(e.path)).map(e => e.path);
  if (!paths.length) { toast('Nothing selected', 'info', 2000); return; }
  if (!confirm(`Permanently delete ${paths.length} item${paths.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
  if (!await ensureWritable()) return;
  const r = await api('/api/files', {method: 'DELETE', body: JSON.stringify({drive: currentDriveId, paths})});
  if (!r) return;
  if (r.ok) {
    const d = await r.json().catch(() => ({})); const n = d.count ?? paths.length;
    toast(`Deleted ${n} item${n !== 1 ? 's' : ''}`, 'success'); clearSel(false); loadFiles(currentPath);
  } else { const d = await r.json().catch(() => ({})); toast(d.detail || 'Delete failed', 'error', 4000); }
}

// ── Transfer (copy to another drive) ────────────────────────────────────────────

let _xferPoll = null;

async function copySelectedTo() {
  const entries = _filtered || dirEntries;
  const paths = entries.filter(e => _sel.has(e.path)).map(e => e.path);
  if (!paths.length) { toast('Nothing selected', 'info', 2000); return; }
  const r = await api('/api/drives'); if (!r) return;
  const drives = (await r.json()).filter(d => d.id !== currentDriveId && d.state !== 'unmounted' && d.id !== 'system-root');
  if (!drives.length) { toast('No other mounted drive to copy to', 'info', 3500); return; }

  document.getElementById('xfer-count').textContent = paths.length;
  document.getElementById('xfer-pick').style.display = '';
  document.getElementById('xfer-progress').style.display = 'none';
  document.getElementById('xfer-drives').innerHTML = drives.map(d => `
    <button class="vpn-row" style="width:100%;text-align:left;cursor:pointer;border:0;background:var(--surface);margin-bottom:6px;border-radius:8px"
            onclick='startXfer(${JSON.stringify(d.id)}, ${JSON.stringify(d.label)}, ${JSON.stringify(paths)})'>
      <span class="vpn-row-name">${esc(d.label)}</span>
      <span class="vpn-row-badge">${esc(d.fstype)} · ${fmt(d.free_bytes)} free</span>
    </button>`).join('');
  show('xfer-modal');
}

function closeXfer() {
  hide('xfer-modal');
  if (_xferPoll) { clearInterval(_xferPoll); _xferPoll = null; }
}

async function startXfer(dstDrive, dstLabel, paths) {
  const r = await api('/api/files/transfer', {method: 'POST', body: JSON.stringify({
    src_drive: currentDriveId, paths, dst_drive: dstDrive, dst_path: '/',
  })});
  if (!r?.ok) { const e = await r.json().catch(() => ({})); toast(e.detail || 'Transfer failed to start', 'error', 5000); closeXfer(); return; }
  document.getElementById('xfer-pick').style.display = 'none';
  document.getElementById('xfer-progress').style.display = '';
  document.getElementById('xfer-prog-label').textContent = `Copying to ${dstLabel}…`;
  _xferPoll = setInterval(() => _pollXfer(dstLabel), 700);
}

async function _pollXfer(dstLabel) {
  const r = await api('/api/files/transfer/status', {bg: true}); if (!r?.ok) return;
  const s = await r.json();
  const pct = s.total ? Math.min(100, Math.round(s.done / s.total * 100)) : 0;
  document.getElementById('xfer-bar').style.width = pct + '%';
  document.getElementById('xfer-prog-stat').textContent =
    `${fmt(s.done)} of ${fmt(s.total)} · ${s.copied}/${s.count} items` + (s.file ? ` · ${s.file}` : '');
  if (!s.running) {
    clearInterval(_xferPoll); _xferPoll = null;
    if (s.error) toast('Transfer failed: ' + s.error, 'error', 6000);
    else toast(`Copied to ${dstLabel}`, 'success');
    closeXfer();
  }
}

// ── Internal drag & drop (move within a drive / copy across drives) ───────────
// _dragPaths holds the items being dragged. Set on dragstart, read on drop.
let _dragPaths = null;

function onItemDragStart(e, idx) {
  const entries = _filtered || dirEntries, entry = entries[idx];
  if (!entry) return;
  // A row mousedown also armed the marquee — cancel it so native drag wins cleanly.
  _rbActive = false; document.removeEventListener('mousemove', _rbMove);
  document.getElementById('rb-rect').style.display = 'none';
  // Drag the whole selection if the grabbed item is part of it, else just it.
  _dragPaths = _sel.has(entry.path) ? [..._sel] : [entry.path];
  e.dataTransfer.effectAllowed = 'copyMove';
  try { e.dataTransfer.setData('text/plain', 'litelayer'); } catch {}
  // Show a count badge while dragging more than one item.
  if (_dragPaths.length > 1) {
    const badge = document.createElement('div');
    badge.className = 'drag-count';
    badge.textContent = `${_dragPaths.length} items`;
    document.body.appendChild(badge);
    try { e.dataTransfer.setDragImage(badge, -10, -10); } catch {}
    setTimeout(() => badge.remove(), 0);
  }
}

function onItemDragOver(e, el) {
  if (!_dragPaths) return;          // only react to our own internal drags
  e.preventDefault(); e.stopPropagation();
  el.classList.add('drop-into');
}

async function onItemDrop(e, destPath) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.drop-into').forEach(el => el.classList.remove('drop-into'));
  if (!_dragPaths?.length) return;
  const paths = _dragPaths.filter(p => p !== destPath);  // can't drop onto self
  _dragPaths = null;
  if (paths.length) await moveInto(destPath, paths);
}

// Parent of the current folder ('/' when already at root).
function _parentPath() {
  const parts = currentPath.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '/';
}

// Drop onto the ".." row → move the dragged items up into the parent folder.
function onUpDragOver(e, el) {
  if (!_dragPaths) return;
  e.preventDefault(); e.stopPropagation();
  el.classList.add('drop-into');
}
async function onUpDrop(e) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.drop-into').forEach(el => el.classList.remove('drop-into'));
  if (!_dragPaths?.length) return;
  const paths = _dragPaths; _dragPaths = null;
  await moveInto(_parentPath(), paths);
}

async function moveInto(destPath, paths) {
  if (!await ensureWritable()) return;
  const r = await api('/api/files/move', {method: 'POST', body: JSON.stringify({drive: currentDriveId, paths, dest: destPath})});
  if (!r) return;
  if (r.ok) { const d = await r.json(); toast(`Moved ${d.count} item${d.count !== 1 ? 's' : ''}`, 'success'); clearSel(false); loadFiles(currentPath); }
  else { const d = await r.json().catch(() => ({})); toast(d.detail || 'Move failed', 'error', 4000); }
}

// Drop from a file drag onto a sidebar drive card → same drive moves to root,
// a different drive copies via the transfer pipeline.
async function onDriveDrop(e, driveId) {
  e.preventDefault(); e.stopPropagation();
  document.getElementById(`sbcard-${driveId}`)?.classList.remove('drop-target');
  if (!_dragPaths?.length) return;
  const paths = _dragPaths; _dragPaths = null;
  if (driveId === currentDriveId) { await moveInto('/', paths); return; }
  if (driveId === 'system-root') { toast("Can't drop onto the system drive", 'info', 3000); return; }
  const label = document.getElementById(`sbcard-${driveId}`)?.querySelector('.sb-drive-name')?.textContent || 'drive';
  document.getElementById('xfer-count').textContent = paths.length;
  document.getElementById('xfer-pick').style.display = 'none';
  document.getElementById('xfer-progress').style.display = '';
  show('xfer-modal');
  startXfer(driveId, label, paths);
}

function onDriveDragOver(e, id) {
  if (!_dragPaths) return;
  e.preventDefault();
  document.getElementById(`sbcard-${id}`)?.classList.add('drop-target');
}

// ── New folder (and "new folder from selection") ──────────────────────────────
async function newFolder() {
  if (!currentDriveId) { toast('Select a drive first', 'info', 2000); return; }
  const name = prompt('New folder name:', 'New Folder');
  if (name == null) return;
  const folder = name.trim();
  if (!folder) return;
  if (!await ensureWritable()) return;
  const mk = await api('/api/files/mkdir', {method: 'POST', body: JSON.stringify({drive: currentDriveId, path: currentPath, name: folder})});
  if (!mk?.ok) { const d = await mk?.json().catch(() => ({})); toast(d?.detail || 'Could not create folder', 'error', 4000); return; }
  toast('Folder created', 'success'); loadFiles(currentPath);
}

// Right-click on empty space in the file area → quick actions.
function showEmptyCtxMenu(e) {
  if (e.target.closest('.file-row, .file-cell')) return;  // let item menu handle items
  e.preventDefault(); closeCtxMenu();
  if (!currentDriveId) return;
  const items = [
    `<div class="ctx-item" onclick="newFolder();closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>New folder</div>`,
    `<div class="ctx-item" onclick="newFile();closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>New file</div>`,
    `<div class="ctx-sep"></div>`,
    `<div class="ctx-item" onclick="closeCtxMenu();document.getElementById('upload-input').click()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>Upload files…</div>`,
    `<div class="ctx-item" onclick="closeCtxMenu();document.getElementById('upload-folder-input').click()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><path d="M12 17v-6m-3 3 3-3 3 3"/></svg>Upload a folder…</div>`,
    `<div class="ctx-sep"></div>`,
    `<div class="ctx-item" onclick="loadFiles(currentPath);closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>Refresh</div>`,
  ];
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = items.join(''); menu.classList.remove('hidden');
  const vw = window.innerWidth, vh = window.innerHeight, mw = 166, mh = items.length * 34;
  menu.style.left = (e.clientX + mw > vw ? e.clientX - mw : e.clientX) + 'px';
  menu.style.top  = (e.clientY + mh > vh ? e.clientY - mh : e.clientY) + 'px';
}

// New empty file — reuses the upload endpoint with a zero-byte file (no new API).
async function newFile() {
  if (!currentDriveId) { toast('Select a drive first', 'info', 2000); return; }
  const name = prompt('New file name:', 'untitled.txt');
  if (name == null) return;
  const fname = name.trim();
  if (!fname) return;
  if (!await ensureWritable()) return;
  try {
    await _uploadOne(new File([''], fname, {type: 'text/plain'}), currentPath || '/', () => {});
    toast('File created', 'success'); loadFiles(currentPath);
  } catch (e) { toast(e.message || 'Could not create file', 'error', 4000); }
}

async function newFolderFromSelection() {
  const entries = _filtered || dirEntries;
  const paths = entries.filter(e => _sel.has(e.path)).map(e => e.path);
  const name = prompt('New folder name:', paths.length ? 'New Folder' : 'New Folder');
  if (name == null) return;
  const folder = name.trim();
  if (!folder) return;
  if (!await ensureWritable()) return;
  const mk = await api('/api/files/mkdir', {method: 'POST', body: JSON.stringify({drive: currentDriveId, path: currentPath, name: folder})});
  if (!mk?.ok) { const d = await mk?.json().catch(() => ({})); toast(d?.detail || 'Could not create folder', 'error', 4000); return; }
  const dest = (await mk.json()).path;
  if (paths.length) {
    const mv = await api('/api/files/move', {method: 'POST', body: JSON.stringify({drive: currentDriveId, paths: paths.filter(p => p !== dest), dest})});
    if (!mv?.ok) { const d = await mv?.json().catch(() => ({})); toast(d?.detail || 'Folder made, but move failed', 'error', 4000); }
  }
  toast('Folder created', 'success'); clearSel(false); loadFiles(currentPath);
}

// ── Upload ────────────────────────────────────────────────────────────────────

// Upload button → small menu: multiple files, or a whole folder (keeps subdirs).
// Reuses the ctx-menu element so outside-click / Esc close it for free.
function openUploadMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('ctx-menu');
  if (!menu.classList.contains('hidden')) { closeCtxMenu(); return; }
  if (!currentDriveId) { toast('Select a drive first', 'info', 2000); return; }
  menu.innerHTML = `
    <div class="ctx-item" onclick="document.getElementById('upload-input').click()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>Upload files…</div>
    <div class="ctx-item" onclick="document.getElementById('upload-folder-input').click()" title="Keeps the folder's subfolders"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>Upload a folder…</div>`;
  menu.classList.remove('hidden');
  const b = e.currentTarget.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(b.left, window.innerWidth - 190)) + 'px';
  menu.style.top  = (b.bottom + 6) + 'px';
}

function handleDropUpload(e) {
  e.preventDefault();
  document.getElementById('files-area').classList.remove('drag-over');
  if (!currentDriveId) { toast('Select a drive first', 'error'); return; }
  const files = [...(e.dataTransfer?.files || [])];
  console.log('[upload] drop:', files.length, 'file(s)', files.map(f => f.name));
  if (files.length) uploadFiles(files);
  else console.warn('[upload] drop had no files');
}

// POST one file via XHR so we get an upload-progress event (fetch can't).
// destPath = the folder to drop it in (used for folder uploads that keep subdirs).
function _uploadOne(file, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const url = `${API}/api/files/upload?drive=${encodeURIComponent(currentDriveId)}&path=${encodeURIComponent(destPath)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else { let d = xhr.responseText; try { d = JSON.parse(xhr.responseText).detail || d; } catch {} reject(new Error(d || `HTTP ${xhr.status}`)); }
    };
    xhr.onerror = () => reject(new Error('network error'));
    const fd = new FormData(); fd.append('file', file);
    xhr.send(fd);
  });
}

async function uploadFiles(files) {
  files = [...(files || [])];
  if (!currentDriveId) { toast('Select a drive first', 'error'); return; }
  if (!files.length) return;
  await ensureWritable();   // best-effort; upload endpoint also self-heals a ro mount

  const base = currentPath.replace(/\/$/, '');
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  let doneBytes = 0, ok = 0, fail = 0;

  // Show the progress modal (skip the chrome for a single tiny file — it'd just flash).
  const showUi = files.length > 1 || totalBytes > 2 * 1024 * 1024;
  if (showUi) show('upload-modal');
  const bar = document.getElementById('upload-bar'), lbl = document.getElementById('upload-label'), stat = document.getElementById('upload-stat');

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // Folder uploads carry webkitRelativePath ("folder/sub/x.txt") — keep the subdirs.
    const rel = file.webkitRelativePath || '';
    const sub = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const destPath = sub ? `${base}/${sub}` : (base || '/');
    if (showUi) lbl.textContent = `Uploading ${i + 1} of ${files.length}: ${rel || file.name}`;
    try {
      let last = 0;
      await _uploadOne(file, destPath, (loaded, total) => {
        doneBytes += loaded - last; last = loaded;
        if (showUi) {
          const pct = totalBytes ? Math.min(100, Math.round(doneBytes / totalBytes * 100)) : 0;
          bar.style.width = pct + '%';
          stat.textContent = `${fmt(doneBytes)} of ${fmt(totalBytes)} · ${pct}%`;
        }
      });
      doneBytes += file.size - last;   // ensure totals settle even if no final progress event
      ok++;
    } catch (err) {
      console.error('[upload] failed:', file.name, err);
      toast(`Upload failed: ${file.name} — ${err.message}`, 'error', 5000); fail++;
    }
  }
  if (showUi) hide('upload-modal');
  if (ok) { toast(`Uploaded ${ok} file${ok > 1 ? 's' : ''}`, 'success'); loadFiles(currentPath); }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderFiles(entries, path, searching = false) {
  const container = document.getElementById('files-container');
  const subPath = e => { const p = e.path.split('/').slice(0, -1).join('/'); return p || '/'; };
  const upRow  = path !== '/' ? `<div class="file-row" onclick="navigateUp()" ondragover="onUpDragOver(event,this)" ondragleave="this.classList.remove('drop-into')" ondrop="onUpDrop(event)" title="Drop here to move up a folder"><div class="file-row-check"></div><div class="fi-wrap" style="background:rgba(155,143,207,0.08);color:var(--text-3)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></div><div class="file-row-name" style="color:var(--text-3);font-size:12px">..</div><div class="file-row-date"></div><div class="file-row-size"></div><div class="file-row-dl"></div></div>` : '';
  const upCell = path !== '/' ? `<div class="file-cell" onclick="navigateUp()" ondragover="onUpDragOver(event,this)" ondragleave="this.classList.remove('drop-into')" ondrop="onUpDrop(event)" title="Drop here to move up a folder"><div class="fi-wrap fi-wrap-lg" style="background:rgba(155,143,207,0.08);color:var(--text-3)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></div><div class="file-cell-name">..</div></div>` : '';

  if (!entries.length) {
    const noMatch = _filtered !== null;
    // Keep the ".." row visible so you can always get out of an empty folder.
    const up = fileView === 'list' ? upRow : (path !== '/' ? `<div class="file-grid">${upCell}</div>` : '');
    container.innerHTML = up + `<div class="empty-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${noMatch ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' : '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>'}</svg><div>${noMatch ? 'No results' : 'Empty folder'}</div></div>`;
    return;
  }

  if (fileView === 'list') {
    container.innerHTML = `<div class="file-list-header"><div style="width:14px"></div><div style="width:26px"></div><div class="flex-1">Name</div><div class="file-sort-btn" data-sort="modified" onclick="setSort('modified')">Modified</div><div class="file-sort-btn" data-sort="size" onclick="setSort('size')" style="text-align:right">Size</div><div style="width:26px"></div></div>
    <div class="file-list">${upRow}${entries.map((e, i) => {
      const sel = _sel.has(e.path), tc = textColorVar(fileType(e.name, e.is_dir));
      const drop = e.is_dir ? ` ondragover="onItemDragOver(event,this)" ondragleave="this.classList.remove('drop-into')" ondrop="onItemDrop(event,'${esc(e.path)}')"` : '';
      return `<div class="file-row${sel ? ' selected' : ''}" data-idx="${i}" draggable="true" ondragstart="onItemDragStart(event,${i})"${drop} onclick="handleFileClick(${i},event)" ondblclick="handleFileOpen(${i})" oncontextmenu="showCtxMenu(event,${i});return false">
        <div class="file-row-check">${sel ? '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</div>
        ${fileIconHtml(e.name, e.is_dir)}
        <div class="file-row-name" title="${esc(e.name)}"${tc ? ` style="color:${tc}"` : ''}>${esc(e.name)}${searching ? `<small style="display:block;color:var(--text-3);font-size:10px;font-weight:400;line-height:1.1">${esc(subPath(e))}</small>` : ''}</div>
        <div class="file-row-date">${fmtDate(e.modified)}</div>
        <div class="file-row-size">${e.is_dir ? '—' : fmt(e.size_bytes)}</div>
        <div class="file-row-dl">${!e.is_dir ? `<button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();downloadFile('${esc(e.path)}','${esc(e.name)}')" title="Download"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>` : ''}</div>
      </div>`;
    }).join('')}</div>`;
  } else {
    _initThumbObserver();
    container.innerHTML = `<div class="file-grid">${upCell}${entries.map((e, i) => {
      const sel = _sel.has(e.path), isImg = !e.is_dir && isImageFile(e.name), tc = textColorVar(fileType(e.name, e.is_dir));
      const thumbSrc = isImg ? `${API}/api/files/download?drive=${currentDriveId}&path=${encodeURIComponent(e.path)}` : '';
      const drop = e.is_dir ? ` ondragover="onItemDragOver(event,this)" ondragleave="this.classList.remove('drop-into')" ondrop="onItemDrop(event,'${esc(e.path)}')"` : '';
      return `<div class="file-cell${sel ? ' selected' : ''}" data-idx="${i}" draggable="true" ondragstart="onItemDragStart(event,${i})"${drop} onclick="handleFileClick(${i},event)" ondblclick="handleFileOpen(${i})" oncontextmenu="showCtxMenu(event,${i});return false" title="${esc(e.name)}"${isImg ? ` data-preview-src="${esc(thumbSrc)}"` : ''}>
        ${isImg ? `<div class="file-cell-thumb fi-wrap-lg"></div>` : fileIconHtml(e.name, e.is_dir, 19, 'fi-wrap-lg')}
        <div class="file-cell-name"${tc ? ` style="color:${tc}"` : ''}>${esc(e.name)}</div>
        <div class="file-cell-size">${searching ? esc(subPath(e)) : (e.is_dir ? '' : fmt(e.size_bytes))}</div>
      </div>`;
    }).join('')}</div>`;
    container.querySelectorAll('[data-preview-src]').forEach(el => _thumbObserver.observe(el));
  }
}

function openDir(path, name) {
  _sel.clear();
  const segs = path.split('/').filter(Boolean);
  const crumbs = [{label: currentDriveLabel, path: '/'}];
  let built = ''; segs.forEach(s => { built += '/' + s; crumbs.push({label: s, path: built}); });
  setBreadcrumb(crumbs); loadFiles(path);
}

function navigateUp() {
  const parts = currentPath.split('/').filter(Boolean);
  if (!parts.length) return;
  parts.pop();
  openDir(parts.length ? '/' + parts.join('/') : '/');
}

function downloadFile(path, name) {
  const url = `${API}/api/files/download?drive=${currentDriveId}&path=${encodeURIComponent(path)}`;
  if (authToken) {
    toast(`Downloading ${name}…`, 'info', 2000);
    fetch(url, {headers: {Authorization: `Bearer ${authToken}`}, credentials: 'include'})
      .then(r => r.blob()).then(blob => {
        const burl = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = burl; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(burl), 10000);
      }).catch(() => toast('Download failed', 'error'));
    return;
  }
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  toast(`Downloading ${name}…`, 'info', 2000);
}

function setView(v) {
  fileView = v;
  document.getElementById('toggle-list').classList.toggle('active', v === 'list');
  document.getElementById('toggle-grid').classList.toggle('active', v === 'grid');
  if (currentDriveId) renderFiles(_filtered || dirEntries, currentPath);
}

// ── Context menu ──────────────────────────────────────────────────────────────

function showCtxMenu(e, idx) {
  closeCtxMenu();
  const entries = _filtered || dirEntries, entry = entries[idx];
  if (!entry) return;
  if (!_sel.has(entry.path)) { _sel.clear(); _sel.add(entry.path); updateSelBar(); renderFiles(entries, currentPath); }
  const items = [];
  if (entry.is_dir) {
    items.push(`<div class="ctx-item" onclick="openDir('${esc(entry.path)}','${esc(entry.name)}');closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>Open folder</div>`);
  } else {
    if (isImageFile(entry.name)) { const fi = dirEntries.findIndex(x => x.path === entry.path); items.push(`<div class="ctx-item" onclick="openImageViewer(${fi >= 0 ? fi : idx});closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>View image</div>`); }
    if (isPdfFile(entry.name))   { const fi = dirEntries.findIndex(x => x.path === entry.path); items.push(`<div class="ctx-item" onclick="openPdfViewer(${fi >= 0 ? fi : idx});closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Open PDF</div>`); }
    if (isDocxFile(entry.name))  { items.push(`<div class="ctx-item" onclick="openDocxViewer(${idx});closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>View document</div>`); }
    if (isTextFile(entry.name))  { items.push(`<div class="ctx-item" onclick="openTextViewer(${idx});closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Edit text</div>`); }
    items.push(`<div class="ctx-item" onclick="downloadFile('${esc(entry.path)}','${esc(entry.name)}');closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>Download</div>`);
  }
  if (_sel.size <= 1) {
    items.push(`<div class="ctx-item" onclick="renameEntry(${idx});closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z"/></svg>Rename</div>`);
    items.push(`<div class="ctx-item" onclick="showProperties(${idx});closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>Properties</div>`);
  }
  if (_sel.size > 1) { items.push(`<div class="ctx-sep"></div>`); items.push(`<div class="ctx-item" onclick="downloadSelected();closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>Download ${_sel.size} selected</div>`); }
  items.push(`<div class="ctx-sep"></div>`);
  items.push(`<div class="ctx-item ctx-danger" onclick="deleteSelected();closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>Delete${_sel.size > 1 ? ` ${_sel.size}` : ''}</div>`);
  items.push(`<div class="ctx-item" onclick="clearSel();closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Deselect all</div>`);
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = items.join(''); menu.classList.remove('hidden');
  const vw = window.innerWidth, vh = window.innerHeight, mw = 166, mh = items.length * 34;
  menu.style.left = (e.clientX + mw > vw ? e.clientX - mw : e.clientX) + 'px';
  menu.style.top  = (e.clientY + mh > vh ? e.clientY - mh : e.clientY) + 'px';
}

function closeCtxMenu() { document.getElementById('ctx-menu').classList.add('hidden'); }

// ── File / folder properties ──────────────────────────────────────────────────
function showProperties(idx) {
  const entries = _filtered || dirEntries, e = entries[idx];
  if (!e) return;
  const ext = !e.is_dir && e.name.includes('.') ? e.name.split('.').pop().toUpperCase() + ' file' : 'File';
  const type = e.is_dir ? 'Folder' : ext;
  const slash = e.path.lastIndexOf('/');
  const loc = slash > 0 ? e.path.slice(0, slash) : '/';
  const when = e.modified ? new Date(e.modified * 1000).toLocaleString() : '—';
  const rows = [
    ['Name', e.name],
    ['Type', type],
    ['Size', e.is_dir ? '—' : fmt(e.size_bytes)],
    ['Location', `${currentDriveLabel}${loc}`],
    ['Modified', when],
  ];
  document.getElementById('props-body').innerHTML = rows.map(([k, v]) =>
    `<div class="about-info-row"><div class="about-info-label">${k}</div><div class="about-info-value" style="word-break:break-word">${esc(v)}</div></div>`
  ).join('');
  show('props-modal');
}
function closeProps() { hide('props-modal'); }

// ── Mobile: long-press → context menu ─────────────────────────────────────────
// Android fires a native `contextmenu` on long-press (already handled); iOS
// Safari doesn't, so a touch timer covers it. On small screens the menu renders
// as a bottom sheet (see app.css). Double-fire on Android is harmless —
// showCtxMenu recloses the menu first.
(function () {
  const area = document.getElementById('files-area');
  if (!area) return;
  let timer = null, fired = false, sx = 0, sy = 0;

  area.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; fired = false;
    const item = e.target.closest('.file-row[data-idx], .file-cell[data-idx]');
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) navigator.vibrate(12);
      const fake = { clientX: sx, clientY: sy, target: e.target, preventDefault() {} };
      if (item) showCtxMenu(fake, parseInt(item.dataset.idx));
      else showEmptyCtxMenu(fake);
    }, 480);
  }, { passive: true });

  area.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) clearTimeout(timer);
  }, { passive: true });

  // If the menu opened, swallow the touch's synthetic click — otherwise the
  // document-level click handler would close the sheet the instant it opens.
  area.addEventListener('touchend', e => {
    clearTimeout(timer);
    if (fired) { e.preventDefault(); fired = false; }
  }, { passive: false });
  area.addEventListener('touchcancel', () => clearTimeout(timer), { passive: true });
})();
