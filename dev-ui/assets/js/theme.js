const ACCENTS = [
  {id:'purple', c:'#7c3aed', c2:'#4f46e5', glow:'rgba(124,58,237,0.35)', light:'#a78bfa', label:'Purple'},
  {id:'indigo', c:'#4338ca', c2:'#3730a3', glow:'rgba(67,56,202,0.35)',  light:'#818cf8', label:'Indigo'},
  {id:'blue',   c:'#2563eb', c2:'#1d4ed8', glow:'rgba(37,99,235,0.35)',  light:'#60a5fa', label:'Blue'  },
  {id:'sky',    c:'#0284c7', c2:'#0369a1', glow:'rgba(2,132,199,0.35)',  light:'#38bdf8', label:'Sky'   },
  {id:'cyan',   c:'#0891b2', c2:'#0e7490', glow:'rgba(8,145,178,0.35)',  light:'#22d3ee', label:'Cyan'  },
  {id:'teal',   c:'#0d9488', c2:'#0f766e', glow:'rgba(13,148,136,0.35)', light:'#2dd4bf', label:'Teal'  },
  {id:'emerald',c:'#059669', c2:'#047857', glow:'rgba(5,150,105,0.35)',  light:'#34d399', label:'Emerald'},
  {id:'lime',   c:'#65a30d', c2:'#4d7c0f', glow:'rgba(101,163,13,0.35)', light:'#a3e635', label:'Lime'  },
  {id:'amber',  c:'#d97706', c2:'#b45309', glow:'rgba(217,119,6,0.35)',  light:'#fbbf24', label:'Amber' },
  {id:'orange', c:'#ea580c', c2:'#c2410c', glow:'rgba(234,88,12,0.35)',  light:'#fb923c', label:'Orange'},
  {id:'red',    c:'#dc2626', c2:'#b91c1c', glow:'rgba(220,38,38,0.35)',  light:'#f87171', label:'Red'   },
  {id:'rose',   c:'#e11d48', c2:'#be123c', glow:'rgba(225,29,72,0.35)',  light:'#fb7185', label:'Rose'  },
  {id:'pink',   c:'#db2777', c2:'#be185d', glow:'rgba(219,39,119,0.35)', light:'#f472b6', label:'Pink'  },
  {id:'fuchsia',c:'#c026d3', c2:'#a21caf', glow:'rgba(192,38,211,0.35)', light:'#e879f9', label:'Fuchsia'},
  {id:'violet', c:'#7c3aed', c2:'#6d28d9', glow:'rgba(124,58,237,0.35)', light:'#a78bfa', label:'Violet'},
  {id:'slate',  c:'#475569', c2:'#334155', glow:'rgba(71,85,105,0.35)',  light:'#94a3b8', label:'Slate' },
];

// File-type keys shared by the text-color and icon-color customisers
const FILE_TYPES = [
  {t:'folder',  label:'Folder files'},
  {t:'image',   label:'Image files'},
  {t:'doc',     label:'Document files'},
  {t:'video',   label:'Video files'},
  {t:'audio',   label:'Audio files'},
  {t:'archive', label:'Archive files'},
  {t:'code',    label:'Code files'},
];

// Every individual CSS color that can be customised
const COLOR_VARS = [
  {key:'--bg',          label:'Background',      group:'Backgrounds'},
  {key:'--bg2',         label:'Surface',          group:'Backgrounds'},
  {key:'--bg3',         label:'Deep surface',     group:'Backgrounds'},
  {key:'--accent',      label:'Accent primary',   group:'Accent'},
  {key:'--accent2',     label:'Accent gradient',  group:'Accent'},
  {key:'--accent-light',label:'Accent light',     group:'Accent'},
  {key:'--text',        label:'Primary text',     group:'Text'},
  {key:'--text-2',      label:'Secondary text',   group:'Text'},
  {key:'--text-3',      label:'Muted text',       group:'Text'},
  ...FILE_TYPES.map(f => ({key:`--ft-${f.t}`, label:f.label, group:'Text color · file types'})),
  ...FILE_TYPES.map(f => ({key:`--ic-${f.t}`, label:f.label, group:'Icon color · file types'})),
  {key:'--logo-text',   label:'LiteLayer logo text',  group:'Logo'},
  {key:'--logo-img',    label:'LiteLayer logo image', group:'Logo'},
  {key:'--green',       label:'Success',          group:'Status'},
  {key:'--yellow',      label:'Warning',          group:'Status'},
  {key:'--red',         label:'Error',            group:'Status'},
];

// Icon colors per file type (shared default for both themes)
const _IC = {
  '--ic-folder':'#7c3aed','--ic-image':'#f97316','--ic-doc':'#60a5fa',
  '--ic-video':'#3b82f6','--ic-audio':'#ec4899','--ic-archive':'#f59e0b','--ic-code':'#10b981',
};
// Text colors per file type default to the icon colors (file names tinted by type)
const _FT = Object.fromEntries(Object.entries(_IC).map(([k, v]) => [k.replace('--ic-', '--ft-'), v]));

const _COLOR_DEFAULTS = {
  dark: {
    '--bg':'#0a0a0b','--bg2':'#121214','--bg3':'#1a1a1d',
    '--accent':'#7c3aed','--accent2':'#4f46e5','--accent-light':'#a78bfa',
    '--text':'#f2f2f4','--text-2':'#a0a0a8','--text-3':'#6b6b73',
    '--logo-text':'#a78bfa','--logo-img':'#7c3aed',
    '--green':'#10b981','--yellow':'#f59e0b','--red':'#ef4444',
    ..._IC, ..._FT,
  },
  light: {
    '--bg':'#f5f4fe','--bg2':'#ece9ff','--bg3':'#e4e0fc',
    '--accent':'#7c3aed','--accent2':'#4f46e5','--accent-light':'#a78bfa',
    '--text':'#1c1635','--text-2':'#5a4fa0','--text-3':'#9888c8',
    '--logo-text':'#7c3aed','--logo-img':'#7c3aed',
    '--green':'#10b981','--yellow':'#f59e0b','--red':'#ef4444',
    ..._IC, ..._FT,
  },
};

let _currentAccent = 'purple';
let _currentTheme  = 'dark';

function applyTheme(t) {
  _currentTheme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('ll-theme', t);
  document.getElementById('theme-card-dark')?.classList.toggle('active', t === 'dark');
  document.getElementById('theme-card-light')?.classList.toggle('active', t === 'light');
}

// User clicked the other theme card. Custom colors are inline :root overrides
// tuned for the old theme — carried into the new one they look garbled, so wipe
// them on switch (keeping the accent, which is theme-independent).
function switchTheme(t) {
  if (t !== _currentTheme) {
    localStorage.removeItem('ll-custom-colors');
    Object.keys(_COLOR_DEFAULTS.dark).forEach(k => document.documentElement.style.removeProperty(k));
  }
  applyTheme(t);
  const ac = localStorage.getItem('ll-accent') || 'purple';
  if (ac === 'custom') applyAccentColor(localStorage.getItem('ll-accent-hex') || '#7c3aed');
  else applyAccent(ac);
  buildColorPickers();  // no-op if the settings panel isn't open
}

function applyAccent(id) {
  const a = ACCENTS.find(x => x.id === id) || ACCENTS[0];
  _currentAccent = id;
  const r = document.documentElement;
  r.style.setProperty('--accent', a.c);
  r.style.setProperty('--accent2', a.c2);
  r.style.setProperty('--accent-glow', a.glow);
  r.style.setProperty('--accent-light', a.light);
  localStorage.setItem('ll-accent', id);
  document.querySelectorAll('.accent-swatch').forEach(el => el.classList.toggle('active', el.dataset.accent === id));
  // sync color picker if open
  ['--accent','--accent2','--accent-light'].forEach(k => {
    const inp = document.querySelector(`[data-color-key="${k}"]`);
    if (inp) inp.value = document.documentElement.style.getPropertyValue(k) || inp.value;
  });
}

// Lighten (pct>0) / darken (pct<0) a #rrggbb hex.
function _shade(hex, pct) {
  const n = parseInt((hex || '#000000').slice(1), 16);
  const ch = s => {
    const c = (n >> s) & 255;
    const v = pct < 0 ? c * (1 + pct / 100) : c + (255 - c) * (pct / 100);
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return '#' + [ch(16), ch(8), ch(0)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Pick any accent color; derive the gradient/glow/light from it.
function applyAccentColor(hex) {
  const r = document.documentElement;
  r.style.setProperty('--accent', hex);
  r.style.setProperty('--accent2', _shade(hex, -18));
  r.style.setProperty('--accent-light', _shade(hex, 28));
  const n = parseInt(hex.slice(1), 16);
  r.style.setProperty('--accent-glow', `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},0.35)`);
  _currentAccent = 'custom';
  localStorage.setItem('ll-accent', 'custom');
  localStorage.setItem('ll-accent-hex', hex);
  const hexEl = document.getElementById('accent-hex'); if (hexEl) hexEl.textContent = hex;
  const sw = document.querySelector('.accent-pick-swatch'); if (sw) sw.style.background = hex;
}

function buildAccentGrid() {
  const grid = document.getElementById('accent-grid');
  if (!grid) return;
  const cur = (document.documentElement.style.getPropertyValue('--accent').trim()
            || localStorage.getItem('ll-accent-hex') || '#7c3aed');
  // One clear, prominent picker — click the big swatch to choose any color.
  grid.innerHTML = `<label class="accent-pick">
      <input type="color" id="accent-color-input" value="${cur}" oninput="applyAccentColor(this.value)" title="Pick any accent color">
      <span class="accent-pick-swatch" style="background:${cur}"></span>
      <span class="accent-pick-text">
        <span class="accent-pick-title">Accent color</span>
        <span class="accent-pick-hex" id="accent-hex">${cur}</span>
      </span>
    </label>`;
}

// ── Login animated background (on by default) ──────────────────────────────────

function applyLoginAnim() {
  const on = localStorage.getItem('ll-login-anim') !== '0';
  document.getElementById('view-login')?.classList.toggle('no-anim', !on);
  document.getElementById('login-anim-sw')?.classList.toggle('on', on);
}

function toggleLoginAnim() {
  const on = localStorage.getItem('ll-login-anim') === '0';   // flip
  localStorage.setItem('ll-login-anim', on ? '1' : '0');
  applyLoginAnim();
  toast(on ? 'Login animation on' : 'Login animation off', 'success', 2000);
}

// ── Login gradient customisation ────────────────────────────────────────────────
// {c1,c2,c3,speed} in ll-login-grad. Unset keys fall back to the accent colors
// via the CSS --lg* custom-property defaults, so "no config" always tracks accent.

function _lgConf() { try { return JSON.parse(localStorage.getItem('ll-login-grad') || '{}'); } catch { return {}; } }

function applyLoginGradient() {
  const bg = document.querySelector('.login-bg'); if (!bg) return;
  const c = _lgConf();
  ['c1', 'c2', 'c3'].forEach((k, i) => {
    if (c[k]) bg.style.setProperty(`--lg${i + 1}`, c[k]);
    else bg.style.removeProperty(`--lg${i + 1}`);
  });
  bg.style.setProperty('--lg-speed', c.speed || 1);
}

function setLoginGrad(key, val) {
  const c = _lgConf(); c[key] = val;
  localStorage.setItem('ll-login-grad', JSON.stringify(c));
  applyLoginGradient();
}

function resetLoginGrad() {
  localStorage.removeItem('ll-login-grad');
  applyLoginGradient(); _reflectLoginGradUI();
  toast('Login gradient follows your accent again', 'success', 2000);
}

// Fill the Appearance controls with the effective values (custom or accent-derived).
function _reflectLoginGradUI() {
  const c = _lgConf(), cs = getComputedStyle(document.documentElement);
  const def = k => (cs.getPropertyValue(k) || '').trim() || '#7c3aed';
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('lg-c1', c.c1 || def('--accent'));
  set('lg-c2', c.c2 || def('--accent2'));
  set('lg-c3', c.c3 || def('--accent-light'));
  set('lg-speed', c.speed || 1);
}

// ── Individual color customisation ────────────────────────────────────────────

function applyCustomColor(key, value) {
  document.documentElement.style.setProperty(key, value);
  // if accent primary changed, update glow too
  if (key === '--accent') {
    const glow = value + '59';
    document.documentElement.style.setProperty('--accent-glow', glow);
    _currentAccent = 'custom';
    document.querySelectorAll('.accent-swatch').forEach(el => el.classList.remove('active'));
    localStorage.setItem('ll-accent', 'custom');
  }
  const saved = JSON.parse(localStorage.getItem('ll-custom-colors') || '{}');
  saved[key] = value;
  localStorage.setItem('ll-custom-colors', JSON.stringify(saved));
}

function resetCustomColors() {
  localStorage.removeItem('ll-custom-colors');
  const defs = _COLOR_DEFAULTS[_currentTheme] || _COLOR_DEFAULTS.dark;
  Object.entries(defs).forEach(([k, v]) => {
    document.documentElement.style.removeProperty(k);
    const inp = document.querySelector(`[data-color-key="${k}"]`);
    if (inp) inp.value = v;
  });
  // restore saved accent preset
  const ac = localStorage.getItem('ll-accent') || 'purple';
  if (ac !== 'custom') applyAccent(ac); else applyAccent('purple');
}

function _restoreCustomColors() {
  try {
    const saved = JSON.parse(localStorage.getItem('ll-custom-colors') || '{}');
    Object.entries(saved).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  } catch {}
}

// Restore persisted preferences immediately (runs before full DOM ready)
(function () {
  const t  = localStorage.getItem('ll-theme')  || 'dark';
  const ac = localStorage.getItem('ll-accent') || 'purple';
  applyTheme(t);
  if (ac === 'custom') applyAccentColor(localStorage.getItem('ll-accent-hex') || '#7c3aed');
  else applyAccent(ac);
  _restoreCustomColors();
  applyLoginAnim();
  applyLoginGradient();
})();
