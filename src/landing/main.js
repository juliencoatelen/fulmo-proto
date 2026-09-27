// Landing Fulmo — orchestration légère. Le texte est déjà là (HTML) ;
// ce fichier ajoute le thème, la recherche du hero, puis charge la 3D à part.
import { initStory } from "./story.js";
import { initBolt } from "./bolt.js";
import { initSections } from "./sections.js";
import { search } from "./finder.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = window.matchMedia("(pointer: coarse)").matches;
const root = document.documentElement;
root.classList.add("js");
if (reduced) root.classList.add("reduced");
let hero3d = null;

/* ─── Thème : nuit par défaut, jour au choix (mémorisé) ────────────────── */
function initTheme() {
  const meta = $('meta[name="theme-color"]');
  const buttons = $$(".theme-toggle");
  const apply = (theme, animate) => {
    if (animate && !reduced) {
      root.classList.add("theme-fade");
      setTimeout(() => root.classList.remove("theme-fade"), 650);
    }
    root.setAttribute("data-theme", theme);
    const light = theme === "light";
    if (meta) meta.content = light ? "#faf9f6" : "#07070a";
    buttons.forEach((b) => {
      b.setAttribute("aria-pressed", String(light));
      b.setAttribute("aria-label", light ? "Passer en thème sombre" : "Passer en thème clair");
      const lab = $(".tt-label", b);
      if (lab) lab.textContent = light ? "Thème sombre" : "Thème clair";
    });
    hero3d?.setDay(light);
  };
  apply(root.getAttribute("data-theme") === "light" ? "light" : "dark", false);
  buttons.forEach((b) => b.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    try { localStorage.setItem("fulmo.theme", next); } catch { /* navigation privée */ }
    apply(next, true);
  }));
}

/* ─── Navigation : menu mobile ─────────────────────────────────────────── */
function initNav() {
  const nav = $(".nav"), btn = $(".nav-toggle"), panel = $("#nav-panel");
  if (!nav || !btn || !panel) return;
  const close = () => { btn.setAttribute("aria-expanded", "false"); nav.classList.remove("is-open"); };
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
    if (open) $("a", panel)?.focus({ preventScroll: true });
  });
  panel.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && nav.classList.contains("is-open")) { close(); btn.focus(); } });
  window.matchMedia("(min-width: 1000px)").addEventListener("change", close);
}

/* ─── Recherche du hero : le visiteur teste le produit ─────────────────── */
const AUTO = ["décorations de Noël", "passeport", "chargeur ordi", "perseuse"].map((q) => ({ q, item: search(q).results[0] }));
const stage = { w: 0, h: 0 };

function initHeroSearch() {
  const form = $(".hero-search"), input = $("#hero-q"), out = $("#hero-result");
  const pin = $(".hero-pin"), pinCard = $(".pin-card", pin);
  const pinName = $(".pin-name", pin), pinPath = $(".pin-path", pin);
  let typing = 0, debounce = 0, idle = 0;
  const user = { active: false, item: null, name: "" };

  const pathText = (item) => item.place.join(" / ");
  function setPin(item) { pinName.textContent = item.name; pinPath.textContent = pathText(item); }
  function render(state, item, extra) {
    out.dataset.state = state;
    out.replaceChildren();
    if (state === "idle") return;
    const status = document.createElement("span");
    status.className = "hr-status";
    status.textContent = state === "found" ? "Trouvé" : state === "scan" ? "Recherche…" : "Introuvable";
    out.append(status);
    if (item) {
      const n = document.createElement("span"); n.className = "hr-name"; n.textContent = item.name;
      const p = document.createElement("span"); p.className = "hr-path"; p.textContent = pathText(item);
      out.append(n, p);
    }
    if (extra) out.append(extra);
  }
  function chip(label, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }
  // Mot-clé transverse : les autres objets qui remontent avec la même requête
  function moreLine(results, keyword) {
    const others = results.slice(1, 4);
    if (!keyword || !others.length) return null;
    const line = document.createElement("span");
    line.className = "hr-more";
    const n = results.length - 1;
    line.append(`+ ${n} autre${n > 1 ? "s" : ""} objet${n > 1 ? "s" : ""} « ${keyword} » : `);
    others.forEach((r) => line.append(chip(r.name, () => show(r, results, keyword)), " "));
    return line;
  }
  function emptyLine() {
    const line = document.createElement("span");
    line.className = "hr-more";
    line.append("Rien sous ce nom dans cette maison de démonstration. Essayez : ");
    ["perseuse", "noel", "doudou"].forEach((q) => line.append(chip(q, () => { input.value = q; user.name = ""; run(); }), " "));
    return line;
  }
  function show(item, results, keyword) {
    user.item = item; setPin(item);
    const extra = moreLine(results, keyword);
    if (hero3d && hero3d.running) { render("scan", item, extra); hero3d.find(item.target); }
    else { hero3d?.find(item.target); render("found", item, extra); }
  }
  function run() {
    clearTimeout(debounce);
    cancelAnimationFrame(typing);
    user.active = true;
    armIdle();
    const q = input.value.trim();
    if (!q) { render("idle"); user.name = ""; return; }
    const { results, keyword } = search(q);
    if (!results.length) { user.name = ""; render("empty", null, emptyLine()); return; }
    if (results[0].name === user.name) return;
    user.name = results[0].name;
    show(results[0], results, keyword);
  }
  // Sans saisie pendant un moment, la démo automatique reprend
  function armIdle() {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (document.activeElement === input) return armIdle();
      user.active = false; user.name = "";
      hero3d?.resume();
    }, 16000);
  }
  function typeInto(text) {
    cancelAnimationFrame(typing);
    const t0 = performance.now();
    const step = (now) => {
      if (user.active || document.activeElement === input) return;
      const n = Math.min(text.length, Math.floor((now - t0) / 60));
      input.value = text.slice(0, n);
      if (n < text.length) typing = requestAnimationFrame(step);
    };
    typing = requestAnimationFrame(step);
  }

  input.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(run, 260); });
  input.addEventListener("focus", () => { cancelAnimationFrame(typing); if (!user.active) input.select(); armIdle(); });
  form.addEventListener("submit", (e) => { e.preventDefault(); user.name = ""; run(); });
  $$(".hero-help [data-q]").forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.q; user.name = ""; run(); }));

  return {
    phase({ phase, index, user: isUser }) {
      if (isUser) {
        if (phase === "found" && user.item) render("found", user.item, out.querySelector(".hr-more"));
        return;
      }
      if (user.active) return;
      const a = AUTO[index % AUTO.length];
      if (phase === "type") { setPin(a.item); render("idle"); typeInto(a.q); }
      else if (phase === "scan") { if (document.activeElement !== input) input.value = a.q; setPin(a.item); render("scan", a.item); }
      else if (phase === "found") { setPin(a.item); render("found", a.item); }
    },
    pin({ visible, x, y }) {
      pin.classList.toggle("is-on", visible);
      if (!visible) return;
      const px = (x / 100) * stage.w, py = (y / 100) * stage.h;
      pin.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      // près du haut (sous la barre de navigation), la carte passe sous l'épingle
      pin.classList.toggle("below", py < 190);
      const cw = pinCard.offsetWidth || 240;
      pinCard.style.left = `${Math.min(Math.max(-24, 12 - px), stage.w - 12 - cw - px)}px`;
    },
    still() { setPin(AUTO[0].item); render("found", AUTO[0].item); }
  };
}

/* ─── Scène 3D du hero ─────────────────────────────────────────────────── */
function hasWebGL() {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
}

async function initHero(ui) {
  const hero = $(".hero"), stageEl = $(".hero-stage"), canvas = $(".hero-canvas");
  const measure = () => { const r = stageEl.getBoundingClientRect(); stage.w = r.width; stage.h = r.height; };
  measure();
  const fail = () => { root.classList.add("no-webgl"); ui.still(); };
  if (!hasWebGL()) return fail();
  let mod;
  try { mod = await import("./hero3d.js"); } catch { return fail(); }
  try {
    hero3d = mod.createHero({
      canvas, reduced, coarse, lowPower: (navigator.hardwareConcurrency || 8) <= 4,
      sequence: AUTO.map((a) => a.item.target),
      onPin: (p) => ui.pin(p), onPhase: (p) => ui.phase(p)
    });
  } catch (e) { console.warn("[fulmo] 3D indisponible :", e); return fail(); }
  if (new URLSearchParams(location.search).has("capture")) window.__fulmoHero = hero3d;
  hero3d.setDay(root.getAttribute("data-theme") === "light");
  const reveal = () => requestAnimationFrame(() => root.classList.add("scene-ready"));

  if (reduced) {
    hero3d.still(AUTO[0].item.target); ui.still(); reveal();
    addEventListener("resize", () => { measure(); hero3d.resize(); hero3d.still(AUTO[0].item.target); });
    return;
  }
  let inView = true;
  const sync = () => (inView && !document.hidden ? hero3d.start() : hero3d.stop());
  new IntersectionObserver((es) => { inView = es[0].isIntersecting; sync(); }).observe(stageEl);
  document.addEventListener("visibilitychange", sync);

  if (!coarse) {
    const glow = $(".cursor-glow");
    hero.addEventListener("pointermove", (e) => {
      hero3d.setPointer((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
      if (glow) glow.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
    }, { passive: true });
    hero.addEventListener("pointerenter", () => glow?.classList.add("is-on"));
    hero.addEventListener("pointerleave", () => { glow?.classList.remove("is-on"); hero3d.setPointer(0, 0); });
  } else if ("DeviceOrientationEvent" in window && typeof DeviceOrientationEvent.requestPermission !== "function") {
    // Gyroscope sans demande de permission bloquante (Android) ; iOS garde l'orbite
    addEventListener("deviceorientation", (e) => {
      if (e.gamma == null) return;
      hero3d.setGyro(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, (e.beta - 45) / 40)));
    }, { passive: true });
  }
  // Le scroll dissout la pièce en nuage de points
  const onScroll = () => {
    const r = hero.getBoundingClientRect();
    hero3d.setScroll(-r.top / Math.max(1, r.height - innerHeight * 0.6));
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  addEventListener("resize", () => { measure(); hero3d.resize(); }, { passive: true });
  sync(); reveal();
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
        card.style.setProperty("--rx", `${(0.5 - y) * 8}deg`);
        card.style.setProperty("--ry", `${(x - 0.5) * 10}deg`);
        card.style.setProperty("--mx", `${x * 100}%`);
        card.style.setProperty("--my", `${y * 100}%`);
      });
    });
    card.addEventListener("pointerleave", () => { cancelAnimationFrame(raf); card.style.setProperty("--rx", "0deg"); card.style.setProperty("--ry", "0deg"); });
  });
}
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
function initMarquee() {
  const m = $(".marquee"), b = $(".mq-toggle");
  if (!m || !b) return;
  b.addEventListener("click", () => {
    const paused = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(paused));
    m.dataset.paused = String(paused);
    $(".mq-label", b).textContent = paused ? "Reprendre le défilement" : "Mettre en pause le défilement";
  });
}

/* ─── Démarrage ───────────────────────────────────────────────────────── */
initTheme();
initNav();
const ui = initHeroSearch();
initTilt();
initButtons();
initMarquee();
initStory({ reduced });
initSections({ reduced, coarse });
initBolt({ reduced, coarse });
const boot = () => initHero(ui);
if (document.readyState === "complete") setTimeout(boot, 30);
else addEventListener("load", () => setTimeout(boot, 30), { once: true });
