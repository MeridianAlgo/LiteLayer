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

// ── PDF Viewer ────────────────────────────────────────────────────────────────

const PDF_EXTS = new Set(['pdf']);
let _pvBlobUrl = null, _pvEntry = null;

function isPdfFile(name) { return PDF_EXTS.has((name.split('.').pop() || '').toLowerCase()); }

async function openPdfViewer(dirIdx) {
  const entry = dirEntries[dirIdx]; if (!entry) return;
  _pvEntry = entry;
  show('pdf-viewer'); document.body.style.overflow = 'hidden';
  document.getElementById('pv-filename').textContent = entry.name;
  const frame = document.getElementById('pv-frame'), loading = document.getElementById('pv-loading');
  frame.style.display = 'none'; loading.style.display = 'flex'; frame.src = '';
  if (_pvBlobUrl) { URL.revokeObjectURL(_pvBlobUrl); _pvBlobUrl = null; }
  try {
    const url = `${API}/api/files/download?drive=${currentDriveId}&path=${encodeURIComponent(entry.path)}`;
    const r = await fetch(url, {headers: authToken ? {Authorization:`Bearer ${authToken}`} : {}, credentials:'include'});
    const blob = await r.blob();
    _pvBlobUrl = URL.createObjectURL(new Blob([blob], {type:'application/pdf'}));
    frame.src = _pvBlobUrl;
    frame.onload = () => { loading.style.display = 'none'; frame.style.display = 'block'; };
  } catch { toast('Could not load PDF', 'error'); closePdfViewer(); }
}

function closePdfViewer() {
  hide('pdf-viewer'); document.body.style.overflow = '';
  document.getElementById('pv-frame').src = '';
  document.getElementById('pv-frame').style.display = 'none';
  if (_pvBlobUrl) { URL.revokeObjectURL(_pvBlobUrl); _pvBlobUrl = null; }
  _pvEntry = null;
}

function pvDownload() { if (_pvEntry) downloadFile(_pvEntry.path, _pvEntry.name); }

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
    body.innerHTML = `<div class="dv-paper">${result.value}</div>`;
  } catch { toast('Could not load document', 'error'); closeDocxViewer(); }
}

function closeDocxViewer() { hide('docx-viewer'); document.body.style.overflow = ''; _dvEntry = null; }
function dvDownload() { if (_dvEntry) downloadFile(_dvEntry.path, _dvEntry.name); }
