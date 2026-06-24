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
      if (desc) desc.textContent = d.current_version ? ` — v${d.current_version} → ${d.latest_sha?.slice(0,7) || 'latest'}` : ` — ${d.latest_sha?.slice(0,7) || 'latest'}`;
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
  if (_ota_timer) return; checkOtaStatus(); _ota_timer = setInterval(checkOtaStatus, ms);
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
      statusEl.innerHTML = `<span style="color:var(--green)">✓ Up to date</span>`;
      runBtn.disabled = true; runBtn.textContent = 'Up to date';
    } else {
      statusEl.innerHTML = `<span style="color:var(--yellow)">${d.latest_sha?.slice(0,7)} available</span>`;
    }
  }

  const isMajor = d?.is_major || false;
  document.getElementById('ota-major-warn').style.display = isMajor ? 'block' : 'none';
  if (isMajor && d?.update_available) runBtn.textContent = 'Full Reinstall';

  // Version picker from changelog cache (or fetch)
  const verWrap = document.getElementById('ota-ver-pick-wrap');
  const verList = document.getElementById('ota-ver-list');
  if (verWrap && verList) {
    if (!_clCache) await loadChangelog().catch(() => {});
    if (_clCache?.length) {
      verList.innerHTML = _clCache.slice(0, 15).map((c, i) => {
        const sha7  = c.sha.slice(0,7);
        const isCur = d?.current_sha && c.sha.startsWith(d.current_sha);
        const msg   = (c.commit?.message || '').split('\n')[0];
        const rel   = fmtRelative(c.commit?.author?.date || '');
        return `<div class="ota-ver-item${isCur ? ' current' : i === 0 ? ' selected' : ''}" data-sha="${c.sha}"
          onclick="selectOtaVersion('${c.sha}',this)">
          <span class="ota-ver-sha">${sha7}</span>
          <span class="ota-ver-msg">${esc(msg)}</span>
          <span class="ota-ver-rel">${rel}</span>
          ${isCur ? `<span class="ota-cur-tag">installed</span>` : ''}
        </div>`;
      }).join('');
      verWrap.style.display = '';
    } else {
      verWrap.style.display = 'none';
    }
  }

  // Show pending commits summary
  const preview = document.getElementById('ota-commits-preview');
  if (preview) {
    const pending = [];
    if (_clCache && d?.update_available && d.current_sha) {
      for (const c of _clCache) {
        if (c.sha.startsWith(d.current_sha)) break;
        pending.push(c);
      }
    }
    preview.innerHTML = pending.length ? `<div class="ota-commits">
      <div class="ota-commits-label">${pending.length} commit${pending.length > 1 ? 's' : ''} pending</div>
      ${pending.slice(0,4).map(c => `<div class="ota-commit-item">
        <span class="ota-commit-sha">${c.sha.slice(0,7)}</span>
        <span class="ota-commit-msg">${esc((c.commit?.message||'').split('\n')[0])}</span>
      </div>`).join('')}
      ${pending.length > 4 ? `<div class="ota-commits-more">+${pending.length-4} more</div>` : ''}
    </div>` : '';
  }

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
    let sec = 20; const cd = document.getElementById('ota-countdown');
    const t = setInterval(() => {
      cd.textContent = `Reconnecting in ${sec}s…`;
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
    if (_otaData?.update_available) {
      badge.className = 'cl-badge update-avail';
      badge.innerHTML = `<svg width="7" height="7" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>${_otaData.latest_sha?.slice(0,7)} available`;
    } else if (_otaData?.github_reachable) {
      badge.className = 'cl-badge up-to-date';
      badge.innerHTML = `<svg width="7" height="7" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>Up to date`;
    } else {
      badge.className = 'cl-badge unknown';
      badge.innerHTML = `<svg width="7" height="7" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>Unknown`;
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
