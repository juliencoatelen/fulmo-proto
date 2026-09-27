// Textures procédurales peintes en canvas : parquet, bois, tissus, enduit,
// ciel nocturne, tableau. Aucun fichier externe, tout est déterministe.
import {
  CanvasTexture, RepeatWrapping, SRGBColorSpace, NoColorSpace
} from "three";

// Générateur pseudo-aléatoire à graine : la pièce est la même à chaque visite.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")];
}

function tex(c, { repeat = [1, 1], color = true, aniso = 8 } = {}) {
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = aniso;
  return t;
}

// Fil du bois : lignes ondulées de faible opacité.
function grain(ctx, x, y, w, h, r, { lines = 26, dark = "rgba(60,34,16,", alpha = 0.16 } = {}) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  for (let i = 0; i < lines; i++) {
    const yy = y + r() * h;
    const amp = 1 + r() * 3;
    const freq = 0.004 + r() * 0.01;
    const ph = r() * 10;
    ctx.strokeStyle = dark + (alpha * (0.3 + r())).toFixed(3) + ")";
    ctx.lineWidth = 0.6 + r() * 1.4;
    ctx.beginPath();
    for (let xx = x; xx <= x + w; xx += 6) {
      const yv = yy + Math.sin(xx * freq + ph) * amp + Math.sin(xx * freq * 3.1 + ph) * amp * 0.3;
      xx === x ? ctx.moveTo(xx, yv) : ctx.lineTo(xx, yv);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function parquetTexture() {
  const [c, ctx] = canvas(1024, 1024);
  const r = rng(7);
  const rows = 8, rh = 1024 / rows;
  for (let row = 0; row < rows; row++) {
    let x = -r() * 400;
    while (x < 1024) {
      const len = 360 + r() * 420;
      const l = 38 + r() * 12, s = 42 + r() * 14, hue = 26 + r() * 8;
      ctx.fillStyle = `hsl(${hue} ${s}% ${l}%)`;
      ctx.fillRect(x, row * rh, len, rh);
      // léger dégradé le long de la lame
      const g = ctx.createLinearGradient(x, 0, x + len, 0);
      g.addColorStop(0, "rgba(255,230,200,0.05)");
      g.addColorStop(0.5, "rgba(0,0,0,0.06)");
      g.addColorStop(1, "rgba(255,230,200,0.04)");
      ctx.fillStyle = g; ctx.fillRect(x, row * rh, len, rh);
      grain(ctx, x, row * rh, len, rh, r, { lines: 18 });
      if (r() < 0.18) { // nœud
        const kx = x + r() * len, ky = row * rh + r() * rh;
        const kg = ctx.createRadialGradient(kx, ky, 0, kx, ky, 9);
        kg.addColorStop(0, "rgba(50,25,10,0.55)"); kg.addColorStop(1, "rgba(50,25,10,0)");
        ctx.fillStyle = kg; ctx.beginPath(); ctx.ellipse(kx, ky, 14, 6, 0, 0, 7); ctx.fill();
      }
      // joint de bout
      ctx.fillStyle = "rgba(30,16,8,0.7)"; ctx.fillRect(x, row * rh, 2, rh);
      x += len;
    }
    ctx.fillStyle = "rgba(30,16,8,0.75)";
    ctx.fillRect(0, row * rh, 1024, 2);
  }
  return tex(c, { repeat: [2.2, 2.2] });
}

export function woodTexture(seed = 3, { hue = 28, sat = 38, light = 46 } = {}) {
  const [c, ctx] = canvas(512, 512);
  const r = rng(seed);
  ctx.fillStyle = `hsl(${hue} ${sat}% ${light}%)`;
  ctx.fillRect(0, 0, 512, 512);
  grain(ctx, 0, 0, 512, 512, r, { lines: 70, alpha: 0.14 });
  grain(ctx, 0, 0, 512, 512, r, { lines: 30, dark: "rgba(255,225,190,", alpha: 0.06 });
  return tex(c);
}

// Tissage : trame + chaîne, grain de fibre. Rend bien avec `sheen`.
export function fabricTexture(seed = 5, base = "#6f806a", scale = 3) {
  const [c, ctx] = canvas(256, 256);
  const r = rng(seed);
  ctx.fillStyle = base; ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 4) {
    ctx.fillStyle = `rgba(255,255,255,${0.03 + r() * 0.04})`; ctx.fillRect(0, y, 256, 2);
  }
  for (let x = 0; x < 256; x += 4) {
    ctx.fillStyle = `rgba(0,0,0,${0.04 + r() * 0.05})`; ctx.fillRect(x, 0, 2, 256);
  }
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = r() < 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";
    ctx.fillRect(r() * 256, r() * 256, 1 + r() * 3, 1);
  }
  return tex(c, { repeat: [scale, scale] });
}

// Tapis berbère : crème, losanges anthracite, franges de laine.
export function rugTexture() {
  const [c, ctx] = canvas(1024, 640);
  const r = rng(11);
  ctx.fillStyle = "#e6dccb"; ctx.fillRect(0, 0, 1024, 640);
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = r() < 0.5 ? "rgba(255,255,255,0.08)" : "rgba(90,70,50,0.07)";
    ctx.fillRect(r() * 1024, r() * 640, 2, 2);
  }
  ctx.strokeStyle = "rgba(40,34,30,0.72)"; ctx.lineWidth = 5; ctx.lineJoin = "round";
  const cell = 128;
  for (let y = -cell; y < 640 + cell; y += cell) {
    for (let x = -cell; x < 1024 + cell; x += cell) {
      const jx = (r() - 0.5) * 6, jy = (r() - 0.5) * 6;
      ctx.beginPath();
      ctx.moveTo(x + cell / 2 + jx, y + jy);
      ctx.lineTo(x + cell + jx, y + cell / 2 + jy);
      ctx.lineTo(x + cell / 2 + jx, y + cell + jy);
      ctx.lineTo(x + jx, y + cell / 2 + jy);
      ctx.closePath(); ctx.stroke();
    }
  }
  ctx.strokeStyle = "rgba(40,34,30,0.8)"; ctx.lineWidth = 14;
  ctx.strokeRect(34, 34, 1024 - 68, 640 - 68);
  return tex(c);
}

// Enduit à la chaux : marbrures très douces, argile claire.
export function plasterTexture() {
  const [c, ctx] = canvas(512, 512);
  const r = rng(21);
  ctx.fillStyle = "#cfc1ab"; ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 220; i++) {
    const x = r() * 512, y = r() * 512, rad = 20 + r() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.03 + r() * 0.04;
    g.addColorStop(0, r() < 0.5 ? `rgba(255,248,236,${a})` : `rgba(120,98,76,${a})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return tex(c, { repeat: [2, 1] });
}

// Nuit derrière la fenêtre : dégradé bleu, lune voilée, immeubles lointains.
export function nightTexture() {
  const [c, ctx] = canvas(1024, 768);
  const r = rng(33);
  const g = ctx.createLinearGradient(0, 0, 0, 768);
  g.addColorStop(0, "#050a1c"); g.addColorStop(0.55, "#10204a"); g.addColorStop(1, "#2a3c73");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 768);
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(220,230,255,${0.2 + r() * 0.6})`;
    ctx.fillRect(r() * 1024, r() * 420, 1.4, 1.4);
  }
  const mx = 760, my = 170;
  const mg = ctx.createRadialGradient(mx, my, 0, mx, my, 220);
  mg.addColorStop(0, "rgba(220,230,255,0.95)"); mg.addColorStop(0.08, "rgba(210,222,255,0.9)");
  mg.addColorStop(0.1, "rgba(160,180,255,0.35)"); mg.addColorStop(1, "rgba(80,110,220,0)");
  ctx.fillStyle = mg; ctx.fillRect(0, 0, 1024, 768);
  // silhouettes d'immeubles
  let x = 0;
  while (x < 1024) {
    const w = 60 + r() * 120, h = 120 + r() * 260;
    const top = 768 - h;
    ctx.fillStyle = `hsl(228 40% ${7 + r() * 5}%)`;
    ctx.fillRect(x, top, w, h);
    for (let wy = top + 14; wy < 760; wy += 22) {
      for (let wx = x + 10; wx < x + w - 12; wx += 18) {
        if (r() < 0.17) {
          ctx.fillStyle = r() < 0.8 ? `rgba(255,${190 + r() * 40},120,0.85)` : "rgba(170,200,255,0.8)";
          ctx.fillRect(wx, wy, 8, 11);
        }
      }
    }
    x += w + r() * 8;
  }
  return tex(c, { aniso: 4 });
}

// Tableau abstrait : formes d'argile, sauge et ambre sur fond lin.
export function artTexture() {
  const [c, ctx] = canvas(512, 640);
  ctx.fillStyle = "#e9e1d2"; ctx.fillRect(0, 0, 512, 640);
  ctx.fillStyle = "#c8805a"; ctx.beginPath(); ctx.arc(190, 250, 130, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#6f806a"; ctx.fillRect(250, 300, 190, 260);
  ctx.fillStyle = "#1d2230"; ctx.beginPath(); ctx.arc(340, 180, 46, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#1d2230"; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(60, 520); ctx.bezierCurveTo(160, 420, 260, 600, 460, 470); ctx.stroke();
  const r = rng(4);
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = r() < 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
    ctx.fillRect(r() * 512, r() * 640, 2, 2);
  }
  return tex(c, { repeat: [1, 1] });
}

// Faisceau de lumière (fenêtre) : dégradé doux pour un plan additif.
export function beamTexture() {
  const [c, ctx] = canvas(128, 256);
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 256);
  const h = ctx.createLinearGradient(0, 0, 128, 0);
  h.addColorStop(0, "rgba(0,0,0,1)"); h.addColorStop(0.2, "rgba(0,0,0,0)");
  h.addColorStop(0.8, "rgba(0,0,0,0)"); h.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = h; ctx.fillRect(0, 0, 128, 256);
  return tex(c, { aniso: 1 });
}

// Jour derrière la fenêtre : ciel clair, nuages doux, façades ensoleillées.
export function dayTexture() {
  const [c, ctx] = canvas(1024, 768);
  const r = rng(35);
  const g = ctx.createLinearGradient(0, 0, 0, 768);
  g.addColorStop(0, "#6f9fdc"); g.addColorStop(0.6, "#b8d3ef"); g.addColorStop(1, "#e9eef2");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 768);
  for (let i = 0; i < 18; i++) {
    const x = r() * 1024, y = 60 + r() * 260, w = 120 + r() * 220;
    const cg = ctx.createRadialGradient(x, y, 0, x, y, w / 2);
    cg.addColorStop(0, "rgba(255,255,255,0.75)"); cg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = cg; ctx.save(); ctx.translate(x, y); ctx.scale(1, 0.35); ctx.translate(-x, -y);
    ctx.fillRect(x - w / 2, y - w / 2, w, w); ctx.restore();
  }
  let x = 0;
  while (x < 1024) {
    const w = 60 + r() * 120, h = 120 + r() * 260, top = 768 - h;
    ctx.fillStyle = `hsl(${28 + r() * 16} ${18 + r() * 14}% ${68 + r() * 14}%)`;
    ctx.fillRect(x, top, w, h);
    ctx.fillStyle = "rgba(60,70,90,0.22)";
    for (let wy = top + 14; wy < 760; wy += 22) for (let wx = x + 10; wx < x + w - 12; wx += 18) ctx.fillRect(wx, wy, 8, 11);
    ctx.fillStyle = "rgba(0,0,0,0.08)"; ctx.fillRect(x + w * 0.7, top, w * 0.3, h);
    x += w + r() * 8;
  }
  return tex(c, { aniso: 4 });
}
