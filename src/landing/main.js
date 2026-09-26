// Landing Fulmo — orchestration légère. Le texte est déjà là (HTML) ;
// ce fichier ajoute le mouvement, puis charge la scène 3D à part.
import { initStory } from "./story.js";
import { initBolt } from "./bolt.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const mqReduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const mqCoarse = window.matchMedia("(pointer: coarse)");
const reduced = mqReduced.matches;
const coarse = mqCoarse.matches;
const root = document.documentElement;
root.classList.add("js");
if (reduced) root.classList.add("reduced");

/* ─── Navigation : état « défilé » et menu mobile ─────────────────────── */
function initNav() {
  const nav = $(".nav");
  const btn = $(".nav-toggle");
  const panel = $("#nav-panel");
  if (!nav || !btn || !panel) return;
  const close = () => { btn.setAttribute("aria-expanded", "false"); nav.classList.remove("is-open"); };
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
    if (open) $("a", panel)?.focus({ preventScroll: true });
  });
  panel.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("is-open")) { close(); btn.focus(); }
  });
  window.matchMedia("(min-width: 960px)").addEventListener("change", close);
}

/* ─── Fausse barre de recherche du hero ───────────────────────────────── */
const FINDS = {
  passeport: { q: "Où est le passeport ?", name: "Passeport", path: ["Bureau", "Commode", "Tiroir du haut"] },
  guirlande: { q: "guirlande de noel", name: "Guirlande lumineuse", path: ["Bureau", "Bibliothèque", "Bac du bas"] },
  chargeur: { q: "chargeur ordi", name: "Chargeur d'ordinateur", path: ["Bureau", "Bibliothèque", "Boîte à câbles"] }
};

function initSearch() {
  const box = $(".hero-search");
  const q = $(".hs-query", box);
  const status = $(".hs-status", box);
  const pin = $(".hero-pin");
  const pinName = $(".pin-name", pin);
  const pinPath = $(".pin-path", pin);
  const pinCard = $(".pin-card", pin);
  let typing = 0;

  function setResult(key) {
    const f = FINDS[key];
    status.innerHTML = "";
    const lab = document.createElement("span");
    lab.className = "hs-found"; lab.textContent = f.name;
    const path = document.createElement("span");
    path.className = "hs-path"; path.textContent = f.path.join(" / ");
    status.append(lab, path);
    box.dataset.state = "found";
  }
  function type(text, done) {
    cancelAnimationFrame(typing);
    const t0 = performance.now();
    const step = (now) => {
      const n = Math.min(text.length, Math.floor((now - t0) / 62));
      q.textContent = text.slice(0, n);
      if (n < text.length) typing = requestAnimationFrame(step); else done && done();
    };
    typing = requestAnimationFrame(step);
  }
  function setPinContent(key) {
    const f = FINDS[key];
    pinName.textContent = f.name;
    pinPath.textContent = f.path.join(" / ");
  }

  return {
    phase({ phase, key }) {
      if (phase === "type") {
        box.dataset.state = "typing"; status.textContent = "";
        setPinContent(key);
        type(FINDS[key].q);
      } else if (phase === "scan") {
        cancelAnimationFrame(typing);
        q.textContent = FINDS[key].q;
        box.dataset.state = "scan";
        status.textContent = "Fulmo parcourt la pièce…";
      } else if (phase === "found") {
        cancelAnimationFrame(typing);
        q.textContent = FINDS[key].q;
        setResult(key);
      } else if (phase === "reset") {
        box.dataset.state = "reset";
      }
    },
    pin({ key, visible, x, y }) {
      if (pin.dataset.key !== key) { pin.dataset.key = key; setPinContent(key); }
      pin.classList.toggle("is-on", visible);
      if (!visible) return;
      const px = (x / 100) * stageW, py = (y / 100) * stageH;
      pin.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      // la carte reste dans l'écran : on la décale si l'épingle est près d'un bord
      const cw = pinCard.offsetWidth || 240, base = -24;
      const shift = Math.min(Math.max(base, 12 - px), stageW - 12 - cw - px);
      pinCard.style.left = `${shift}px`;
    },
    still(key = "passeport") {
      q.textContent = FINDS[key].q;
      setPinContent(key);
      setResult(key);
    }
  };
}

/* ─── Scène 3D du hero ─────────────────────────────────────────────────── */
let stageW = 0, stageH = 0;
function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

async function initHero(search) {
  const hero = $(".hero");
  const stage = $(".hero-stage");
  const canvas = $(".hero-canvas");
  const measure = () => { const r = stage.getBoundingClientRect(); stageW = r.width; stageH = r.height; };
  measure();

  if (!hasWebGL()) { root.classList.add("no-webgl"); search.still(); return; }

  let mod;
  try { mod = await import("./hero3d.js"); } catch (e) { root.classList.add("no-webgl"); search.still(); return; }
  const lowPower = (navigator.hardwareConcurrency || 8) <= 4;
  let hero3d;
  try {
    hero3d = mod.createHero({
      canvas, reduced, coarse, lowPower,
      onPin: (p) => search.pin(p),
      onPhase: (p) => search.phase(p)
    });
  } catch (e) {
    console.warn("[fulmo] 3D indisponible :", e);
    root.classList.add("no-webgl"); search.still(); return;
  }
  if (new URLSearchParams(location.search).has("capture")) window.__fulmoHero = hero3d;

  // Le canvas apparaît en fondu une fois la première image prête
  const reveal = () => requestAnimationFrame(() => root.classList.add("scene-ready"));

  if (reduced) {
    hero3d.still("passeport");
    search.still("passeport");
    reveal();
    window.addEventListener("resize", () => { measure(); hero3d.resize(); hero3d.still("passeport"); });
    return;
  }

  // Pause hors écran et onglet caché
  let inView = true;
  const sync = () => (inView && !document.hidden ? hero3d.start() : hero3d.stop());
  new IntersectionObserver((es) => { inView = es[0].isIntersecting; sync(); }, { threshold: 0 }).observe(hero);
  document.addEventListener("visibilitychange", sync);

  // Pointeur (desktop) : caméra + lumière volt + lueur de curseur
  if (!coarse) {
    const glow = $(".cursor-glow");
    hero.addEventListener("pointermove", (e) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      hero3d.setPointer(nx, ny);
      if (glow) glow.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
    }, { passive: true });
    hero.addEventListener("pointerenter", () => glow?.classList.add("is-on"));
    hero.addEventListener("pointerleave", () => { glow?.classList.remove("is-on"); hero3d.setPointer(0, 0); });
  } else if ("DeviceOrientationEvent" in window && typeof DeviceOrientationEvent.requestPermission !== "function") {
    // Gyroscope sans demande de permission bloquante (Android) ; iOS garde l'orbite
    window.addEventListener("deviceorientation", (e) => {
      if (e.gamma == null) return;
      hero3d.setGyro(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, (e.beta - 45) / 40)));
    }, { passive: true });
  }

  // Le scroll dissout la pièce en nuage de points
  const onScroll = () => {
    const r = hero.getBoundingClientRect();
    const span = Math.max(1, r.height - window.innerHeight * 0.6);
    hero3d.setScroll(-r.top / span);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  window.addEventListener("resize", () => { measure(); hero3d.resize(); }, { passive: true });
  sync();
  reveal();
}

/* ─── Plan isométrique : pièces qui s'illuminent ──────────────────────── */
function initPlan() {
  const svg = $(".iso");
  const list = $(".plan-rooms");
  if (!svg || !list) return;
  const detail = $(".plan-detail");
  const setRoom = (id) => {
    $$(".iso-room", svg).forEach((g) => g.classList.toggle("is-lit", g.dataset.room === id));
    $$("button[data-room]", list).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.room === id)));
    const b = $(`button[data-room="${id}"]`, list);
    if (b && detail) {
      detail.querySelector(".pd-room").textContent = b.dataset.label;
      detail.querySelector(".pd-where").textContent = b.dataset.where;
      detail.querySelector(".pd-items").textContent = b.dataset.items;
    }
  };
  $$(".iso-room", svg).forEach((g) => {
    g.addEventListener("pointerenter", () => setRoom(g.dataset.room));
    g.addEventListener("click", () => setRoom(g.dataset.room));
  });
  $$("button[data-room]", list).forEach((b) => {
    b.addEventListener("click", () => setRoom(b.dataset.room));
    b.addEventListener("pointerenter", () => setRoom(b.dataset.room));
    b.addEventListener("focus", () => setRoom(b.dataset.room));
  });
  setRoom("bureau");
}

/* ─── Carte Éclair : inclinaison 3D + reflet ──────────────────────────── */
function initTilt() {
  if (coarse || reduced) return;
  $$("[data-tilt]").forEach((card) => {
    let raf = 0;
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        card.style.setProperty("--rx", `${(0.5 - y) * 9}deg`);
        card.style.setProperty("--ry", `${(x - 0.5) * 11}deg`);
        card.style.setProperty("--mx", `${x * 100}%`);
        card.style.setProperty("--my", `${y * 100}%`);
      });
    });
    card.addEventListener("pointerleave", () => {
      cancelAnimationFrame(raf);
      card.style.setProperty("--rx", "0deg"); card.style.setProperty("--ry", "0deg");
    });
  });
}

/* ─── Bouton principal : reflet qui suit le pointeur ──────────────────── */
function initButtons() {
  if (coarse) return;
  document.addEventListener("pointermove", (e) => {
    const b = e.target.closest?.(".btn-volt");
    if (!b) return;
    const r = b.getBoundingClientRect();
    b.style.setProperty("--bx", `${e.clientX - r.left}px`);
    b.style.setProperty("--by", `${e.clientY - r.top}px`);
  }, { passive: true });
}

/* ─── Mur de requêtes : bouton pause (WCAG 2.2.2) ─────────────────────── */
function initMarquee() {
  const m = $(".marquee"), b = $(".mq-toggle");
  if (!m || !b) return;
  const label = $(".mq-label", b);
  b.addEventListener("click", () => {
    const paused = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(paused));
    m.dataset.paused = String(paused);
    label.textContent = paused ? "Reprendre le défilement" : "Mettre en pause le défilement";
  });
}

/* ─── Démarrage ───────────────────────────────────────────────────────── */
initNav();
const search = initSearch();
initPlan();
initTilt();
initButtons();
initMarquee();
initStory({ reduced });
initBolt({ reduced, coarse });

// La 3D attend que le texte soit peint
const boot = () => initHero(search);
if (document.readyState === "complete") setTimeout(boot, 30);
else window.addEventListener("load", () => setTimeout(boot, 30), { once: true });
