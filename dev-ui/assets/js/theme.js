const ACCENTS = [
  {id:'purple', c:'#7c3aed', c2:'#4f46e5', glow:'rgba(124,58,237,0.35)', light:'#a78bfa', label:'Purple'},
  {id:'indigo', c:'#4338ca', c2:'#3730a3', glow:'rgba(67,56,202,0.35)',  light:'#818cf8', label:'Indigo'},
  {id:'blue',   c:'#2563eb', c2:'#1d4ed8', glow:'rgba(37,99,235,0.35)',  light:'#60a5fa', label:'Blue'  },
  {id:'teal',   c:'#0d9488', c2:'#0f766e', glow:'rgba(13,148,136,0.35)', light:'#2dd4bf', label:'Teal'  },
  {id:'rose',   c:'#e11d48', c2:'#be123c', glow:'rgba(225,29,72,0.35)',  light:'#fb7185', label:'Rose'  },
  {id:'amber',  c:'#d97706', c2:'#b45309', glow:'rgba(217,119,6,0.35)',  light:'#fbbf24', label:'Amber' },
];

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
}

function buildAccentGrid() {
  const grid = document.getElementById('accent-grid');
  if (!grid) return;
  grid.innerHTML = ACCENTS.map(a => `
    <button class="accent-swatch${a.id === _currentAccent ? ' active' : ''}" data-accent="${a.id}"
      style="background:${a.c}" title="${a.label}" onclick="applyAccent('${a.id}')"></button>
  `).join('');
}

// Restore persisted preferences immediately (runs before full DOM ready — safe)
(function () {
  const t  = localStorage.getItem('ll-theme')  || 'dark';
  const ac = localStorage.getItem('ll-accent') || 'purple';
  applyTheme(t);
  applyAccent(ac);
})();
