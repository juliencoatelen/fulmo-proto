// CTA final : l'éclair de Fulmo composé de particules. Elles s'assemblent quand
// la section entre dans l'écran et s'écartent sous le pointeur.
const BOLT = "M27.6 8.5 15.5 26.6h6.8l-2.3 13.1 12.5-18.9h-6.9z";

export function initBolt({ reduced, coarse }) {
  const canvas = document.querySelector(".bolt-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const section = canvas.closest("section");
  let W = 0, H = 0, dpr = 1, parts = [], raf = 0, running = false, formed = 0;
  const mouse = { x: -9999, y: -9999 };

  function targets() {
    // rasterise l'éclair et prélève une grille de points à l'intérieur
    const size = Math.min(W * 0.9, H * 1.05, 760);
    const off = document.createElement("canvas");
    off.width = off.height = Math.ceil(size);
    const o = off.getContext("2d");
    const k = size / 48;
    o.setTransform(k, 0, 0, k, -k * 1.2, 0);
    o.fillStyle = "#fff";
    o.fill(new Path2D(BOLT));
    const data = o.getImageData(0, 0, off.width, off.height).data;
    const gap = Math.max(5, Math.round(size / (coarse ? 70 : 105)));
    const pts = [];
    const ox = (W - size) / 2 + (W > 900 ? W * 0.2 : 0), oy = (H - size) / 2;
    for (let y = 0; y < off.height; y += gap) {
      for (let x = 0; x < off.width; x += gap) {
        if (data[(y * off.width + x) * 4 + 3] > 128) pts.push([ox + x + (Math.random() - 0.5) * gap * 0.6, oy + y + (Math.random() - 0.5) * gap * 0.6]);
      }
    }
    return pts;
  }

  function build() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = targets();
    parts = pts.map(([tx, ty]) => ({
      tx, ty,
      x: Math.random() * W, y: H + Math.random() * H * 0.6,
      vx: 0, vy: 0,
      s: 1.2 + Math.random() * 1.8,
      c: Math.random() < 0.1 ? "#a79dff" : Math.random() < 0.5 ? "#d9ff3d" : "#eaff8a",
      d: Math.random()
    }));
    if (reduced) { for (const p of parts) { p.x = p.tx; p.y = p.ty; } draw(1); }
  }

  function draw(tStep) {
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const p of parts) {
      if (!reduced) {
        const f = formed > p.d * 0.6 ? 0.06 : 0.004;
        let ax = (p.tx - p.x) * f, ay = (p.ty - p.y) * f;
        const dx = p.x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < 14000) { const k = (14000 - d2) / 14000 * 2.4; const d = Math.sqrt(d2) || 1; ax += dx / d * k; ay += dy / d * k; }
        p.vx = (p.vx + ax * tStep) * Math.pow(0.86, tStep); p.vy = (p.vy + ay * tStep) * Math.pow(0.86, tStep);
        p.x += p.vx * tStep; p.y += p.vy * tStep;
      }
      ctx.fillStyle = p.c;
      ctx.globalAlpha = 0.55 + p.d * 0.45;
      ctx.fillRect(p.x, p.y, p.s, p.s);
    }
    ctx.globalAlpha = 1;
  }

  let last = 0;
  function loop(ts = performance.now()) {
    raf = requestAnimationFrame(loop);
    // pas de temps en « images à 60 Hz », borné : même rendu à 30 ou 120 Hz
    const step = last ? Math.min(3, (ts - last) / 16.67) : 1;
    last = ts;
    formed = Math.min(1.2, formed + 0.025 * step);
    draw(step);
  }

  build();
  if (reduced) { window.addEventListener("resize", build); return; }
  let inView = false;
  const sync = () => {
    const on = inView && !document.hidden;
    if (on && !running) { running = true; last = 0; loop(); }
    else if (!on && running) { running = false; cancelAnimationFrame(raf); }
  };
  new IntersectionObserver((es) => { inView = es[0].isIntersecting; sync(); }, { threshold: 0.05 }).observe(section);
  document.addEventListener("visibilitychange", sync);
  section.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
  }, { passive: true });
  section.addEventListener("pointerleave", () => { mouse.x = mouse.y = -9999; });
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { build(); formed = 1.2; }, 150); }, { passive: true });
}
