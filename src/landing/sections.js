// Mises en scène des sections : le problème (horloge au scroll), le bento des
// fonctions (micro-démos), le sélecteur de foyers, et les visuels Éclair.
import { normalize } from "./finder.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Ajoute .is-in une fois l'élément visible (animations d'entrée ponctuelles)
function onceVisible(els, cb, threshold = 0.35) {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("is-in"); cb?.(e.target); io.unobserve(e.target); }
  }), { threshold });
  els.forEach((el) => io.observe(el));
}
// Boucle active seulement quand l'élément est à l'écran et l'onglet visible
function whileVisible(el, start, stop) {
  let inView = false, on = false;
  const sync = () => {
    const want = inView && !document.hidden;
    if (want && !on) { on = true; start(); } else if (!want && on) { on = false; stop(); }
  };
  new IntersectionObserver((es) => { inView = es[0].isIntersecting; sync(); }, { threshold: 0.15 }).observe(el);
  document.addEventListener("visibilitychange", sync);
}

/* ─── Le problème : l'horloge avance, les phrases s'écrivent ───────────── */
function initProblem(reduced) {
  const scroller = $(".pb-scroll");
  if (!scroller) return;
  const clock = $(".pb-clock"), digital = $(".pc-digital");
  const beats = $$(".pb-beat");
  const bars = $$(".pb-bars span"), count = $(".pb-n");
  if (reduced) { beats.forEach((b) => b.classList.add("is-on")); return; }
  const lines = beats.map((b) => $$(".pb-line", b));
  let ticking = false, lastN = -1;
  const fmt = (m) => `${Math.floor(m / 60) % 24} h ${String(Math.floor(m % 60)).padStart(2, "0")}`;

  function update() {
    ticking = false;
    const r = scroller.getBoundingClientRect();
    const p = clamp01(-r.top / Math.max(1, r.height - innerHeight));
    const edges = [0, 0.34, 0.6, 1];
    const beat = p < edges[1] ? 0 : p < edges[2] ? 1 : 2;
    beats.forEach((b, i) => b.classList.toggle("is-on", i === beat));
    const local = clamp01((p - edges[beat]) / (edges[beat + 1] - edges[beat]));
    (lines[beat] || []).forEach((l, i) => l.style.setProperty("--r", clamp01(local * 3.2 - i * 0.95).toFixed(3)));
    // 18 h → 18 h 30 pendant la scène, puis le temps file pendant qu'on cherche
    const minutes = p < edges[1] ? 1080 + clamp01(p / edges[1] / 0.35) * 30
      : p < edges[2] ? 1110 + ((p - edges[1]) / (edges[2] - edges[1])) * 75
      : 1185 + ((p - edges[2]) / (1 - edges[2])) * 60;
    clock.style.setProperty("--min", minutes.toFixed(2));
    digital.textContent = fmt(minutes);
    // 2,5 jours = 60 heures, allumées une par une
    const n = beat === 2 ? Math.round(clamp01(local * 1.4) * 60) : 0;
    if (n !== lastN) {
      lastN = n;
      bars.forEach((s, i) => { s.classList.toggle("on", i < n - 1); s.classList.toggle("now", i === n - 1); });
      count.textContent = String(n);
    }
  }
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll, { passive: true });
  update();
}

/* ─── Fonctions : micro-démos ──────────────────────────────────────────── */
function initTolerant(reduced) {
  const cell = $(".cell-tolerant");
  if (!cell || reduced) return;
  const text = $(".tol-text", cell), code = $(".tol-code", cell), hit = $(".tol-hit", cell);
  const variants = ["clé à molette", "CLE A MOLLETTE", "molette", "clé a molete", "Clés à molette"];
  let i = 0, timer = 0;
  const paint = (s) => { text.replaceChildren(...[...s].map((c) => Object.assign(document.createElement("span"), { className: "ch", textContent: c }))); };
  paint(variants[0]);
  function next() {
    const chars = $$(".ch", text);
    chars.forEach((c, k) => setTimeout(() => c.classList.add("out"), k * 18));
    setTimeout(() => {
      i = (i + 1) % variants.length;
      paint(variants[i]);
      $$(".ch", text).forEach((c, k) => { c.classList.add("out"); setTimeout(() => c.classList.remove("out"), 20 + k * 22); });
      code.textContent = normalize(variants[i]);
      hit.classList.remove("flash"); void hit.offsetWidth; hit.classList.add("flash");
    }, chars.length * 18 + 200);
  }
  whileVisible(cell, () => { timer = setInterval(next, 2400); }, () => clearInterval(timer));
}

function initScope() {
  const range = $(".scope-range"), outEl = $(".scope-out"), dots = $(".scope-dots");
  if (!range) return;
  const N = 150; // un point = deux objets
  dots.replaceChildren(...Array.from({ length: N }, () => document.createElement("i")));
  const ds = $$("i", dots);
  const update = () => {
    const v = +range.value;
    outEl.textContent = v === 300 ? "300 et plus" : String(v);
    const lit = Math.ceil(v / 2);
    ds.forEach((d, i) => d.classList.toggle("on", i < lit));
  };
  range.addEventListener("input", update);
  update();
}

/* ─── Pour qui : quatre foyers, quatre ambiances ───────────────────────── */
const PERSONA_ROOMS = {
  familles: ["chambre", "garage", "sejour"],
  aidants: ["sdb", "entree", "cuisine"],
  bricoleurs: ["garage", "cuisine"],
  demenagement: ["cuisine", "sejour", "chambre"]
};
function initPersonas() {
  const section = $(".personas");
  if (!section) return;
  const tabs = $$('[role="tab"]', section);
  const select = (tab, focus) => {
    const id = tab.dataset.persona;
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $("#" + t.getAttribute("aria-controls")).hidden = !on;
    });
    section.dataset.persona = id;
    $$(".iso-room", section).forEach((g) => g.classList.toggle("is-lit", PERSONA_ROOMS[id].includes(g.dataset.room)));
    if (focus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      const k = e.key;
      let j = null;
      if (k === "ArrowRight" || k === "ArrowDown") j = (i + 1) % tabs.length;
      if (k === "ArrowLeft" || k === "ArrowUp") j = (i - 1 + tabs.length) % tabs.length;
      if (k === "Home") j = 0;
      if (k === "End") j = tabs.length - 1;
      if (j !== null) { e.preventDefault(); select(tabs[j], true); }
    });
  });
  select(tabs[0]);
}

/* ─── Éclair : scan en boucle, plan qui change d'étage, étincelles ─────── */
function initEclair(reduced) {
  const scan = $(".ec-scan");
  if (scan && !reduced) {
    const countEl = $(".scan-count b", scan);
    let raf = 0, t0 = 0;
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      if (!t0) t0 = now;
      const t = ((now - t0) / 1000) % 7;
      const p = clamp01(t / 4.2);
      scan.style.setProperty("--p1", p.toFixed(3));
      if (countEl) countEl.textContent = String(Math.min(14, Math.round(clamp01((p * 8.5 - 0.8) / 7) * 14)));
    };
    whileVisible(scan, () => { t0 = 0; raf = requestAnimationFrame(loop); }, () => cancelAnimationFrame(raf));
  }
  const plan = $(".ec-plan");
  if (plan) {
    const q = $(".ep-q", plan), a = $(".ep-a", plan);
    const floors = [
      { q: "passeport", a: "Rez-de-chaussée / Bureau / Commode / Tiroir du haut" },
      { q: "guirlande", a: "Étage / Grenier / Étagère / Bac 3" }
    ];
    let f = 0, timer = 0;
    const set = (i) => { plan.dataset.floor = String(i); q.textContent = `« ${floors[i].q} »`; a.textContent = floors[i].a; };
    set(0);
    if (!reduced) whileVisible(plan, () => { timer = setInterval(() => { f = 1 - f; set(f); }, 3200); }, () => clearInterval(timer));
  }
  onceVisible($$(".ec-alerts"));

  // Étincelles : quelques points volt qui montent lentement dans la section
  const canvas = $(".eclair-canvas");
  if (!canvas || reduced) return;
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, parts = [], raf = 0;
  const size = () => {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    W = r.width; H = r.height; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(160, W * H / 14000));
    parts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, v: 0.15 + Math.random() * 0.45, s: 0.8 + Math.random() * 1.6, a: 0.15 + Math.random() * 0.45, ph: Math.random() * 6.28 }));
  };
  const draw = (now) => {
    raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.y -= p.v; if (p.y < -4) { p.y = H + 4; p.x = Math.random() * W; }
      const tw = 0.6 + 0.4 * Math.sin(now / 700 + p.ph);
      ctx.globalAlpha = p.a * tw;
      ctx.fillStyle = "#d9ff3d";
      ctx.fillRect(p.x + Math.sin(now / 1400 + p.ph) * 6, p.y, p.s, p.s);
    }
    ctx.globalAlpha = 1;
  };
  size();
  addEventListener("resize", size, { passive: true });
  whileVisible(canvas.parentElement, () => { raf = requestAnimationFrame(draw); }, () => cancelAnimationFrame(raf));
}

export function initSections({ reduced }) {
  initProblem(reduced);
  onceVisible($$(".cell"));
  initTolerant(reduced);
  initScope();
  initPersonas();
  initEclair(reduced);
}
