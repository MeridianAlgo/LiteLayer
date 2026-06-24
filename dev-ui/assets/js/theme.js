const ACCENTS = [
  {id:'purple', c:'#7c3aed', c2:'#4f46e5', glow:'rgba(124,58,237,0.35)', light:'#a78bfa', label:'Purple'},
  {id:'indigo', c:'#4338ca', c2:'#3730a3', glow:'rgba(67,56,202,0.35)',  light:'#818cf8', label:'Indigo'},
  {id:'blue',   c:'#2563eb', c2:'#1d4ed8', glow:'rgba(37,99,235,0.35)',  light:'#60a5fa', label:'Blue'  },
  {id:'teal',   c:'#0d9488', c2:'#0f766e', glow:'rgba(13,148,136,0.35)', light:'#2dd4bf', label:'Teal'  },
  {id:'rose',   c:'#e11d48', c2:'#be123c', glow:'rgba(225,29,72,0.35)',  light:'#fb7185', label:'Rose'  },
  {id:'amber',  c:'#d97706', c2:'#b45309', glow:'rgba(217,119,6,0.35)',  light:'#fbbf24', label:'Amber' },
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
  {key:'--green',       label:'Success',          group:'Status'},
  {key:'--yellow',      label:'Warning',          group:'Status'},
  {key:'--red',         label:'Error',            group:'Status'},
];

const _COLOR_DEFAULTS = {
  dark: {
    '--bg':'#0b0a14','--bg2':'#0e0c1a','--bg3':'#13101f',
    '--accent':'#7c3aed','--accent2':'#4f46e5','--accent-light':'#a78bfa',
    '--text':'#f0eeff','--text-2':'#9b8fcf','--text-3':'#5c5380',
    '--green':'#10b981','--yellow':'#f59e0b','--red':'#ef4444',
  },
  light: {
    '--bg':'#f5f4fe','--bg2':'#ece9ff','--bg3':'#e4e0fc',
    '--accent':'#7c3aed','--accent2':'#4f46e5','--accent-light':'#a78bfa',
    '--text':'#1c1635','--text-2':'#5a4fa0','--text-3':'#9888c8',
    '--green':'#10b981','--yellow':'#f59e0b','--red':'#ef4444',
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

function buildAccentGrid() {
  const grid = document.getElementById('accent-grid');
  if (!grid) return;
  grid.innerHTML = ACCENTS.map(a => `
    <button class="accent-swatch${a.id === _currentAccent ? ' active' : ''}" data-accent="${a.id}"
      style="background:${a.c}" title="${a.label}" onclick="applyAccent('${a.id}')"></button>
  `).join('');
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
  if (ac !== 'custom') applyAccent(ac); else applyAccent('purple');
  _restoreCustomColors();
})();
