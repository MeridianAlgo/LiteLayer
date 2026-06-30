let _drives = [];   // last-loaded drive list (for the right-click menu / properties)

async function loadDrives() {
  const list = document.getElementById('drives-list');
  list.innerHTML = '<div class="skeleton" style="height:106px;border-radius:10px;margin:0 2px 6px"></div>'.repeat(2);
  const r = await api('/api/drives'); if (!r) return;
  const drives = await r.json();
  _drives = drives;
  if (!drives.length) {
    list.innerHTML = `<div style="padding:18px 8px;text-align:center;font-size:11px;color:var(--text-3)">No drives detected<br><br>Plug in a USB drive<br>and click ↻</div>`;
    return;
  }
  list.innerHTML = drives.map(d => sbDriveCard(d)).join('');
}

function sbDriveCard(d) {
  const used = d.used_bytes || 0, total = d.size_bytes || 1, pct = total > 0 ? Math.round(used / total * 100) : 0;
  const barCls = pct > 90 ? 'crit' : pct > 75 ? 'warn' : '';
  const mounted = d.state !== 'unmounted', active = d.id === currentDriveId;
  const fsColors = {ntfs:'#60a5fa',exfat:'#34d399',vfat:'#f472b6',fat32:'#f472b6',ext4:'#a78bfa',ext3:'#a78bfa',btrfs:'#fb923c',xfs:'#facc15',hfsplus:'#94a3b8','iso9660':'#94a3b8'};
  const fc = fsColors[(d.fstype || '').toLowerCase()] || '#a78bfa';
  const locked = isDriveLockedConfig(d.id);
  return `<div class="sb-drive${active ? ' active' : ''}" id="sbcard-${esc(d.id)}"
    oncontextmenu="showDriveCtxMenu(event,'${esc(d.id)}');return false"
    ondragover="onDriveDragOver(event,'${esc(d.id)}')" ondragleave="this.classList.remove('drop-target')" ondrop="onDriveDrop(event,'${esc(d.id)}')">
    <div class="sb-drive-top">
      <div class="sb-drive-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 5v14c0 1.66-4.03 3-9 3S3 20.66 3 19V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg></div>
      <div class="sb-drive-info"><div class="sb-drive-name" title="${esc(d.label)} — double-click to rename" ondblclick="event.stopPropagation();renameDrive('${esc(d.id)}','${esc(d.label)}')">${esc(d.label)}</div><div class="sb-drive-dev">${esc(d.device)}</div></div>
      <button class="btn btn-ghost btn-xs sb-rename-btn" title="Rename drive" onclick="event.stopPropagation();renameDrive('${esc(d.id)}','${esc(d.label)}')"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z"/></svg></button>
      ${locked ? `<span class="sb-lock" title="Drive is PIN-locked"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></span>` : ''}
      <div class="sb-fs-tag" style="background:${fc}18;color:${fc};border:1px solid ${fc}33">${esc(d.fstype)}</div>
    </div>
    ${mounted ? `<div><div class="sb-bar-track"><div class="sb-bar-fill ${barCls}" style="width:${pct}%"></div></div><div class="sb-bar-stats"><span>${fmt(used)}</span><span>${fmt(d.free_bytes)} free</span></div></div>` : ''}
    <div class="sb-drive-actions">
      ${mounted
        ? `<button class="btn btn-ghost btn-xs flex-1" onclick="browseFiles('${esc(d.id)}','${esc(d.label)}')"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>Browse</button>
           ${d.id === 'system-root' ? '' : `<button class="btn btn-ghost btn-xs" onclick="unmountDrive('${esc(d.id)}')" title="Eject"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 9l6 6m0-6l-6 6"/><circle cx="12" cy="12" r="9"/></svg></button>`}`
        : `<button class="btn btn-primary btn-xs flex-1" onclick="mountDrive('${esc(d.id)}')"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>Mount</button>`}
    </div>
  </div>`;
}

// ── Live CPU / temp / power pills ───────────────────────────────────────────────
let _statsPoll = null;
function startStatsPoll() {
  if (_statsPoll) return;
  loadStats();
  _statsPoll = setInterval(loadStats, 4000);
}
async function loadStats() {
  const r = await api('/api/system/stats', {bg: true}); if (!r?.ok) return;
  const s = await r.json();
  const cpu = document.getElementById('pill-cpu-val'), temp = document.getElementById('pill-temp-val');
  if (cpu)  cpu.textContent  = s.cpu_percent == null ? '—' : s.cpu_percent + '%';
  if (temp) temp.textContent = s.temp_c == null ? '—' : s.temp_c + '°C';
  const cpuPill = document.getElementById('pill-cpu');
  if (cpuPill) cpuPill.classList.toggle('busy', (s.cpu_percent || 0) > 85);
  const tempPill = document.getElementById('pill-temp');
  if (tempPill) tempPill.classList.toggle('hot', (s.temp_c || 0) >= 75);
  const watts = document.getElementById('pill-watts'), wv = document.getElementById('pill-watts-val');
  if (watts) {
    if (s.watts == null) { watts.style.display = 'none'; }
    else { watts.style.display = ''; if (wv) wv.textContent = s.watts + ' W'; }
  }
  const power = document.getElementById('pill-power');
  if (power) power.style.display = s.undervoltage ? '' : 'none';
}

async function renameDrive(id, current) {
  const name = prompt('Rename drive (nickname only — your files are untouched):', current);
  if (name == null) return;
  const r = await api(`/api/drives/${id}/rename`, {method: 'POST', body: JSON.stringify({label: name.trim()})});
  if (!r?.ok) { toast('Rename failed', 'error'); return; }
  const d = await r.json();
  if (currentDriveId === id) { currentDriveLabel = d.label; setBreadcrumb(_crumbsFor(currentPath)); }
  toast('Drive renamed', 'success', 2000); loadDrives();
}

async function mountDrive(id) {
  toast('Mounting…', 'info', 1500);
  const r = await api(`/api/drives/${id}/mount`, {method: 'POST'}); if (!r) return;
  if (r.ok) { toast('Drive mounted', 'success'); loadDrives(); }
  else { const d = await r.json(); toast(d.detail || 'Mount failed', 'error', 5000); }
}

async function unmountDrive(id) {
  toast('Ejecting…', 'info', 1500);
  const r = await api(`/api/drives/${id}/unmount`, {method: 'POST'}); if (!r) return;
  if (r.ok) {
    toast('Drive ejected safely', 'success');
    if (currentDriveId === id) { currentDriveId = null; hide('files-area'); show('view-welcome'); setBreadcrumb([]); backToDrives(); }
    loadDrives();
  } else { const d = await r.json(); toast(d.detail || 'Unmount failed', 'error', 5000); }
}

// ── Drive right-click menu (Properties + PIN lock) ──────────────────────────────

function showDriveCtxMenu(e, id) {
  e.preventDefault(); closeCtxMenu();
  const d = _drives.find(x => x.id === id); if (!d) return;
  const locked = isDriveLockedConfig(id), mounted = d.state !== 'unmounted';
  const items = [];
  if (mounted) items.push(`<div class="ctx-item" onclick="browseFiles('${esc(id)}','${esc(d.label)}');closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>Browse</div>`);
  items.push(`<div class="ctx-item" onclick="showDriveProperties('${esc(id)}');closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>Properties</div>`);
  items.push(`<div class="ctx-sep"></div>`);
  if (locked)
    items.push(`<div class="ctx-item" onclick="removeDriveLock('${esc(id)}');closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/></svg>Turn off drive lock…</div>`);
  else
    items.push(`<div class="ctx-item" onclick="lockDriveSetup('${esc(id)}');closeCtxMenu()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Lock drive…</div>`);
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = items.join(''); menu.classList.remove('hidden');
  const vw = window.innerWidth, vh = window.innerHeight, mw = 180, mh = items.length * 34;
  menu.style.left = (e.clientX + mw > vw ? e.clientX - mw : e.clientX) + 'px';
  menu.style.top  = (e.clientY + mh > vh ? e.clientY - mh : e.clientY) + 'px';
}

function showDriveProperties(id) {
  const d = _drives.find(x => x.id === id); if (!d) return;
  const total = d.size_bytes || 0, used = d.used_bytes || 0;
  const pct = total ? Math.round(used / total * 100) : 0;
  const rows = [
    ['Name', d.label],
    ['Device', d.device],
    ['File system', (d.fstype || '—').toUpperCase()],
    ['Capacity', total ? fmt(total) : '—'],
    ['Used', used ? `${fmt(used)} · ${pct}%` : '—'],
    ['Free', d.free_bytes ? fmt(d.free_bytes) : '—'],
    ['Mount point', d.mount_point || 'Not mounted'],
    ['Access', d.state === 'mounted_rw' ? 'Read / write' : d.state === 'mounted_ro' ? 'Read-only' : 'Unmounted'],
    ['Drive lock', isDriveLockedConfig(id) ? 'On (PIN)' : 'Off'],
  ];
  document.getElementById('props-body').innerHTML = rows.map(([k, v]) =>
    `<div class="about-info-row"><div class="about-info-label">${k}</div><div class="about-info-value" style="word-break:break-word">${esc(v)}</div></div>`
  ).join('');
  show('props-modal');
}

// ── Per-drive PIN lock ──────────────────────────────────────────────────────────
// ponytail: UI-only convenience lock. State lives in this browser's localStorage and
// the PIN is a non-crypto hash (no secure context needed over plain-http LAN). The API
// still serves a locked drive's files to an authenticated request — this gates the UI,
// not the data. Upgrade path: a server-side per-drive PIN if it must be real security.

const _unlockedDrives = new Set();   // drives unlocked for this page session

function _driveLocks() { try { return JSON.parse(localStorage.getItem('ll-drive-locks') || '{}'); } catch { return {}; } }
function _saveDriveLocks(o) { localStorage.setItem('ll-drive-locks', JSON.stringify(o)); }
function _pinHash(pin) { let h = 5381; const s = 'll:' + pin; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16); }

function isDriveLockedConfig(id) { return !!_driveLocks()[id]; }      // a PIN is set
function driveNeedsPin(id) { return isDriveLockedConfig(id) && !_unlockedDrives.has(id); }

async function lockDriveSetup(id) {
  const pin = await askPassword('Lock drive', 'Choose a 4–6 digit PIN. You\'ll need it to open this drive.');
  if (pin == null) return;
  if (!/^\d{4,6}$/.test(pin)) { toast('PIN must be 4–6 digits', 'error'); return; }
  const conf = await askPassword('Confirm PIN', 'Re-enter the PIN to confirm.');
  if (conf == null) return;
  if (conf !== pin) { toast('PINs do not match', 'error'); return; }
  const locks = _driveLocks(); locks[id] = { h: _pinHash(pin) }; _saveDriveLocks(locks);
  _unlockedDrives.delete(id);
  toast('Drive locked', 'success'); loadDrives();
}

// Returns true once the correct PIN is entered (and unlocks it for this session).
async function unlockDrivePrompt(id) {
  if (!driveNeedsPin(id)) return true;
  const pin = await askPassword('Drive locked', 'Enter this drive\'s PIN to open it.');
  if (pin == null) return false;
  if (_pinHash(pin) !== (_driveLocks()[id] || {}).h) { toast('Wrong PIN', 'error'); return false; }
  _unlockedDrives.add(id); return true;
}

async function removeDriveLock(id) {
  const pin = await askPassword('Turn off drive lock', 'Enter the PIN to remove the lock on this drive.');
  if (pin == null) return;
  if (_pinHash(pin) !== (_driveLocks()[id] || {}).h) { toast('Wrong PIN', 'error'); return; }
  const locks = _driveLocks(); delete locks[id]; _saveDriveLocks(locks);
  _unlockedDrives.delete(id);
  toast('Drive lock removed', 'success'); loadDrives();
}
