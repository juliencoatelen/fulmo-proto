// La pièce : un bureau-salon de nuit. Parquet de chêne, enduit argile, grande
// fenêtre bleutée, canapé en lin sauge, bibliothèque, commode à tiroirs.
// Unités : mètres. Sol à y = 0, mur du fond à z = -2.4.
import {
  Group, Mesh, MeshPhysicalMaterial, MeshBasicMaterial, PlaneGeometry, BoxGeometry,
  CylinderGeometry, SphereGeometry, LatheGeometry, TorusGeometry, Vector2, Vector3, Color,
  DirectionalLight, PointLight, AmbientLight, HemisphereLight, BufferAttribute,
  AdditiveBlending, DoubleSide, SpotLight
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as T from "./textures.js";
import { patchMaterial } from "./dissolve.js";

const WALL_Z = -2.4;

export function buildRoom(scene, { quality = 1 } = {}) {
  const room = new Group();
  scene.add(room);
  const sampled = [];   // meshes échantillonnés pour le nuage : { mesh, weight }
  const r = T.rng(99);

  const tx = {
    parquet: T.parquetTexture(),
    oak: T.woodTexture(3, { hue: 30, sat: 40, light: 50 }),
    walnut: T.woodTexture(8, { hue: 22, sat: 34, light: 30 }),
    sofa: T.fabricTexture(5, "#7b8c73", 4),
    linen: T.fabricTexture(6, "#e3d9c6", 3),
    felt: T.fabricTexture(9, "#3b3a40", 2),
    rug: T.rugTexture(),
    plaster: T.plasterTexture(),
    night: T.nightTexture(),
    day: T.dayTexture(),
    art: T.artTexture(),
    beam: T.beamTexture()
  };

  const M = (p) => patchMaterial(new MeshPhysicalMaterial(p));
  const mats = {
    floor: M({ map: tx.parquet, roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.35 }),
    wall: M({ map: tx.plaster, color: "#b8a68e", roughness: 0.96 }),
    wallSide: M({ map: tx.plaster, color: "#8d7f6c", roughness: 0.96 }),
    ceiling: M({ color: "#2b2622", roughness: 1 }),
    trim: M({ color: "#e8e0d2", roughness: 0.6 }),
    oak: M({ map: tx.oak, roughness: 0.48, clearcoat: 0.18, clearcoatRoughness: 0.4 }),
    walnut: M({ map: tx.walnut, roughness: 0.42, clearcoat: 0.25, clearcoatRoughness: 0.3 }),
    sofa: M({ map: tx.sofa, roughness: 0.92, sheen: 1, sheenRoughness: 0.55, sheenColor: new Color("#c9d6bf") }),
    linen: M({ map: tx.linen, roughness: 0.9, sheen: 0.8, sheenRoughness: 0.6, sheenColor: new Color("#fff4e2"), side: DoubleSide }),
    felt: M({ map: tx.felt, roughness: 0.95, sheen: 0.6, sheenColor: new Color("#8a8a95") }),
    rug: M({ map: tx.rug, roughness: 0.97, sheen: 0.7, sheenRoughness: 0.8, sheenColor: new Color("#fff") }),
    brass: M({ color: "#c9a25a", metalness: 1, roughness: 0.28 }),
    blackMetal: M({ color: "#1b1b1f", metalness: 0.7, roughness: 0.45 }),
    clay: M({ color: "#b8694a", roughness: 0.82 }),
    ceramic: M({ color: "#e8e2d6", roughness: 0.3, clearcoat: 0.6 }),
    leaf: M({ color: "#3f5a36", roughness: 0.55, clearcoat: 0.4, clearcoatRoughness: 0.4, side: DoubleSide }),
    soil: M({ color: "#2a1f17", roughness: 1 }),
    frame: M({ color: "#141417", roughness: 0.5, metalness: 0.2 }),
    art: M({ map: tx.art, roughness: 0.85 }),
    books: M({ vertexColors: true, roughness: 0.7 }),
    shade: patchMaterial(new MeshPhysicalMaterial({
      color: "#f3e3c8", roughness: 0.9, side: DoubleSide,
      emissive: new Color("#ffb46b"), emissiveIntensity: 0.9
    })),
    glass: new MeshPhysicalMaterial({ color: "#9fb6ff", roughness: 0.05, transparent: true, opacity: 0.12, metalness: 0 }),
    passport: M({ color: "#26315c", roughness: 0.6 })
  };
  patchMaterial(mats.glass);

  function add(geo, mat, pos, { weight = 1, shadow = true, receive = true, rot, parent = room, sample = true } = {}) {
    const m = new Mesh(geo, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = shadow; m.receiveShadow = receive;
    parent.add(m);
    if (sample && weight > 0) sampled.push({ mesh: m, weight });
    return m;
  }
  const rbox = (w, h, d, rad = 0.02, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, Math.min(rad, w / 2.01, h / 2.01, d / 2.01));

  /* ─── Enveloppe ─────────────────────────────────────────────────────── */
  const floorGeo = new PlaneGeometry(9, 6.2);
  add(floorGeo, mats.floor, [0, 0, 0.7], { rot: [-Math.PI / 2, 0, 0], weight: 0.22, shadow: false });

  // Mur du fond percé d'une fenêtre : x ∈ [-2.95, -0.95], y ∈ [0.7, 2.55]
  const H = 2.9, wx0 = -2.95, wx1 = -0.95, wy0 = 0.7, wy1 = 2.55, t = 0.14;
  const wz = WALL_Z - t / 2;
  const wallPart = (x0, x1, y0, y1) =>
    add(new BoxGeometry(x1 - x0, y1 - y0, t), mats.wall, [(x0 + x1) / 2, (y0 + y1) / 2, wz], { weight: 0.18 });
  wallPart(-4.5, wx0, 0, H); wallPart(wx1, 4.5, 0, H);
  wallPart(wx0, wx1, 0, wy0); wallPart(wx0, wx1, wy1, H);
  // murs latéraux + plafond
  add(new PlaneGeometry(6.2, H), mats.wallSide, [-4.5, H / 2, 0.7], { rot: [0, Math.PI / 2, 0], weight: 0.08, shadow: false });
  add(new PlaneGeometry(6.2, H), mats.wallSide, [4.5, H / 2, 0.7], { rot: [0, -Math.PI / 2, 0], weight: 0.08, shadow: false });
  add(new PlaneGeometry(9, 6.2), mats.ceiling, [0, H, 0.7], { rot: [Math.PI / 2, 0, 0], weight: 0, shadow: false });
  // plinthes
  add(new BoxGeometry(9, 0.09, 0.018), mats.trim, [0, 0.045, WALL_Z + 0.009], { weight: 0.3 });

  // Fenêtre : dormant, meneaux, appui, vitrage, ciel nocturne derrière
  const fw = wx1 - wx0, fh = wy1 - wy0, fcx = (wx0 + wx1) / 2, fcy = (wy0 + wy1) / 2;
  const frame = (w, h, x, y, z = WALL_Z - 0.03, d = 0.08) => add(rbox(w, h, d, 0.008, 2), mats.trim, [x, y, z], { weight: 0.8 });
  frame(fw + 0.1, 0.07, fcx, wy1 + 0.0);
  frame(fw + 0.1, 0.07, fcx, wy0);
  frame(0.07, fh, wx0, fcy); frame(0.07, fh, wx1, fcy);
  frame(0.045, fh, fcx, fcy, WALL_Z - 0.05, 0.05);
  frame(fw, 0.045, fcx, wy0 + fh * 0.66, WALL_Z - 0.05, 0.05);
  add(rbox(fw + 0.26, 0.04, 0.2, 0.01, 2), mats.trim, [fcx, wy0 - 0.02, WALL_Z + 0.06], { weight: 0.8 });
  add(new PlaneGeometry(fw, fh), mats.glass, [fcx, fcy, WALL_Z - 0.06], { shadow: false, receive: false, weight: 0 });
  const sky = new Mesh(new PlaneGeometry(9, 6.6), patchMaterial(new MeshBasicMaterial({ map: tx.night, fog: false })));
  sky.position.set(fcx + 0.4, 1.9, WALL_Z - 2.4);
  room.add(sky);
  // Faisceau de lune : plan additif très doux, posé en biais vers le sol
  const beam = new Mesh(new PlaneGeometry(2.1, 3.2), new MeshBasicMaterial({
    map: tx.beam, color: "#5b7bd6", transparent: true, opacity: 0.1, blending: AdditiveBlending,
    depthWrite: false, side: DoubleSide, fog: false
  }));
  beam.position.set(fcx + 0.15, 1.05, WALL_Z + 1.25);
  beam.rotation.set(-1.05, 0, 0);
  room.add(beam);

  // Rideaux en lin, plissés
  const curtain = (x) => {
    const g = new PlaneGeometry(0.46, 2.6, 36, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i);
      p.setZ(i, Math.sin(u * 44 + x * 3) * 0.035 + Math.sin(u * 17) * 0.02);
    }
    g.computeVertexNormals();
    add(g, mats.linen, [x, 1.4, WALL_Z + 0.14], { weight: 0.9 });
  };
  curtain(wx0 - 0.2); curtain(wx1 + 0.2);
  add(new CylinderGeometry(0.012, 0.012, fw + 1.1, 12), mats.blackMetal, [fcx, 2.72, WALL_Z + 0.14], { rot: [0, 0, Math.PI / 2], weight: 0.4 });

  /* ─── Tapis ─────────────────────────────────────────────────────────── */
  add(rbox(3.6, 0.014, 2.4, 0.006, 1), mats.rug, [-0.4, 0.007, -0.55], { weight: 0.45, shadow: false });

  /* ─── Canapé sous la fenêtre ────────────────────────────────────────── */
  const sx = -1.95, sz = WALL_Z + 0.55;
  add(rbox(2.3, 0.26, 0.92, 0.06), mats.sofa, [sx, 0.26, sz], { weight: 1 });
  for (const dx of [-0.53, 0.53]) {
    add(rbox(1.04, 0.17, 0.72, 0.07, 4), mats.sofa, [sx + dx, 0.47, sz + 0.08], { weight: 1 });
    add(rbox(1.02, 0.46, 0.24, 0.1, 4), mats.sofa, [sx + dx, 0.76, sz - 0.3], { rot: [-0.12, 0, 0], weight: 1 });
  }
  for (const dx of [-1.08, 1.08]) add(rbox(0.2, 0.58, 0.94, 0.08, 4), mats.sofa, [sx + dx, 0.4, sz], { weight: 1 });
  for (const [dx, dz] of [[-1.05, -0.36], [1.05, -0.36], [-1.05, 0.36], [1.05, 0.36]])
    add(new CylinderGeometry(0.022, 0.016, 0.13, 10), mats.walnut, [sx + dx, 0.065, sz + dz], { weight: 0.2 });
  // coussins et plaid
  add(rbox(0.46, 0.42, 0.14, 0.07, 4), mats.linen, [sx - 0.72, 0.74, sz - 0.12], { rot: [-0.25, 0.3, 0.08], weight: 1 });
  add(rbox(0.4, 0.38, 0.13, 0.07, 4), mats.clay, [sx + 0.78, 0.72, sz - 0.1], { rot: [-0.25, -0.35, -0.1], weight: 1 });
  add(rbox(0.5, 0.03, 0.96, 0.015, 2), mats.linen, [sx + 1.1, 0.7, sz + 0.02], { rot: [0, 0, 0.12], weight: 0.8 });

  /* ─── Table basse ronde, livre, tasse ───────────────────────────────── */
  const ctX = -1.75, ctZ = -0.55;
  add(new CylinderGeometry(0.46, 0.46, 0.04, 64), mats.walnut, [ctX, 0.4, ctZ], { weight: 1 });
  for (let i = 0; i < 3; i++) {
    const a = i * 2.094 + 0.4;
    add(new CylinderGeometry(0.018, 0.014, 0.39, 10), mats.walnut, [ctX + Math.cos(a) * 0.3, 0.19, ctZ + Math.sin(a) * 0.3], { rot: [Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12], weight: 0.2 });
  }
  add(rbox(0.28, 0.035, 0.2, 0.004, 1), M({ color: "#8c3b2e", roughness: 0.7 }), [ctX - 0.1, 0.437, ctZ + 0.05], { rot: [0, 0.3, 0], weight: 1 });
  const mug = new LatheGeometry([new Vector2(0, 0), new Vector2(0.04, 0), new Vector2(0.043, 0.09), new Vector2(0.038, 0.09), new Vector2(0.035, 0.01)], 24);
  add(mug, mats.ceramic, [ctX + 0.18, 0.42, ctZ - 0.1], { weight: 1 });

  /* ─── Lampadaire en laiton ──────────────────────────────────────────── */
  const flX = -0.5, flZ = WALL_Z + 0.45;
  add(new CylinderGeometry(0.16, 0.18, 0.025, 32), mats.blackMetal, [flX, 0.013, flZ], { weight: 0.5 });
  add(new CylinderGeometry(0.012, 0.012, 1.5, 12), mats.brass, [flX, 0.77, flZ], { weight: 0.5 });
  add(new CylinderGeometry(0.19, 0.25, 0.32, 48, 1, true), mats.shade, [flX, 1.62, flZ], { weight: 0.9, shadow: false });
  const floorLamp = new PointLight("#ffb068", 5.5, 0, 2);
  floorLamp.position.set(flX, 1.6, flZ);
  room.add(floorLamp);

  /* ─── Bibliothèque en chêne ─────────────────────────────────────────── */
  const bx = 0.95, bw = 1.72, bh = 2.24, bd = 0.38, bz = WALL_Z + bd / 2 + 0.01;
  const shelfYs = [0.08, 0.52, 0.96, 1.4, 1.84];
  const bookcase = new Group(); room.add(bookcase);
  const B = (g, m, p, o = {}) => add(g, m, p, { ...o, parent: bookcase });
  B(rbox(0.035, bh, bd, 0.006, 2), mats.oak, [bx - bw / 2, bh / 2, bz], { weight: 1 });
  B(rbox(0.035, bh, bd, 0.006, 2), mats.oak, [bx + bw / 2, bh / 2, bz], { weight: 1 });
  B(rbox(0.03, bh - 0.05, bd - 0.02, 0.005, 2), mats.oak, [bx, bh / 2, bz], { weight: 1 });
  B(rbox(bw + 0.035, 0.035, bd, 0.006, 2), mats.oak, [bx, bh, bz], { weight: 1 });
  B(new BoxGeometry(bw, bh, 0.012), mats.walnut, [bx, bh / 2, WALL_Z + 0.02], { weight: 0.5 });
  for (const y of shelfYs) B(rbox(bw, 0.03, bd - 0.01, 0.005, 2), mats.oak, [bx, y, bz], { weight: 1 });

  // Livres : une géométrie fusionnée à couleurs de sommets (un seul appel de rendu)
  const palette = ["#1f2a44", "#7a2f25", "#c9a25a", "#e7ddc9", "#415a3a", "#2a2a30", "#a4542f", "#6d7fa6", "#d8cbb8", "#51313a", "#8b8f6a"];
  const bookGeos = [];
  const addBook = (w, h, d, x, y, z, rz = 0, ry = 0) => {
    const g = rbox(w, h, d, 0.004, 1);
    g.rotateZ(rz); g.rotateY(ry);
    g.translate(x, y, z);
    const col = new Color(palette[Math.floor(r() * palette.length)]);
    col.multiplyScalar(0.8 + r() * 0.3);
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
    g.setAttribute("color", new BufferAttribute(arr, 3));
    bookGeos.push(g);
  };
  const fillShelf = (x0, x1, y, { leanEnd = false, stackAt = -1 } = {}) => {
    let x = x0 + 0.01;
    let i = 0;
    while (x < x1 - 0.06) {
      if (i === stackAt) { // pile couchée
        let yy = y;
        const sw = 0.2 + r() * 0.05;
        for (let k = 0; k < 4; k++) {
          const th = 0.03 + r() * 0.02;
          addBook(sw - r() * 0.03, th, 0.19 + r() * 0.03, x + sw / 2, yy + th / 2, bz + 0.02, 0, (r() - 0.5) * 0.12);
          yy += th;
        }
        x += sw + 0.02; i++; continue;
      }
      const w = 0.022 + r() * 0.03, h = 0.2 + r() * 0.14, d = 0.17 + r() * 0.06;
      addBook(w, h, d, x + w / 2, y + h / 2, bz + 0.03 - (0.22 - d) / 2);
      x += w + 0.002; i++;
      if (leanEnd && x > x1 - 0.22) { addBook(0.03, 0.26, 0.2, x + 0.08, y + 0.125, bz + 0.03, -0.32); break; }
    }
  };
  const L0 = bx - bw / 2 + 0.02, L1 = bx - 0.02, R0 = bx + 0.02, R1 = bx + bw / 2 - 0.02;
  fillShelf(L0, L1 - 0.05, shelfYs[4] + 0.015, { stackAt: 9 });
  fillShelf(R0 + 0.28, R1, shelfYs[4] + 0.015, { leanEnd: true });
  fillShelf(L0, L1 - 0.3, shelfYs[3] + 0.015, { leanEnd: true });
  fillShelf(R0, R1, shelfYs[3] + 0.015, { stackAt: 4 });
  fillShelf(L0 + 0.1, L1, shelfYs[2] + 0.015, { stackAt: 12 });
  fillShelf(R0 + 0.36, R1, shelfYs[2] + 0.015);
  fillShelf(R0, R1 - 0.3, shelfYs[1] + 0.015, { leanEnd: true });
  const books = new Mesh(mergeGeometries(bookGeos), mats.books);
  books.castShadow = books.receiveShadow = true;
  bookcase.add(books); sampled.push({ mesh: books, weight: 1.6 });

  // Déco : vase en céramique, petit pot, bougie
  const vase = new LatheGeometry([0, 0.05, 0.075, 0.08, 0.06, 0.035, 0.04].map((rr, i) => new Vector2(i === 0 ? 0 : rr, i * 0.045)), 32);
  B(vase, mats.ceramic, [R0 + 0.13, shelfYs[4] + 0.015, bz + 0.02], { weight: 1 });
  B(new CylinderGeometry(0.07, 0.06, 0.12, 24), mats.clay, [L1 - 0.14, shelfYs[3] + 0.075, bz + 0.03], { weight: 1 });
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05;
    const leaf = new SphereGeometry(0.06, 12, 8); leaf.scale(1, 0.25, 0.5);
    B(leaf, mats.leaf, [L1 - 0.14 + Math.cos(a) * 0.06, shelfYs[3] + 0.16 + (i % 2) * 0.03, bz + 0.03 + Math.sin(a) * 0.05], { rot: [0.3 * Math.sin(a), a, 0.5], weight: 1 });
  }

  // Chaque contenant « cherchable » a son propre matériau (il pulse seul en volt)
  const targetMat = (m) => { const c = m.clone(); patchMaterial(c); c.emissive = new Color("#d9ff3d"); c.emissiveIntensity = 0; return c; };
  const targets = {};

  // Bacs en tissu (étagère du bas), numérotés de gauche à droite.
  const binY = shelfYs[0] + 0.015 + 0.14;
  const binXs = [L0 + 0.2, L1 - 0.2, R0 + 0.2, R1 - 0.2];
  const binMats = [mats.linen, mats.felt, mats.linen, mats.felt];
  const bulbMat = new MeshBasicMaterial({ color: new Color("#ffcf8a").multiplyScalar(1.5), toneMapped: false });
  let bulbs = null;
  binXs.forEach((x, i) => {
    const g = new Group(); bookcase.add(g);
    const m = targetMat(binMats[i]); m.side = 0;
    add(rbox(0.38, 0.28, 0.32, 0.03, 3), m, [x, binY, bz + 0.02], { parent: g, weight: 1.3 });
    add(new TorusGeometry(0.03, 0.008, 6, 16, Math.PI), mats.felt, [x, binY + 0.07, bz + 0.18], { parent: g, weight: 0.5 });
    if (i === 0) { // la guirlande dépasse du bac 1
      bulbs = new Group(); g.add(bulbs);
      for (let k = 0; k < 9; k++) {
        const bl = new Mesh(new SphereGeometry(0.011, 8, 6), bulbMat);
        bl.position.set(x - 0.15 + k * 0.035, binY + 0.14 + Math.sin(k * 1.3) * 0.02, bz + 0.02 + Math.cos(k * 1.7) * 0.07);
        bulbs.add(bl);
      }
    }
    targets[`bac-${i + 1}`] = {
      group: g, mat: m, open: new Vector3(0, 0, 0.24), bulbs: i === 0,
      anchor: new Vector3(x, binY + 0.2, bz + 0.2), focus: new Vector3(x, binY, bz)
    };
  });

  // Boîte à câbles en noyer (étagère du milieu, à droite)
  const boxGroup = new Group(); bookcase.add(boxGroup);
  const boxMat = targetMat(mats.walnut);
  add(rbox(0.3, 0.13, 0.22, 0.012, 2), boxMat, [R0 + 0.17, shelfYs[2] + 0.015 + 0.065, bz + 0.03], { parent: boxGroup, weight: 1.3 });
  add(new TorusGeometry(0.035, 0.006, 6, 24), mats.blackMetal, [R0 + 0.17, shelfYs[2] + 0.14, bz + 0.03], { parent: boxGroup, rot: [Math.PI / 2, 0, 0], weight: 0.6 });
  targets["boite-cables"] = {
    group: boxGroup, mat: boxMat, open: new Vector3(0, 0, 0.16),
    anchor: new Vector3(R0 + 0.17, shelfYs[2] + 0.18, bz + 0.18), focus: new Vector3(R0 + 0.17, shelfYs[2] + 0.08, bz)
  };

  /* ─── Commode à trois tiroirs ───────────────────────────────────────── */
  const cx = 2.85, cw = 1.3, ch = 0.78, cd = 0.48, legH = 0.15, cz = WALL_Z + cd / 2 + 0.02;
  const commode = new Group(); room.add(commode);
  const C = (g, m, p, o = {}) => add(g, m, p, { ...o, parent: commode });
  C(rbox(cw, ch, cd, 0.01, 2), mats.walnut, [cx, legH + ch / 2, cz], { weight: 1 });
  C(rbox(cw + 0.04, 0.035, cd + 0.03, 0.01, 2), mats.oak, [cx, legH + ch + 0.017, cz + 0.005], { weight: 1 });
  for (const [dx, dz] of [[-0.58, -0.18], [0.58, -0.18], [-0.58, 0.18], [0.58, 0.18]])
    C(new CylinderGeometry(0.02, 0.012, legH, 10), mats.walnut, [cx + dx, legH / 2, cz + dz], { rot: [dz > 0 ? 0.08 : -0.08, 0, dx > 0 ? -0.08 : 0.08], weight: 0.3 });
  const drawerH = (ch - 0.08) / 3;
  const front = cz + cd / 2;
  const drawerIds = ["commode-haut", "commode-milieu", "commode-bas"];
  for (let i = 0; i < 3; i++) {
    const y = legH + 0.04 + drawerH * (2 - i) + drawerH / 2;
    const g = new Group(); commode.add(g);
    const fm = targetMat(mats.oak);
    add(rbox(cw - 0.06, drawerH - 0.02, 0.025, 0.008, 2), fm, [cx, y, front + 0.012], { parent: g, weight: 1.4 });
    for (const dx of [-0.3, 0.3])
      add(new SphereGeometry(0.018, 16, 10), mats.brass, [cx + dx, y, front + 0.035], { parent: g, weight: 0.3 });
    // caisson (visible une fois ouvert) et son contenu
    const inW = cw - 0.14, inD = cd - 0.06, yb = y - drawerH / 2 + 0.03;
    add(new BoxGeometry(inW, 0.012, inD), mats.oak, [cx, yb, front - inD / 2], { parent: g, weight: 0.3, sample: i === 0 });
    add(new BoxGeometry(0.012, drawerH - 0.05, inD), mats.oak, [cx - inW / 2, yb + drawerH / 2 - 0.03, front - inD / 2], { parent: g, weight: 0.3, sample: i === 0 });
    add(new BoxGeometry(0.012, drawerH - 0.05, inD), mats.oak, [cx + inW / 2, yb + drawerH / 2 - 0.03, front - inD / 2], { parent: g, weight: 0.3, sample: i === 0 });
    if (i === 0) { // papiers : passeport, carte grise
      add(rbox(0.125, 0.012, 0.176, 0.004, 1), mats.passport, [cx - 0.12, yb + 0.012, front - 0.14], { parent: g, rot: [0, 0.22, 0], weight: 1.5 });
      add(rbox(0.21, 0.01, 0.297, 0.002, 1), mats.ceramic, [cx + 0.18, yb + 0.01, front - 0.2], { parent: g, rot: [0, -0.1, 0], weight: 0.6 });
    } else if (i === 1) { // pharmacie
      add(rbox(0.3, 0.1, 0.2, 0.01, 2), mats.ceramic, [cx - 0.2, yb + 0.056, front - 0.16], { parent: g, rot: [0, 0.1, 0], weight: 0, sample: false });
      add(new CylinderGeometry(0.03, 0.03, 0.12, 16), mats.clay, [cx + 0.15, yb + 0.066, front - 0.12], { parent: g, weight: 0, sample: false });
    } else { // outillage
      add(rbox(0.42, 0.12, 0.24, 0.02, 2), M({ color: "#a4542f", roughness: 0.55 }), [cx - 0.1, yb + 0.066, front - 0.16], { parent: g, rot: [0, -0.08, 0], weight: 0, sample: false });
      add(rbox(0.22, 0.02, 0.05, 0.008, 1), mats.blackMetal, [cx + 0.3, yb + 0.02, front - 0.12], { parent: g, rot: [0, 0.5, 0], weight: 0, sample: false });
    }
    targets[drawerIds[i]] = {
      group: g, mat: fm, open: new Vector3(0, 0, 0.3),
      anchor: new Vector3(cx, y + 0.1, front + 0.1), focus: new Vector3(cx, y, front - 0.1)
    };
  }

  // Lampe de table en céramique + abat-jour
  const tlX = cx - 0.38, tlY = legH + ch + 0.035, tlZ = cz - 0.02;
  const lampBase = new LatheGeometry([0, 0.07, 0.1, 0.105, 0.085, 0.03, 0.025].map((rr, i) => new Vector2(i === 0 ? 0 : rr, i * 0.05)), 32);
  C(lampBase, mats.clay, [tlX, tlY, tlZ], { weight: 1 });
  C(new CylinderGeometry(0.008, 0.008, 0.18, 8), mats.brass, [tlX, tlY + 0.38, tlZ], { weight: 0.3 });
  C(new CylinderGeometry(0.13, 0.19, 0.22, 40, 1, true), mats.shade, [tlX, tlY + 0.52, tlZ], { weight: 0.9, shadow: false });
  const tableLamp = new PointLight("#ffb068", 2.2, 0, 2);
  tableLamp.position.set(tlX, tlY + 0.44, tlZ + 0.16);
  room.add(tableLamp);
  // Pile de livres + coupelle
  addBookLater(cx + 0.28, tlY, cz);
  function addBookLater(x, y, z) {
    let yy = y;
    for (const [w, c] of [[0.3, "#1f2a44"], [0.27, "#e7ddc9"], [0.24, "#7a2f25"]]) {
      C(rbox(w, 0.035, w * 0.72, 0.004, 1), M({ color: c, roughness: 0.7 }), [x, yy + 0.0175, z], { rot: [0, (r() - 0.5) * 0.3, 0], weight: 1 });
      yy += 0.035;
    }
    const bowl = new LatheGeometry([new Vector2(0, 0), new Vector2(0.05, 0.002), new Vector2(0.085, 0.035), new Vector2(0.08, 0.037), new Vector2(0.046, 0.008)], 28);
    C(bowl, mats.ceramic, [x, yy, z], { weight: 1 });
  }
  // Tableau encadré au-dessus
  C(rbox(0.72, 0.9, 0.035, 0.006, 2), mats.frame, [cx + 0.05, 1.72, WALL_Z + 0.02], { weight: 1 });
  C(new PlaneGeometry(0.6, 0.78), mats.art, [cx + 0.05, 1.72, WALL_Z + 0.04], { weight: 1, shadow: false });

  /* ─── Grande plante en pot ──────────────────────────────────────────── */
  const px = 3.95, pz = WALL_Z + 0.75;
  const pot = new LatheGeometry([new Vector2(0, 0), new Vector2(0.17, 0), new Vector2(0.2, 0.36), new Vector2(0.21, 0.4), new Vector2(0.19, 0.4), new Vector2(0.18, 0.37)], 40);
  add(pot, mats.clay, [px, 0, pz], { weight: 1 });
  add(new CylinderGeometry(0.185, 0.185, 0.01, 32), mats.soil, [px, 0.36, pz], { weight: 0.3 });
  const leafGeos = [], stemGeos = [];
  for (let i = 0; i < 22; i++) {
    const a = i * 2.4 + r() * 0.5, hgt = 0.7 + r() * 1.05, rad = 0.12 + r() * 0.34;
    const tip = new Vector3(Math.cos(a) * rad, hgt, Math.sin(a) * rad);
    const base = new Vector3(Math.cos(a) * 0.03, 0.36, Math.sin(a) * 0.03);
    const dir = tip.clone().sub(base), len = dir.length();
    const stem = new CylinderGeometry(0.006, 0.009, len, 5);
    stem.translate(0, len / 2, 0);
    stem.rotateX(Math.PI / 2);
    stem.lookAt(dir);
    stem.translate(base.x, base.y, base.z);
    stemGeos.push(stem);
    const leaf = new SphereGeometry(0.16, 14, 8, 0, Math.PI * 2, 0, Math.PI);
    leaf.scale(0.55 + r() * 0.35, 0.08, 1.0);
    const lp = leaf.attributes.position;
    for (let k = 0; k < lp.count; k++) lp.setY(k, lp.getY(k) - lp.getZ(k) * lp.getZ(k) * 1.4); // courbure
    leaf.computeVertexNormals();
    const lm = new Mesh(leaf);
    lm.position.copy(tip); lm.rotation.set(-0.5 + r() * 0.4, a + Math.PI / 2, (r() - 0.5) * 0.9);
    lm.updateMatrix(); leaf.applyMatrix4(lm.matrix);
    leafGeos.push(leaf);
  }
  add(mergeGeometries(leafGeos), mats.leaf, [px, 0, pz], { weight: 1.2 });
  add(mergeGeometries(stemGeos), mats.leaf, [px, 0, pz], { weight: 0.2 });

  /* ─── Lumières ──────────────────────────────────────────────────────── */
  const moon = new DirectionalLight("#9cb6ff", 2.4);
  moon.position.set(fcx - 0.6, 3.6, WALL_Z - 3.2);
  moon.target.position.set(fcx + 0.7, 0, 0.6);
  moon.castShadow = true;
  const sm = quality > 0.6 ? 2048 : 1024;
  moon.shadow.mapSize.set(sm, sm);
  Object.assign(moon.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 0.5, far: 14 });
  moon.shadow.bias = -0.0004; moon.shadow.normalBias = 0.02; moon.shadow.radius = 4;
  room.add(moon, moon.target);

  // Plafonnier d'ambiance chaud, très doux, avec ombres de contact
  const key = new SpotLight("#ffcf9e", 9, 0, 0.9, 0.85, 2);
  key.position.set(1.8, 2.85, 0.4);
  key.target.position.set(1.9, 0.4, WALL_Z + 0.3);
  key.castShadow = true;
  key.shadow.mapSize.set(sm / 2, sm / 2);
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02; key.shadow.radius = 6;
  room.add(key, key.target);

  const hemi = new HemisphereLight("#3a4a78", "#2a1d14", 0.35);
  const ambient = new AmbientLight("#ffffff", 0.04);
  room.add(hemi, ambient);

  // Jour / nuit : la même pièce, deux lumières. Le jour, le soleil entre par la
  // fenêtre, les lampes s'éteignent presque.
  const moods = {
    night: { ceil: "#2b2622", sky: tx.night, sun: ["#9cb6ff", 2.4], key: 9, hemi: ["#3a4a78", "#2a1d14", 0.35], amb: 0.04, lamps: [5.5, 2.2], shade: 0.9, beam: ["#5b7bd6", 0.1] },
    day: { ceil: "#ddd3c4", sky: tx.day, sun: ["#fff0d8", 7.5], key: 3, hemi: ["#cfe0ff", "#8a6a4a", 1.6], amb: 0.35, lamps: [0.4, 0.25], shade: 0.12, beam: ["#fff2d6", 0.16] }
  };
  function setMood(name) {
    const m = moods[name];
    sky.material.map = m.sky; sky.material.needsUpdate = true;
    mats.ceiling.color.set(m.ceil);
    moon.color.set(m.sun[0]); moon.intensity = m.sun[1];
    key.intensity = m.key;
    hemi.color.set(m.hemi[0]); hemi.groundColor.set(m.hemi[1]); hemi.intensity = m.hemi[2];
    ambient.intensity = m.amb;
    floorLamp.userData.base = m.lamps[0]; floorLamp.intensity = m.lamps[0];
    tableLamp.intensity = m.lamps[1];
    mats.shade.emissiveIntensity = m.shade;
    beam.material.color.set(m.beam[0]); beam.material.opacity = m.beam[1];
  }

  // Lumière volt qui suit le pointeur (desktop)
  const pointer = new PointLight("#d9ff3d", 0, 2.6, 2);
  pointer.position.set(0, 1.2, 0);
  room.add(pointer);

  return {
    room, sampled, pointer, mats, bulbs, bulbMat, setMood,
    lamps: [floorLamp, tableLamp],
    targets,
    bounds: { xMin: -4.6, xMax: 4.6 }
  };
}
