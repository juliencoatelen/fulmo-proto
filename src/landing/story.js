// « Comment ça marche » : trois temps racontés par le scroll. Chaque étape
// publie sa progression (--p0, --p1, --p2) sur la scène collante ; le CSS et
// le SVG font le reste.
export function initStory({ reduced }) {
  const stage = document.querySelector(".story-stage");
  const steps = Array.from(document.querySelectorAll(".story-step"));
  if (!stage || !steps.length) return;
  const typed = stage.querySelector(".st-typed");
  const query = typed ? typed.dataset.text : "";
  let ticking = false;

  function update() {
    ticking = false;
    const vh = window.innerHeight;
    let active = 0;
    steps.forEach((s, i) => {
      const r = s.getBoundingClientRect();
      const p = reduced ? 1 : Math.min(1, Math.max(0, (vh * 0.78 - r.top) / (r.height * 0.9)));
      stage.style.setProperty(`--p${i}`, p.toFixed(3));
      if (r.top < vh * 0.62) active = i;
      if (i === 2 && typed) typed.textContent = query.slice(0, Math.round(Math.min(1, p * 2.2) * query.length));
    });
    if (stage.dataset.active !== String(active)) {
      stage.dataset.active = String(active);
      steps.forEach((s, i) => s.classList.toggle("is-active", i === active));
    }
  }
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  update();
}
