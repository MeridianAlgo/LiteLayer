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

// ── File browser ──────────────────────────────────────────────────────────────

function browseFiles(driveId, driveLabel) {
  currentDriveId = driveId; currentDriveLabel = driveLabel; currentPath = '/';
  _filtered = null; document.getElementById('file-search').value = '';
  hide('view-welcome'); show('files-area');
  document.querySelectorAll('.sb-drive').forEach(el => el.classList.remove('active'));
  const card = document.getElementById(`sbcard-${driveId}`);
  if (card) card.classList.add('active');
  loadFiles('/');
  setBreadcrumb([{label: driveLabel, path: '/'}]);
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

async function loadFiles(path) {
  currentPath = path; _filtered = null;
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
  const data = await r.json(); dirEntries = data.entries; renderFiles(dirEntries, path);
}

function filterFiles(q) {
  if (!dirEntries.length) return;
  const lq = q.trim().toLowerCase();
  _filtered = lq ? dirEntries.filter(e => e.name.toLowerCase().includes(lq)) : null;
  clearSel(false); renderFiles(_filtered || dirEntries, currentPath);
}

// ── Selection ─────────────────────────────────────────────────────────────────

function handleFileClick(idx, e) {
  const entries = _filtered || dirEntries, entry = entries[idx];
  if (!entry) return;

  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
    if (entry.is_dir) { openDir(entry.path, entry.name); return; }
    if (isImageFile(entry.name)) { const fi = dirEntries.findIndex(x => x.path === entry.path); openImageViewer(fi >= 0 ? fi : idx); return; }
    if (isPdfFile(entry.name))   { const fi = dirEntries.findIndex(x => x.path === entry.path); openPdfViewer(fi >= 0 ? fi : idx); return; }
    if (isDocxFile(entry.name))  { openDocxViewer(idx); return; }
    downloadFile(entry.path, entry.name); return;
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

// ── Render ────────────────────────────────────────────────────────────────────

function renderFiles(entries, path) {
  const container = document.getElementById('files-container');
  if (!entries.length) {
    const noMatch = _filtered !== null;
    container.innerHTML = `<div class="empty-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${noMatch ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' : '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>'}</svg><div>${noMatch ? 'No results' : 'Empty folder'}</div></div>`;
    return;
  }
  const upRow  = path !== '/' ? `<div class="file-row" onclick="navigateUp()"><div class="file-row-check"></div><div class="fi-wrap" style="background:rgba(155,143,207,0.08);color:var(--text-3)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></div><div class="file-row-name" style="color:var(--text-3);font-size:12px">..</div><div class="file-row-date"></div><div class="file-row-size"></div><div class="file-row-dl"></div></div>` : '';
  const upCell = path !== '/' ? `<div class="file-cell" onclick="navigateUp()"><div class="fi-wrap fi-wrap-lg" style="background:rgba(155,143,207,0.08);color:var(--text-3)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></div><div class="file-cell-name">..</div></div>` : '';

  if (fileView === 'list') {
    container.innerHTML = `<div class="file-list-header"><div style="width:14px"></div><div style="width:26px"></div><div class="flex-1">Name</div><div style="width:108px;text-align:right">Modified</div><div style="width:66px;text-align:right">Size</div><div style="width:26px"></div></div>
    <div class="file-list">${upRow}${entries.map((e, i) => {
      const sel = _sel.has(e.path);
      return `<div class="file-row${sel ? ' selected' : ''}" onclick="handleFileClick(${i},event)" oncontextmenu="showCtxMenu(event,${i});return false">
        <div class="file-row-check">${sel ? '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</div>
        ${fileIconHtml(e.name, e.is_dir)}
        <div class="file-row-name" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="file-row-date">${fmtDate(e.modified)}</div>
        <div class="file-row-size">${e.is_dir ? '—' : fmt(e.size_bytes)}</div>
        <div class="file-row-dl">${!e.is_dir ? `<button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();downloadFile('${esc(e.path)}','${esc(e.name)}')" title="Download"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>` : ''}</div>
      </div>`;
    }).join('')}</div>`;
  } else {
    _initThumbObserver();
    container.innerHTML = `<div class="file-grid">${upCell}${entries.map((e, i) => {
      const sel = _sel.has(e.path), isImg = !e.is_dir && isImageFile(e.name);
      const thumbSrc = isImg ? `${API}/api/files/download?drive=${currentDriveId}&path=${encodeURIComponent(e.path)}` : '';
      return `<div class="file-cell${sel ? ' selected' : ''}" onclick="handleFileClick(${i},event)" oncontextmenu="showCtxMenu(event,${i});return false" title="${esc(e.name)}"${isImg ? ` data-preview-src="${esc(thumbSrc)}"` : ''}>
        ${isImg ? `<div class="file-cell-thumb fi-wrap-lg"></div>` : fileIconHtml(e.name, e.is_dir, 19, 'fi-wrap-lg')}
        <div class="file-cell-name">${esc(e.name)}</div>
        <div class="file-cell-size">${e.is_dir ? '' : fmt(e.size_bytes)}</div>
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
    if (isPdfFile(entry.name))   { const fi = dirEntries.findIndex(x => x.path === entry.path); items.push(`<div class="ctx-item" onclick="openPdfViewer(${fi >= 0 ? fi : idx});closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>View PDF</div>`); }
    if (isDocxFile(entry.name))  { items.push(`<div class="ctx-item" onclick="openDocxViewer(${idx});closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>View document</div>`); }
    items.push(`<div class="ctx-item" onclick="downloadFile('${esc(entry.path)}','${esc(entry.name)}');closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>Download</div>`);
  }
  if (_sel.size > 1) { items.push(`<div class="ctx-sep"></div>`); items.push(`<div class="ctx-item" onclick="downloadSelected();closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>Download ${_sel.size} selected</div>`); }
  items.push(`<div class="ctx-sep"></div>`);
  items.push(`<div class="ctx-item" onclick="clearSel();closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Deselect all</div>`);
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = items.join(''); menu.classList.remove('hidden');
  const vw = window.innerWidth, vh = window.innerHeight, mw = 166, mh = items.length * 34;
  menu.style.left = (e.clientX + mw > vw ? e.clientX - mw : e.clientX) + 'px';
  menu.style.top  = (e.clientY + mh > vh ? e.clientY - mh : e.clientY) + 'px';
}

function closeCtxMenu() { document.getElementById('ctx-menu').classList.add('hidden'); }
