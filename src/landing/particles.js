// Le nuage de points : ce que produit le scan 3D de Fulmo. Chaque point est
// échantillonné sur la surface d'un mesh de la pièce (position monde, normale,
// couleur), puis révélé par le balayage.
import {
  BufferGeometry, BufferAttribute, Points, ShaderMaterial, AdditiveBlending,
  Vector3, Color, Triangle
} from "three";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { scanUniforms, JITTER, VOXEL } from "./dissolve.js";

function worldArea(mesh) {
  const g = mesh.geometry, p = g.attributes.position, idx = g.index;
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), tri = new Triangle();
  const n = idx ? idx.count / 3 : p.count / 3;
  let area = 0;
  const step = Math.max(1, Math.floor(n / 400)); // estimation sur un sous-ensemble
  for (let i = 0; i < n; i += step) {
    const i0 = idx ? idx.getX(i * 3) : i * 3, i1 = idx ? idx.getX(i * 3 + 1) : i * 3 + 1, i2 = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
    a.fromBufferAttribute(p, i0).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(p, i1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(p, i2).applyMatrix4(mesh.matrixWorld);
    tri.set(a, b, c); area += tri.getArea() * step;
  }
  return area;
}

// Couleur moyenne d'une texture canvas (pour les surfaces texturées).
function meanColor(tex) {
  const img = tex && tex.image;
  if (!img || !img.getContext) return null;
  const c = document.createElement("canvas"); c.width = c.height = 8;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, 8, 8);
  const d = ctx.getImageData(0, 0, 8, 8).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const k = 1 / (255 * 64);
  return new Color().setRGB(r * k, g * k, b * k, "srgb");
}

export function buildParticles(sampled, total) {
  const entries = sampled.map((s) => {
    s.mesh.updateWorldMatrix(true, false);
    return { ...s, area: worldArea(s.mesh) };
  });
  const sum = entries.reduce((acc, e) => acc + e.area * e.weight, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3), rnd = new Float32Array(total * 4);
  const p = new Vector3(), n = new Vector3(), c = new Color(), base = new Color(), tint = new Color();
  const nm = new Vector3();
  let k = 0;

  for (const e of entries) {
    const count = Math.round(total * (e.area * e.weight) / sum);
    if (!count) continue;
    const mat = e.mesh.material;
    const hasVC = !!e.mesh.geometry.attributes.color && mat.vertexColors;
    base.copy(mat.color || new Color(1, 1, 1));
    const mc = meanColor(mat.map);
    if (mc) base.multiply(mc);
    const sampler = new MeshSurfaceSampler(e.mesh).build();
    for (let i = 0; i < count && k < total; i++, k++) {
      sampler.sample(p, n, c);
      p.applyMatrix4(e.mesh.matrixWorld);
      nm.copy(n).transformDirection(e.mesh.matrixWorld);
      pos.set([p.x, p.y, p.z], k * 3);
      nor.set([nm.x, nm.y, nm.z], k * 3);
      tint.copy(hasVC ? c : base);
      // on relève un peu les couleurs : un nuage de points lit sa propre lumière
      tint.multiplyScalar(1.5 + Math.random() * 0.9);
      tint.lerp(new Color(0.45, 0.5, 0.8), 0.14);
      tint.addScalar(0.015);
      col.set([tint.r, tint.g, tint.b], k * 3);
      rnd.set([Math.random(), Math.random(), Math.random(), Math.random()], k * 4);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos.subarray(0, k * 3), 3));
  geo.setAttribute("aNormal", new BufferAttribute(nor.subarray(0, k * 3), 3));
  geo.setAttribute("color", new BufferAttribute(col.subarray(0, k * 3), 3));
  geo.setAttribute("aRand", new BufferAttribute(rnd.subarray(0, k * 4), 4));

  const material = new ShaderMaterial({
    uniforms: {
      ...scanUniforms,
      uSize: { value: 30 },
      uPR: { value: 1 },
      uDrift: { value: 1 },
      uDay: { value: 0 }
    },
    vertexShader: /* glsl */`
      attribute vec3 aNormal; attribute vec4 aRand; attribute vec3 color;
      uniform float uA, uB, uTime, uSize, uPR, uDrift, uFocusAmt, uDay;
      uniform vec3 uFocus, uVolt;
      varying vec3 vColor; varying float vAlpha;
      float fulmoHash(vec3 p){ p = floor(p * ${VOXEL.toFixed(1)}); return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
      void main(){
        float xj = position.x + fulmoHash(position) * ${JITTER.toFixed(2)};
        float inside = step(uB, xj) * step(xj, uA);
        if (inside < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
        float behind = smoothstep(0.0, 1.4, uA - xj);
        float toReform = smoothstep(0.0, 1.1, xj - uB);
        float d = behind * toReform * uDrift;
        vec3 p = position;
        float ph = aRand.y * 6.2831;
        p += aNormal * (0.04 + 0.1 * aRand.z) * d;
        p += vec3(sin(uTime * 0.55 + ph + position.y * 2.1),
                  cos(uTime * 0.47 + aRand.z * 6.28 + position.x * 1.7),
                  sin(uTime * 0.39 + aRand.w * 6.28 + position.z * 2.3)) * 0.075 * d;
        p.y += d * (0.05 + 0.18 * aRand.x);
        float front = 1.0 - smoothstep(0.0, 0.16, uA - xj);
        float rear = 1.0 - smoothstep(0.0, 0.16, xj - uB);
        float edge = max(front, rear);
        float focus = uFocusAmt * (1.0 - smoothstep(0.08, 0.3, distance(position, uFocus)));
        vec3 base = mix(color, color * 0.32, uDay);
        vec3 hot = mix(uVolt * 2.4, vec3(0.31, 0.41, 0.03), uDay * (1.0 - edge));
        vColor = mix(base, hot, clamp(edge * 0.95 + focus, 0.0, 1.0));
        vAlpha = 0.85 * smoothstep(0.0, 0.04, uA - xj + 0.04) * (0.55 + 0.45 * aRand.w);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * uPR * (0.55 + aRand.w * 0.7) * (1.0 + edge * 1.2 + focus * 0.8) / max(-mv.z, 0.5);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha; uniform float uDay;
      void main(){
        vec2 q = gl_PointCoord - 0.5;
        float r = length(q);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.08, r) * vAlpha;
        gl_FragColor = uDay > 0.5 ? vec4(vColor, a) : vec4(vColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  });
  const points = new Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  return points;
}
