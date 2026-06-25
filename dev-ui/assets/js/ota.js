let _ota_timer = null, _otaData = null;

const GH_REPO = 'MeridianAlgo/LiteLayer';

function updateVersionChip(d) {
  const ver = d?.current_version ? `v${d.current_version}` : 'v—';
  ['sb-version','snav-version','about-version'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = ver;
  });
  const dot = document.getElementById('sv-dot'); if (!dot) return;
  dot.classList.remove('green','yellow');
  if (d?.update_available)    dot.classList.add('yellow');
  else if (d?.github_reachable) dot.classList.add('green');
}

async function checkOtaStatus() {
  try {
    const r = await api('/api/ota/status'); if (!r) return null;
    const d = await r.json(); _otaData = d; renderOta(d); return d;
  } catch { return null; }
}

function renderOta(d) {
  const badge = document.getElementById('ota-badge'), banner = document.getElementById('ota-banner');
  updateVersionChip(d);
  if (!d) { badge.style.background = 'transparent'; return; }
  if (d.update_available) {
    badge.style.background = 'var(--yellow)';
    if (banner && !banner.dataset.dismissed) {
      const desc = document.getElementById('ota-banner-desc');
      if (desc) desc.textContent = d.latest_version ? ` — v${d.current_version} → v${d.latest_version}` : ' — new version available';
      banner.classList.remove('hidden');
    }
  } else if (d.github_reachable) {
    badge.style.background = 'var(--green)'; if (banner) banner.classList.add('hidden');
  } else { badge.style.background = 'transparent'; }
}

async function applyOtaFromBanner() {
  document.getElementById('ota-banner').classList.add('hidden');
  openOtaModal();
}

function dismissOtaBanner() {
  const b = document.getElementById('ota-banner'); b.classList.add('hidden'); b.dataset.dismissed = '1';
}

function startOtaPoll(ms = 60000) {
  if (_ota_timer) return; checkOtaStatus(); _checkLastUpdateResult(); _ota_timer = setInterval(checkOtaStatus, ms);
}

// After a reload, surface whether the last update actually did anything.
async function _checkLastUpdateResult() {
  try {
    const r = await api('/api/ota/result'); if (!r?.ok) return;
    const d = await r.json();
    if (d.ok === null || !d.at) return;
    if (sessionStorage.getItem('ll-ota-result-seen') === d.at) return;
    sessionStorage.setItem('ll-ota-result-seen', d.at);
    if (d.ok === false) toast(d.message || 'Last update did not complete', 'error', 7000);
    else if (d.ok === true) toast(d.message || 'Update applied', 'success', 4000);
  } catch {}
}

let _otaSelectedSha = null;  // null = latest

function selectOtaVersion(sha, el) {
  if (el && el.classList.contains('current')) return;  // already installed
  _otaSelectedSha = sha;
  document.querySelectorAll('.ota-ver-item').forEach(x => x.classList.remove('selected'));
  if (el) el.classList.add('selected');
  const runBtn = document.getElementById('ota-modal-run-btn');
  if (runBtn) {
    // Picking any version enables install — including downgrades while "up to date".
    runBtn.disabled = false;
    runBtn.textContent = sha ? `Install ${sha.slice(0,7)}` : 'Apply Update';
  }
}

async function openOtaModal() {
  if (!_otaData) await checkOtaStatus();
  const d = _otaData;
  _otaSelectedSha = null;
  document.querySelectorAll('#ota-steps .ota-step').forEach(s => s.classList.remove('active','done'));
  document.getElementById('ota-bar-fill').style.width = '0%';
  document.getElementById('ota-countdown').textContent = '';
  const logDetails = document.getElementById('ota-log-details');
  if (logDetails) logDetails.style.display = 'none';
  const runBtn = document.getElementById('ota-modal-run-btn'), cancelBtn = document.getElementById('ota-cancel-btn');
  runBtn.disabled = false; runBtn.textContent = 'Apply Update'; cancelBtn.style.display = '';

  // Installed version
  document.getElementById('ota-cur-ver').textContent = d?.current_version ? `v${d.current_version}` : '—';

  // Status row
  const statusEl = document.getElementById('ota-status-val');
  if (statusEl) {
    if (!d?.github_reachable) {
      statusEl.innerHTML = `<span style="color:var(--text-3)">GitHub unreachable</span>`;
      runBtn.disabled = true;
    } else if (!d?.update_available) {
      statusEl.innerHTML = `<span style="color:var(--green)">Up to date · v${d?.current_version || '—'}</span>`;
      runBtn.disabled = true; runBtn.textContent = 'Up to date';
    } else {
      statusEl.innerHTML = `<span style="color:var(--yellow)">v${d.latest_version || d.current_version} available</span>`;
    }
  }

  const isMajor = d?.is_major || false;
  document.getElementById('ota-major-warn').style.display = isMajor ? 'block' : 'none';
  if (isMajor && d?.update_available) runBtn.textContent = 'Full Reinstall';

  // Version picker — show release TAGS (v0.1.0 …), not raw commits.
  const verWrap = document.getElementById('ota-ver-pick-wrap');
  const verList = document.getElementById('ota-ver-list');
  if (verWrap && verList) {
    let tags = [];
    try { const tr = await api('/api/ota/tags'); if (tr?.ok) tags = (await tr.json()).tags || []; } catch {}
    if (tags.length) {
      verList.innerHTML = tags.map((t, i) => {
        const ghUrl = `https://github.com/${GH_REPO}/releases/tag/${t.name}`;
        return `<div class="ota-ver-item${t.current ? ' current' : i === 0 && !tags.some(x => x.current) ? ' selected' : ''}" data-sha="${t.sha}"
          onclick="selectOtaVersion('${t.sha}',this)">
          <span class="ota-ver-sha">${esc(t.name)}</span>
          <a class="ota-ver-msg" href="${ghUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--text-3)">release notes ↗</a>
          ${t.current ? `<span class="ota-cur-tag">installed</span>` : ''}
        </div>`;
      }).join('');
      verWrap.style.display = '';
    } else {
      verWrap.style.display = 'none';
    }
  }

  // Versions only — no raw commit shas in the updater (tags link to GitHub above).
  show('ota-modal');
}

function closeOtaModal() { hide('ota-modal'); }

async function applyOtaUpdate() {
  const isMajor = _otaData?.is_major || false;
  const runBtn = document.getElementById('ota-modal-run-btn'), cancelBtn = document.getElementById('ota-cancel-btn');
  runBtn.disabled = true; runBtn.innerHTML = '<span class="spinner"></span>'; cancelBtn.style.display = 'none';
  const steps = document.querySelectorAll('#ota-steps .ota-step');
  const logDetails = document.getElementById('ota-log-details');
  const logPre = document.getElementById('ota-log-pre');

  const setStep = n => {
    steps.forEach((s, i) => {
      s.classList.remove('active','done');
      if (i < n) s.classList.add('done'); else if (i === n) s.classList.add('active');
    });
    document.getElementById('ota-bar-fill').style.width = `${Math.round((n + 1) / steps.length * 85)}%`;
  };

  setStep(0);
  await new Promise(r => setTimeout(r, 400));

  // Show live log
  if (logDetails) { logDetails.style.display = ''; logDetails.open = false; }
  if (logPre) logPre.textContent = 'Starting…';

  let _logPoll = null;
  const startLogPoll = () => {
    _logPoll = setInterval(async () => {
      try {
        const lr = await api('/api/ota/logs?lines=40');
        if (lr?.ok) { const ld = await lr.json(); if (logPre) { logPre.textContent = ld.logs || ''; logPre.scrollTop = logPre.scrollHeight; } }
      } catch {}
    }, 2000);
  };
  startLogPoll();

  try {
    // A specifically-picked version always wins (lets you downgrade to any sha).
    const body = _otaSelectedSha ? {sha: _otaSelectedSha} : (isMajor ? {reinstall: true} : {});
    const r = await api('/api/ota/update', {method:'POST', body: JSON.stringify(body)});
    if (!r?.ok) {
      clearInterval(_logPoll);
      const j = await r?.json(); toast(j?.detail || 'Update failed', 'error', 5000);
      runBtn.disabled = false; runBtn.textContent = 'Retry'; cancelBtn.style.display = ''; return;
    }
    setStep(1); await new Promise(r => setTimeout(r, 1600));
    setStep(2); await new Promise(r => setTimeout(r, 900));
    document.getElementById('ota-bar-fill').style.width = '100%';
    steps.forEach(s => { s.classList.remove('active'); s.classList.add('done'); });
    clearInterval(_logPoll);
    // Lock the whole app behind a full-screen overlay while the service restarts —
    // nothing the user clicks in those ~20s would reach the backend anyway.
    const ov = document.getElementById('reconnect-overlay'); ov?.classList.remove('hidden');
    const rs = document.getElementById('reconnect-status');
    let sec = 20; const cd = document.getElementById('ota-countdown');
    const t = setInterval(() => {
      cd.textContent = `Reconnecting in ${sec}s…`;
      if (rs) rs.textContent = `LiteLayer is restarting — keep this tab open. Reconnecting in ${sec}s…`;
      if (--sec < 0) { clearInterval(t); window.location.reload(); }
    }, 1000);
  } catch {
    clearInterval(_logPoll);
    toast('Update request failed', 'error');
    runBtn.disabled = false; runBtn.textContent = 'Retry'; cancelBtn.style.display = '';
  }
}

// ── Changelog ─────────────────────────────────────────────────────────────────

let _clCache = null, _clLoaded = false;

async function loadChangelog() {
  const box = document.getElementById('cl-timeline-box');
  if (!box) return;
  if (_clLoaded && _clCache) { renderChangelog(_clCache); return; }
  box.innerHTML = `<div class="cl-loading"><span class="spinner" style="width:18px;height:18px;border-width:2px"></span>Loading changelog…</div>`;
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/commits?per_page=20&sha=main`);
    if (!r.ok) throw new Error('GitHub API error');
    _clCache = await r.json(); _clLoaded = true;
    renderChangelog(_clCache);
  } catch {
    box.innerHTML = `<div class="cl-error">Could not load changelog.<br><small>Check your internet connection.</small></div>`;
  }
}

function renderChangelog(commits) {
  const box = document.getElementById('cl-timeline-box');
  const currentSha = _otaData?.current_sha;
  const latestSha  = _otaData?.latest_sha;
  const badge = document.getElementById('cl-status-badge');

  if (badge) {
    // Only flag when there's actually an update — no "Up to date" pill (you can
    // already see that from the version once you've installed it).
    if (_otaData?.update_available) {
      badge.style.display = '';
      badge.className = 'cl-badge update-avail';
      const ver = _otaData.latest_version ? `v${_otaData.latest_version}` : (_otaData.latest_sha?.slice(0,7) || 'update');
      badge.innerHTML = `<svg width="7" height="7" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>${esc(ver)} available`;
    } else {
      badge.style.display = 'none';
    }
  }

  let passedCurrent = false;
  box.innerHTML = `<div class="cl-timeline">${commits.map(c => {
    const sha7    = c.sha.slice(0,7);
    const isCur   = currentSha && c.sha.startsWith(currentSha);
    const isNew   = !passedCurrent && latestSha && !isCur;
    if (isCur) passedCurrent = true;
    const msg     = (c.commit.message || '').split('\n')[0];
    const author  = c.commit.author?.name || 'unknown';
    const relTime = fmtRelative(c.commit.author?.date || c.commit.committer?.date);
    const ghUrl   = c.html_url || `https://github.com/${GH_REPO}/commit/${c.sha}`;
    return `<div class="cl-entry${isCur ? ' current' : isNew ? ' new' : ''}">
      <div class="cl-dot"></div>
      <div class="cl-body">
        <a class="cl-sha" href="${ghUrl}" target="_blank" rel="noopener">${sha7}</a>
        ${isCur ? `<span style="font-size:10px;font-family:var(--mono);color:var(--green);margin-left:6px">← current</span>` : ''}
        <div class="cl-msg" title="${esc(msg)}">${esc(msg)}</div>
        <div class="cl-meta">${esc(author)} · ${relTime}</div>
      </div>
    </div>`;
  }).join('')}</div>`;
}
