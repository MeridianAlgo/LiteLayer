function fmt(b) {
  if (!b) return '—';
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
}

function fmtRelative(iso) {
  const d = new Date(iso), now = Date.now(), diff = now - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, {month:'short', day:'numeric'});
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

function toast(msg, type = 'info', dur = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${{success:'✓',error:'✕',info:'ℹ'}[type]||''}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0'; el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, dur);
}

// Show a full-screen "still working" loader when a foreground request runs long.
// Background polls pass {bg:true} so the periodic stats/OTA checks never trigger it.
let _apiInflight = 0, _slowTimer = null;
function _slowLoader(show) {
  document.getElementById('slow-loader')?.classList.toggle('hidden', !show);
}
async function api(path, opts = {}) {
  const {bg, ...fetchOpts} = opts;
  const headers = {'Content-Type':'application/json', ...(opts.headers || {})};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (!bg) {
    _apiInflight++;
    if (!_slowTimer) _slowTimer = setTimeout(() => _slowLoader(true), 4000);
  }
  try {
    const r = await fetch(API + path, {...fetchOpts, headers, credentials:'include'});
    if (r.status === 401) { showLogin(); return null; }
    return r;
  } finally {
    if (!bg && --_apiInflight <= 0) {
      _apiInflight = 0; clearTimeout(_slowTimer); _slowTimer = null; _slowLoader(false);
    }
  }
}

// Classify a file into one of the customisable type buckets.
function fileType(name, isDir) {
  if (isDir) return 'folder';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg','jpeg','png','gif','webp','svg','heic','raw','tiff','bmp','avif','ico'].includes(ext)) return 'image';
  if (['mp4','mov','avi','mkv','wmv','flv','m4v','webm'].includes(ext)) return 'video';
  if (['mp3','flac','wav','aac','ogg','m4a','wma'].includes(ext)) return 'audio';
  if (['py','js','ts','jsx','tsx','html','css','sh','rb','go','rs','c','cpp','java','php','vue','json','yaml','yml','xml','toml','ini','sql'].includes(ext)) return 'code';
  if (['zip','tar','gz','7z','rar','bz2','xz'].includes(ext)) return 'archive';
  if (['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','log','csv'].includes(ext)) return 'doc';
  return 'other';
}

const _TYPE_ICONS = {
  folder:  '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>',
  image:   '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  video:   '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  audio:   '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  code:    '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  doc:     '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  other:   '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
};

// Icon color uses the customisable --ic-<type> var; falls back for "other".
function iconColorVar(type) { return type === 'other' ? 'var(--text-2)' : `var(--ic-${type})`; }
function textColorVar(type) { return type === 'other' ? '' : `var(--ft-${type})`; }

function fileIconHtml(name, isDir, sz = 15, xc = '') {
  const type = fileType(name, isDir);
  const col = iconColorVar(type);
  const bg = type === 'other' ? 'var(--surface)' : `color-mix(in srgb, ${col} 14%, transparent)`;
  return `<div class="fi-wrap ${xc}" style="background:${bg};color:${col}"><svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${_TYPE_ICONS[type]}</svg></div>`;
}
