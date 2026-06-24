// ── Global keyboard shortcuts ─────────────────────────────────────────────────

document.addEventListener('click', closeCtxMenu);

document.addEventListener('keydown', e => {
  // Ctrl+K → command palette
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openCmdPalette(); return; }
  // Command palette captures all keys while open
  if (!document.getElementById('cmd-palette').classList.contains('hidden')) { _cmdKey(e); return; }
  if (e.key === 'Escape') {
    closeCtxMenu();
    if (!document.getElementById('pdf-viewer').classList.contains('hidden'))      { closePdfViewer(); return; }
    if (!document.getElementById('docx-viewer').classList.contains('hidden'))     { closeDocxViewer(); return; }
    if (!document.getElementById('image-viewer').classList.contains('hidden'))    { closeImageViewer(); return; }
    if (!document.getElementById('ota-modal').classList.contains('hidden'))       { closeOtaModal(); return; }
    if (!document.getElementById('settings-overlay').classList.contains('hidden')) { closeSettings(); return; }
    if ((e.target || {}).tagName !== 'INPUT') clearSel();
  }
  if ((e.target || {}).tagName === 'INPUT' || !currentDriveId) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    const entries = _filtered || dirEntries;
    _sel = new Set(entries.map(x => x.path)); _lastClickIdx = entries.length - 1;
    updateSelBar(); renderFiles(entries, currentPath);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

checkAuth();
