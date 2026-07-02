// ── Image Viewer ──────────────────────────────────────────────────────────────

const IV_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif']);
let _ivBlobUrl = null, _ivIndex = 0, _ivImages = [];
let _ivZoom = 1, _ivTx = 0, _ivTy = 0, _ivDragging = false, _ivDrag0 = {x:0,y:0,tx:0,ty:0};

function isImageFile(name) { return IV_EXTS.has((name.split('.').pop() || '').toLowerCase()); }

function openImageViewer(dirIdx) {
  _ivImages = dirEntries.map((e, i) => ({...e, dirIdx: i})).filter(e => !e.is_dir && isImageFile(e.name));
  _ivIndex = _ivImages.findIndex(e => e.dirIdx === dirIdx);
  if (_ivIndex < 0) _ivIndex = 0;
  show('image-viewer'); document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', _ivKey); _ivLoad();
}

function closeImageViewer() {
  hide('image-viewer'); document.body.style.overflow = '';
  document.removeEventListener('keydown', _ivKey);
  if (_ivBlobUrl) { URL.revokeObjectURL(_ivBlobUrl); _ivBlobUrl = null; }
  document.getElementById('iv-img').src = '';
}

async function _ivLoad() {
  const entry = _ivImages[_ivIndex]; if (!entry) return;
  const img = document.getElementById('iv-img');
  img.style.opacity = '0'; _ivZoom = 1; _ivTx = 0; _ivTy = 0; _ivApply();
  document.getElementById('iv-filename').textContent = entry.name;
  document.getElementById('iv-counter').textContent = `${_ivIndex + 1} / ${_ivImages.length}`;
  document.getElementById('iv-filesize').textContent = entry.size_bytes ? fmt(entry.size_bytes) : '';
  document.getElementById('iv-modified').textContent = entry.modified ? fmtDate(entry.modified) : '';
  document.getElementById('iv-dims').textContent = '';
  document.getElementById('iv-prev').style.visibility = _ivIndex > 0 ? '' : 'hidden';
  document.getElementById('iv-next').style.visibility = _ivIndex < _ivImages.length - 1 ? '' : 'hidden';
  if (_ivBlobUrl) { URL.revokeObjectURL(_ivBlobUrl); _ivBlobUrl = null; }
  try {
    const url = `${API}/api/files/download?drive=${currentDriveId}&path=${encodeURIComponent(entry.path)}`;
    const r = await fetch(url, {headers: authToken ? {Authorization:`Bearer ${authToken}`} : {}, credentials:'include'});
    const blob = await r.blob(); _ivBlobUrl = URL.createObjectURL(blob);
    img.onload = () => { img.style.opacity = '1'; document.getElementById('iv-dims').textContent = `${img.naturalWidth}×${img.naturalHeight}`; };
    img.src = _ivBlobUrl;
  } catch { toast('Could not load image', 'error'); }
}

function ivNav(d) { const n = _ivIndex + d; if (n >= 0 && n < _ivImages.length) { _ivIndex = n; _ivLoad(); } }
function ivDownloadCurrent() { const e = _ivImages[_ivIndex]; if (e) downloadFile(e.path, e.name); }

function _ivKey(e) {
  if (e.key === 'Escape') closeImageViewer();
  else if (e.key === 'ArrowLeft') ivNav(-1);
  else if (e.key === 'ArrowRight') ivNav(1);
  else if (e.key === '+' || e.key === '=') ivZoomIn();
  else if (e.key === '-') ivZoomOut();
  else if (e.key === 'f' || e.key === 'F') ivFit();
  else if (e.key === '0') ivActual();
}

function _ivApply() {
  const img = document.getElementById('iv-img');
  img.style.transform = `translate(${_ivTx}px,${_ivTy}px) scale(${_ivZoom})`;
  document.getElementById('iv-zoom-pct').textContent = Math.round(_ivZoom * 100) + '%';
  img.style.cursor = _ivZoom > 1 ? 'grab' : 'default';
}
function ivZoomIn()  { _ivZoom = Math.min(_ivZoom * 1.25, 10); _ivApply(); }
function ivZoomOut() { _ivZoom = Math.max(_ivZoom / 1.25, 0.1); if (_ivZoom <= 1) { _ivTx = 0; _ivTy = 0; } _ivApply(); }
function ivFit()     { _ivZoom = 1; _ivTx = 0; _ivTy = 0; _ivApply(); }
function ivActual()  { const img = document.getElementById('iv-img'); if (!img.naturalWidth) return; _ivZoom = img.naturalWidth / document.getElementById('iv-canvas').offsetWidth; _ivTx = 0; _ivTy = 0; _ivApply(); }
function ivWheel(e)  { e.preventDefault(); _ivZoom = Math.max(0.1, Math.min(10, _ivZoom * (e.deltaY > 0 ? 0.85 : 1.18))); if (_ivZoom <= 1) { _ivTx = 0; _ivTy = 0; } _ivApply(); }
function ivDragStart(e) { if (e.button !== 0 || _ivZoom <= 1) return; _ivDragging = true; _ivDrag0 = {x:e.clientX,y:e.clientY,tx:_ivTx,ty:_ivTy}; document.getElementById('iv-img').style.cursor = 'grabbing'; }
function ivDragMove(e)  { if (!_ivDragging) return; _ivTx = _ivDrag0.tx + (e.clientX - _ivDrag0.x); _ivTy = _ivDrag0.ty + (e.clientY - _ivDrag0.y); document.getElementById('iv-img').style.transform = `translate(${_ivTx}px,${_ivTy}px) scale(${_ivZoom})`; }
function ivDragEnd()    { _ivDragging = false; if (_ivZoom > 1) document.getElementById('iv-img').style.cursor = 'grab'; }

// ── PDF Viewer — opens in new browser tab ────────────────────────────────────

const PDF_EXTS = new Set(['pdf']);
let _pvEntry = null;

function isPdfFile(name) { return PDF_EXTS.has((name.split('.').pop() || '').toLowerCase()); }

// NOT async: window.open must run synchronously inside the click gesture,
// otherwise the browser's popup blocker kills it (the old bug — PDFs "didn't open").
function openPdfViewer(dirIdx) {
  const entry = dirEntries[dirIdx]; if (!entry) return;
  _pvEntry = entry;
  const tab = window.open('', '_blank');
  if (!tab) { toast('Allow popups for this site to open PDFs', 'error', 5000); return; }
  tab.document.write('<title>' + entry.name.replace(/[<>]/g, '') + '</title><body style="margin:0;background:#1e1e1e;color:#9aa;font-family:system-ui"><p style="padding:24px">Loading PDF…</p></body>');
  const url = `${API}/api/files/download?drive=${currentDriveId}&path=${encodeURIComponent(entry.path)}`;
  fetch(url, {headers: authToken ? {Authorization:`Bearer ${authToken}`} : {}, credentials:'include'})
    .then(r => { if (!r.ok) throw new Error('http'); return r.blob(); })
    .then(blob => {
      const blobUrl = URL.createObjectURL(new Blob([blob], {type:'application/pdf'}));
      tab.location.href = blobUrl;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    })
    .catch(() => { try { tab.document.body.innerHTML = '<p style="padding:24px;color:#e77">Could not load PDF.</p>'; } catch {} });
}

function closePdfViewer() {}  // kept for Esc handler compatibility
function pvDownload() { if (_pvEntry) downloadFile(_pvEntry.path, _pvEntry.name); }

// ── HTML sanitizer for rendered file content ──────────────────────────────────
// A .md or .docx on a drive is attacker-controlled. marked/mammoth emit raw HTML,
// so dropping it into innerHTML is stored XSS (e.g. <img onerror> exfiltrating the
// session). Run everything through DOMPurify first; if it can't load, fail CLOSED
// by escaping to plain text rather than rendering unsanitized markup.
let _purifyReady = null;
function _ensurePurify() {
  if (window.DOMPurify) return Promise.resolve(true);
  return (_purifyReady ??= new Promise(res => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js';
    s.onload = () => res(true); s.onerror = () => res(false);
    document.head.appendChild(s);
  }));
}
async function _safeHtml(dirty) {
  await _ensurePurify();
  return window.DOMPurify ? DOMPurify.sanitize(dirty) : `<pre>${esc(dirty)}</pre>`;
}

// ── DOCX Viewer ───────────────────────────────────────────────────────────────

const DOCX_EXTS = new Set(['docx','doc']);
let _dvEntry = null;

function isDocxFile(name) { return DOCX_EXTS.has((name.split('.').pop() || '').toLowerCase()); }

async function openDocxViewer(dirIdx) {
  const entry = dirEntries[dirIdx]; if (!entry) return;
  _dvEntry = entry;
  show('docx-viewer'); document.body.style.overflow = 'hidden';
  document.getElementById('dv-filename').textContent = entry.name;
  const body = document.getElementById('dv-body');
  body.innerHTML = `<div class="dv-loading"><span class="spinner" style="width:20px;height:20px;border-width:2.5px"></span><span>Loading document…</span></div>`;
  if (!window.mammoth) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  try {
    const url = `${API}/api/files/download?drive=${currentDriveId}&path=${encodeURIComponent(entry.path)}`;
    const r = await fetch(url, {headers: authToken ? {Authorization:`Bearer ${authToken}`} : {}, credentials:'include'});
    const ab = await r.arrayBuffer();
    const result = await mammoth.convertToHtml({arrayBuffer: ab});
    body.innerHTML = `<div class="dv-paper">${await _safeHtml(result.value)}</div>`;
  } catch { toast('Could not load document', 'error'); closeDocxViewer(); }
}

function closeDocxViewer() { hide('docx-viewer'); document.body.style.overflow = ''; _dvEntry = null; }
function dvDownload() { if (_dvEntry) downloadFile(_dvEntry.path, _dvEntry.name); }

// ── Text / Markdown Editor ─────────────────────────────────────────────────────

const TEXT_EXTS = new Set(['txt','md','markdown','log','json','csv','xml','yaml','yml','ini','conf','cfg','sh','py','js','ts','css','html','env']);
let _tvEntry = null, _tvDirty = false, _tvPreview = false, _tvSaveTimer = null;

function isTextFile(name) { return TEXT_EXTS.has((name.split('.').pop() || '').toLowerCase()); }
function _tvIsMd(name) { const e = (name.split('.').pop() || '').toLowerCase(); return e === 'md' || e === 'markdown'; }

async function openTextViewer(idx) {
  const entries = (typeof _filtered !== 'undefined' && _filtered) || dirEntries;
  const entry = entries[idx]; if (!entry) return;
  _tvEntry = entry; _tvDirty = false; _tvPreview = false;
  document.getElementById('tv-filename').textContent = entry.name;
  document.getElementById('tv-dirty').style.display = 'none';
  const pvBtn = document.getElementById('tv-preview-btn');
  pvBtn.style.display = _tvIsMd(entry.name) ? '' : 'none';
  pvBtn.classList.remove('active');
  const pvEl = document.getElementById('tv-preview');
  pvEl.style.display = 'none'; pvEl.innerHTML = '';
  const ta = document.getElementById('tv-edit');
  ta.style.display = ''; ta.value = 'Loading…'; ta.disabled = true;
  document.getElementById('tv-autosave-btn')?.classList.toggle('active', localStorage.getItem('ll-autosave') === '1');
  show('text-viewer'); document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', _tvKey);
  try {
    const url = `${API}/api/files/download?drive=${currentDriveId}&path=${encodeURIComponent(entry.path)}`;
    const r = await fetch(url, {headers: authToken ? {Authorization:`Bearer ${authToken}`} : {}, credentials:'include'});
    if (!r.ok) throw new Error('http ' + r.status);
    ta.value = await r.text(); ta.disabled = false; ta.focus();
  } catch (e) { console.error('[text] load failed', e); toast('Could not open file', 'error'); closeTextViewer(); }
}

function tvOnInput() {
  _tvDirty = true; document.getElementById('tv-dirty').style.display = '';
  if (localStorage.getItem('ll-autosave') !== '1') return;
  clearTimeout(_tvSaveTimer);            // debounce — save ~1s after typing stops
  _tvSaveTimer = setTimeout(() => { if (_tvDirty) tvSave(); }, 1000);
}

function tvToggleAutosave() {
  const on = localStorage.getItem('ll-autosave') !== '1';
  localStorage.setItem('ll-autosave', on ? '1' : '0');
  document.getElementById('tv-autosave-btn')?.classList.toggle('active', on);
  toast(on ? 'Autosave on' : 'Autosave off', 'success', 1800);
  if (on && _tvDirty) tvSave();
}

function _tvKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); tvSave(); }
  else if (e.key === 'Escape') closeTextViewer();
}

async function tvTogglePreview() {
  _tvPreview = !_tvPreview;
  const ta = document.getElementById('tv-edit'), pv = document.getElementById('tv-preview');
  const btn = document.getElementById('tv-preview-btn');
  btn?.classList.toggle('active', _tvPreview);
  if (!_tvPreview) {
    // Back to edit — show exactly one pane.
    pv.style.display = 'none'; pv.innerHTML = ''; ta.style.display = 'block';
    return;
  }
  if (!window.marked) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    }).catch(() => {});
  }
  pv.innerHTML = window.marked ? await _safeHtml(marked.parse(ta.value)) : `<pre>${esc(ta.value)}</pre>`;
  // Show exactly one pane — hide the editor, reveal the preview.
  ta.style.display = 'none'; pv.style.display = 'block';
}

async function tvSave() {
  if (!_tvEntry) return;
  const ta = document.getElementById('tv-edit');
  const btn = document.getElementById('tv-save-btn'); btn.disabled = true;
  // Overwrite by re-uploading into the parent dir under the same name.
  const slash = _tvEntry.path.lastIndexOf('/');
  const dir = slash > 0 ? _tvEntry.path.slice(0, slash) : '/';
  const fd = new FormData();
  fd.append('file', new File([ta.value], _tvEntry.name, {type:'text/plain'}));
  try {
    const url = `${API}/api/files/upload?drive=${currentDriveId}&path=${encodeURIComponent(dir || '/')}`;
    const r = await fetch(url, {method:'POST', headers: authToken ? {Authorization:`Bearer ${authToken}`} : {}, credentials:'include', body: fd});
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.detail || ('http ' + r.status)); }
    _tvDirty = false; document.getElementById('tv-dirty').style.display = 'none';
    toast('Saved', 'success', 2000);
  } catch (e) { console.error('[text] save failed', e); toast('Save failed: ' + e.message, 'error', 6000); }
  finally { btn.disabled = false; }
}

function closeTextViewer() {
  if (_tvDirty && !confirm('Discard unsaved changes?')) return;
  clearTimeout(_tvSaveTimer);
  hide('text-viewer'); document.body.style.overflow = '';
  document.removeEventListener('keydown', _tvKey);
  _tvEntry = null; _tvDirty = false;
}
