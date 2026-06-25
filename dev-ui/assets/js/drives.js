async function loadDrives() {
  const list = document.getElementById('drives-list');
  list.innerHTML = '<div class="skeleton" style="height:106px;border-radius:10px;margin:0 2px 6px"></div>'.repeat(2);
  const r = await api('/api/drives'); if (!r) return;
  const drives = await r.json();
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
  return `<div class="sb-drive${active ? ' active' : ''}" id="sbcard-${esc(d.id)}">
    <div class="sb-drive-top">
      <div class="sb-drive-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 5v14c0 1.66-4.03 3-9 3S3 20.66 3 19V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg></div>
      <div class="sb-drive-info"><div class="sb-drive-name" title="${esc(d.label)}">${esc(d.label)}</div><div class="sb-drive-dev">${esc(d.device)}</div></div>
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
  const r = await api('/api/system/stats'); if (!r?.ok) return;
  const s = await r.json();
  const cpu = document.getElementById('pill-cpu-val'), temp = document.getElementById('pill-temp-val');
  if (cpu)  cpu.textContent  = s.cpu_percent == null ? '—' : s.cpu_percent + '%';
  if (temp) temp.textContent = s.temp_c == null ? '—' : s.temp_c + '°C';
  const cpuPill = document.getElementById('pill-cpu');
  if (cpuPill) cpuPill.classList.toggle('busy', (s.cpu_percent || 0) > 85);
  const tempPill = document.getElementById('pill-temp');
  if (tempPill) tempPill.classList.toggle('hot', (s.temp_c || 0) >= 75);
  const power = document.getElementById('pill-power');
  if (power) power.style.display = s.undervoltage ? '' : 'none';
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
    if (currentDriveId === id) { currentDriveId = null; hide('files-area'); show('view-welcome'); setBreadcrumb([]); }
    loadDrives();
  } else { const d = await r.json(); toast(d.detail || 'Unmount failed', 'error', 5000); }
}
