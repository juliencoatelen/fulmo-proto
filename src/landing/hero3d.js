// Scène du hero : la pièce, le balayage, le nuage, l'épingle.
// Chargé à part (import dynamique) : le texte du hero s'affiche sans l'attendre.
import {
  WebGLRenderer, Scene, PerspectiveCamera, Color, FogExp2, PMREMGenerator,
  ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace, Vector2, Vector3,
  Mesh, PlaneGeometry, ShaderMaterial, AdditiveBlending, DoubleSide
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { buildRoom } from "./room.js";
import { buildParticles } from "./particles.js";
import { scanUniforms } from "./dissolve.js";

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 4);
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, t) => a + (b - a) * t;

// Chronologie d'une boucle (secondes)
export const LOOP = 12;
const TL = {
  sweepA: [1.5, 4.3], drift: [2.6, 6.8], sweepB: [4.6, 7.2],
  focus: [3.0, 7.0], open: [7.0, 7.9], pin: 7.3, close: [11.1, 11.8]
};

export function createHero({ canvas, onPin, onPhase, reduced, coarse, lowPower }) {
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", alpha: false, stencil: false });
  const maxDPR = coarse ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDPR));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  scene.background = new Color("#07070a");
  scene.fog = new FogExp2("#07070a", 0.035);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.16;

  const camera = new PerspectiveCamera(40, 1, 0.1, 40);
  const quality = lowPower || coarse ? 0.5 : 1;
  const world = buildRoom(scene, { quality });
  scene.updateMatrixWorld(true);

  const points = buildParticles(world.sampled, coarse ? 38000 : lowPower ? 56000 : 110000);
  scene.add(points);

  // Plans laser : une lame volt très fine pour chaque front
  const laserMat = new ShaderMaterial({
    uniforms: { uTime: scanUniforms.uTime, uVolt: scanUniforms.uVolt, uOpacity: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `varying vec2 vUv; uniform float uTime, uOpacity; uniform vec3 uVolt;
      void main(){
        float lines = 0.5 + 0.5 * sin(vUv.y * 180.0 - uTime * 6.0);
        float fade = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.8, vUv.x) * smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.9, vUv.y);
        float a = (0.05 + 0.05 * lines) * fade * uOpacity;
        gl_FragColor = vec4(uVolt * 1.6 * a, a);
      }`,
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide
  });
  const laserGeo = new PlaneGeometry(5.8, 2.9);
  const laserA = new Mesh(laserGeo, laserMat); const laserB = new Mesh(laserGeo, laserMat.clone());
  laserB.material.uniforms.uTime = scanUniforms.uTime; laserB.material.uniforms.uVolt = scanUniforms.uVolt;
  for (const l of [laserA, laserB]) { l.rotation.y = Math.PI / 2; l.position.set(-99, 1.45, 0.5); l.renderOrder = 3; scene.add(l); }

  // Post-traitement : seul le volt (et les abat-jour) dépassent le seuil de bloom
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(256, 256), 0.5, 0.42, 0.95);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ─── Cadrage selon le format ─────────────────────────────────────── */
  const frame = { pos: new Vector3(), target: new Vector3(), fov: 40, shiftY: 0 };
  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    const aspect = w / h;
    camera.aspect = aspect;
    // 0 = portrait (téléphone), 1 = paysage large
    const k = clamp01((aspect - 0.55) / (1.6 - 0.55));
    frame.pos.set(lerp(2.35, 0.1, k), lerp(1.95, 1.72, k), lerp(4.6, 5.7, k));
    frame.target.set(lerp(2.2, 0.55, k), lerp(0.85, 1.12, k), -1.6);
    frame.fov = lerp(62, 42, k);
    camera.fov = frame.fov;
    // portrait : la scène vit dans la moitié haute, le texte en bas
    frame.shiftY = lerp(0.2, 0.0, k);
    // paysage : la pièce glisse à droite, le texte garde la gauche
    frame.shiftX = aspect > 1.2 ? -lerp(0, 0.1, clamp01((aspect - 1.2) / 0.5)) : 0;
    if (frame.shiftY > 0.001 || frame.shiftX < -0.001) camera.setViewOffset(w, h, w * frame.shiftX, h * frame.shiftY, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    points.material.uniforms.uPR.value = renderer.getPixelRatio() * (h / 900);
    if (!running) renderOnce();
  }

  /* ─── Entrées : pointeur, gyroscope, scroll ───────────────────────── */
  const pointer = { x: 0, y: 0, sx: 0, sy: 0, active: false };
  const gyro = { x: 0, y: 0 };
  let scroll = 0, scrollS = 0;
  function setPointer(nx, ny) { pointer.x = nx; pointer.y = ny; pointer.active = true; }
  function setGyro(gx, gy) { gyro.x = gx; gyro.y = gy; }
  function setScroll(v) { scroll = clamp01(v); if (!running) renderOnce(); }

  /* ─── Objets cherchés ──────────────────────────────────────────────── */
  const order = ["passeport", "guirlande", "chargeur"];
  let cycle = 0;
  const proj = new Vector3();

  function applyTarget(key, openT, pulse, alive) {
    for (const k of order) {
      const tg = world.targets[k];
      const on = k === key;
      const o = on ? openT : 0;
      tg.group.position.copy(tg.open).multiplyScalar(easeOut(o));
      tg.mat.emissiveIntensity = on ? pulse : 0;
      if (tg.bulbs) world.bulbMat.color.setRGB(1, 0.8, 0.55).multiplyScalar(on && alive ? 1.2 + pulse * 1.4 : 0.35);
    }
  }

  function project(v) {
    proj.copy(v).project(camera);
    return { x: (proj.x * 0.5 + 0.5) * 100, y: (-proj.y * 0.5 + 0.5) * 100, visible: proj.z < 1 };
  }

  /* ─── Boucle ───────────────────────────────────────────────────────── */
  let last = 0;
  let running = false, raf = 0, elapsed = 0, lastPhase = "";
  const xMin = world.bounds.xMin - 0.4, xMax = world.bounds.xMax + 0.4;
  const orbit = { t: 0 };

  function update(dt) {
    const t = elapsed % LOOP;
    const loopIndex = Math.floor(elapsed / LOOP);
    if (loopIndex !== cycle) cycle = loopIndex;
    const key = order[cycle % order.length];
    const tg = world.targets[key];

    // Fronts du balayage
    let a = lerp(xMin, xMax, easeInOut(seg(t, ...TL.sweepA)));
    let b = lerp(xMin, xMax, easeInOut(seg(t, ...TL.sweepB)));
    if (t < TL.sweepA[0]) { a = b = xMin - 1; }
    if (t > TL.sweepB[1]) { a = b = xMin - 1; }
    // Le scroll dissout la pièce en nuage à mesure qu'on quitte le hero
    scrollS += (scroll - scrollS) * Math.min(1, dt * 6);
    const s = scrollS;
    if (s > 0.001) {
      const sa = lerp(xMin, xMax, clamp01(s * 1.5));
      a = Math.max(a, sa);
      b = lerp(b, xMin - 1, clamp01(s * 5));
    }
    scanUniforms.uA.value = a; scanUniforms.uB.value = b;
    const drift = Math.sin(Math.PI * seg(t, ...TL.drift));
    points.material.uniforms.uDrift.value = 0.6 + drift * 0.8 + s * 2.2;

    // Point focal dans le nuage
    scanUniforms.uFocus.value.copy(tg.focus);
    scanUniforms.uFocusAmt.value = Math.sin(Math.PI * seg(t, ...TL.focus)) * 1.0;

    // Lasers
    const showA = a > xMin && a < xMax, showB = b > xMin && b < xMax;
    laserA.position.x = a + 0.15; laserB.position.x = b + 0.15;
    laserA.material.uniforms.uOpacity.value = showA ? 1 : 0;
    laserB.material.uniforms.uOpacity.value = showB ? 0.7 : 0;
    laserA.visible = showA; laserB.visible = showB;

    // Tiroir / bac / boîte qui s'ouvre, pulsation volt, épingle
    const openT = seg(t, ...TL.open) * (1 - seg(t, ...TL.close));
    const pulse = openT > 0 ? (0.04 + 0.2 * (0.5 + 0.5 * Math.sin((t - TL.open[0]) * 4.2))) * openT : 0;
    applyTarget(key, openT, pulse, true);
    const pinOn = t > TL.pin && t < TL.close[0] && s < 0.35;

    // Caméra : parallaxe souris (desktop) ou orbite douce (tactile)
    pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 3.2);
    pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 3.2);
    orbit.t += dt;
    let ox, oy;
    if (coarse) { ox = Math.sin(orbit.t * 0.18) * 0.32 + gyro.x * 0.4; oy = Math.sin(orbit.t * 0.13) * 0.06 + gyro.y * 0.15; }
    else { ox = pointer.sx * 0.55; oy = pointer.sy * 0.22; }
    camera.position.set(frame.pos.x + ox, frame.pos.y + oy + s * 0.5, frame.pos.z - s * 1.4);
    camera.lookAt(frame.target.x + ox * 0.25, frame.target.y + s * 0.2, frame.target.z);

    // Lumière volt sous le pointeur
    if (!coarse && pointer.active) {
      world.pointer.intensity += (1.3 - world.pointer.intensity) * Math.min(1, dt * 3);
      world.pointer.position.set(frame.target.x + pointer.sx * 3.6, 1.25 - pointer.sy * 1.1, -0.9);
    }
    // Lampes : légère respiration du filament
    world.lamps[0].intensity = 5.5 + Math.sin(elapsed * 1.7) * 0.08;

    scanUniforms.uTime.value = elapsed;

    // Épingle HTML ancrée en 3D
    camera.updateMatrixWorld();
    const pp = project(tg.anchor);
    onPin && onPin({ key, visible: pinOn && pp.visible, x: pp.x, y: pp.y });

    let phase = "idle";
    if (t < TL.sweepA[0]) phase = "type";
    else if (t < TL.sweepB[1]) phase = "scan";
    else if (t < TL.close[0]) phase = "found";
    else phase = "reset";
    const ph = phase + ":" + key;
    if (ph !== lastPhase) { lastPhase = ph; onPhase && onPhase({ phase, key, t }); }
  }

  function renderOnce() { composer.render(); }

  function frameLoop(ts) {
    raf = requestAnimationFrame(frameLoop);
    const dt = last ? Math.min(Math.max((ts - last) / 1000, 0), 0.05) : 0.016;
    last = ts;
    elapsed += dt;
    update(dt);
    composer.render();
  }

  function start() {
    if (running || reduced) return;
    running = true; last = 0; raf = requestAnimationFrame(frameLoop);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  // Scène composée et immobile : tiroir ouvert, épingle posée
  function still(key = "passeport") {
    scanUniforms.uA.value = scanUniforms.uB.value = xMin - 1;
    scanUniforms.uFocusAmt.value = 0;
    laserA.visible = laserB.visible = false;
    applyTarget(key, 1, 0.16, true);
    camera.position.copy(frame.pos); camera.lookAt(frame.target);
    camera.updateMatrixWorld();
    composer.render();
    const pp = project(world.targets[key].anchor);
    onPin && onPin({ key, visible: pp.visible, x: pp.x, y: pp.y });
  }

  // Positionne la boucle à un instant précis (captures, réduction de mouvement)
  function seek(sec) { elapsed = sec; update(0.016); composer.render(); }

  resize();
  // Compile les shaders avant le premier fondu pour éviter un accroc
  renderer.compile(scene, camera);

  return { start, stop, resize, setPointer, setGyro, setScroll, still, seek, renderer, get running() { return running; } };
}
