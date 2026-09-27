// Le balayage. Deux fronts parcourent la pièce le long de l'axe X :
//  - uA dissout la matière (le mesh disparaît, le nuage de points prend le relais) ;
//  - uB la recompose (le mesh revient, les points s'éteignent).
// Une bande est « scannée » quand uB < x < uA. Les deux fronts partagent un
// bruit par voxel de 5,5 cm : les meshes et les points se découpent au même grain.
import { Color, Vector3 } from "three";

export const VOXEL = 18.0;   // voxels par mètre
export const JITTER = 0.35;  // profondeur du front irrégulier (m)

export const scanUniforms = {
  uA: { value: -99 },
  uB: { value: -99 },
  uTime: { value: 0 },
  uVolt: { value: new Color("#d9ff3d") },
  uFocus: { value: new Vector3(0, -99, 0) },
  uFocusAmt: { value: 0 }
};

const HASH = /* glsl */`
float fulmoHash(vec3 p){ p = floor(p * ${VOXEL.toFixed(1)}); return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
`;

// Injecte le balayage dans un matériau standard/physique existant.
export function patchMaterial(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uA: scanUniforms.uA, uB: scanUniforms.uB, uVolt: scanUniforms.uVolt
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <project_vertex>",
        "#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>",
        `#include <common>\nvarying vec3 vWPos;\nuniform float uA;\nuniform float uB;\nuniform vec3 uVolt;\n${HASH}`)
      .replace("#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        float fxj = vWPos.x + fulmoHash(vWPos) * ${JITTER.toFixed(2)};
        if (fxj < uA && fxj > uB) discard;`)
      .replace("#include <opaque_fragment>",
        `#include <opaque_fragment>
        float fea = (1.0 - smoothstep(0.0, 0.07, fxj - uA)) * step(uA, fxj);
        float feb = (1.0 - smoothstep(0.0, 0.07, uB - fxj)) * step(fxj, uB);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uVolt * 5.0, clamp(fea + feb, 0.0, 1.0) * 0.9);`);
  };
  material.customProgramCacheKey = () => "fulmo-scan";
  return material;
}
