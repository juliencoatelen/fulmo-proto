/* ═══ pano-capture.js ═══ */
/*
  FULMO — capture panoramique sphérique guidée (iOS Safari compatible).

  Pourquoi ce module existe : sur iPhone, Safari n'expose ni WebXR AR ni le
  LiDAR. Le seul relevé « 3D » réalisable depuis une page web est donc une
  panoramique sphérique guidée — getUserMedia pour les pixels, DeviceOrientation
  pour savoir où pointe le téléphone — accumulée dans une équirectangulaire.
  C'est exactement le niveau « panorama » de Matterport / Zillow 3D Home.

  Le module ne fait QUE la capture : il rend une équirectangulaire finie.
  L'affichage est le travail d'un autre module.

  Deux chemins d'entrée :
   - réel      : caméra + IMU ;
   - injecté   : opts.source, qui fournit {image, hfov, quat}. Ce chemin existe
                 pour que la qualité du stitching soit mesurable en CI, sans
                 téléphone — sinon on ne saurait jamais si une régression a
                 dégradé le rendu.
*/
(function () {
  "use strict";

  var PI = Math.PI;
  var TAU = PI * 2;
  // Largeur de la zone de fondu, en fraction de l'image, sur CHAQUE bord.
  //
  // Une version précédente avait porté cette valeur à 0.5, sur l'idée que le
  // plateau central à poids plein faisait moyenner deux prises voisines à
  // 50/50 et fabriquait ainsi le dédoublement de grille mesuré (~5 px). Le
  // raisonnement était séduisant. L'A/B l'a démenti.
  //
  // Mesuré à jeu de poses IDENTIQUE (tools/crit-feather-ab.mjs), seul FEATHER
  // variant — la comparaison qui avait conclu à un gain changeait en réalité
  // deux choses à la fois, le fondu ET les anneaux de prise :
  //
  //   FEATHER   ratio de couture   PSNR global   pire bande
  //   0.18      0.96               30.03 dB      —
  //   0.50      0.98               29.62 dB      −1.11 dB à [15°,30°]
  //
  // Le fondu élargi ne corrige donc rien sur la couture (il la dégrade même
  // très légèrement) et coûte de la fidélité sur les DOUZE bandes de latitude.
  // Et, mesuré dans les conditions exactes de la revue indépendante, le
  // dédoublement de grille reste à 4,3 % à [45°,60°] et 5,0 % à [60°,75°],
  // contre 4,31 % et 4,42 % avant le changement : inchangé.
  //
  // La cause du dédoublement n'est donc pas le plateau de poids. C'est
  // l'absence de recalage des images entre elles : seule la pose IMU décide
  // où une prise atterrit, et deux prises voisines sont fusionnées sans
  // jamais être mises en correspondance visuellement. Aucun réglage du fondu
  // ne répare ça — il faut une corrélation de phase ou un flux optique avant
  // accumulation. C'est écrit ici pour que personne ne retente le raccourci.
  var FEATHER = 0.18;

  // En dessous de ce poids cumulé on considère le texel non couvert. Assez bas
  // pour ne pas trouer les bords de couverture, assez haut pour que la division
  // par le poids ne fasse pas exploser le bruit.
  var WEIGHT_EPS = 0.02;

  // Bornes du gain d'égalisation d'exposition. L'auto-exposition d'un iPhone
  // bouge de quelques dixièmes d'IL entre deux images ; au-delà de ces bornes,
  // c'est que l'estimation est fausse (recouvrement trop petit, sujet mobile)
  // et il vaut mieux ne rien corriger que d'injecter une bande lumineuse.
  var GAIN_MIN = 0.6;
  var GAIN_MAX = 1.7;

  // Grille de couverture exposée à l'appelant. 64×32 = 2048 cellules, soit une
  // barre de progression qui bouge visiblement à chaque mouvement du téléphone.
  var COV_W = 64;
  var COV_H = 32;

  // Cible de mesure d'exposition. Minuscule : elle est relue par readPixels à
  // chaque image, et readPixels synchronise le GPU. 48×32 suffit largement pour
  // une moyenne.
  var MEAS_W = 48;
  var MEAS_H = 32;

  // FOV horizontal supposé de la caméra arrière d'un iPhone (grand-angle ~26 mm
  // équivalent). getUserMedia ne publie AUCUNE information de champ : c'est une
  // estimation, et une erreur ici se voit sous forme de dédoublement.
  var DEFAULT_HFOV = 1.152; // ~66°

  /* ------------------------------------------------------------------ */
  /* Quaternions (x, y, z, w) — repère monde Y haut, caméra regardant -Z */
  /* ------------------------------------------------------------------ */

  function quatMul(a, b) {
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    var bx = b[0], by = b[1], bz = b[2], bw = b[3];
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz
    ];
  }

  function quatNorm(q) {
    var n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (n === 0) return [0, 0, 0, 1];
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }

  // v' = q * v * conj(q) : passe du repère caméra au repère monde.
  function rotate(q, v) {
    var ux = q[0], uy = q[1], uz = q[2], s = q[3];
    var d = ux * v[0] + uy * v[1] + uz * v[2];
    var k = s * s - (ux * ux + uy * uy + uz * uz);
    var cx = uy * v[2] - uz * v[1];
    var cy = uz * v[0] - ux * v[2];
    var cz = ux * v[1] - uy * v[0];
    return [
      2 * d * ux + k * v[0] + 2 * s * cx,
      2 * d * uy + k * v[1] + 2 * s * cy,
      2 * d * uz + k * v[2] + 2 * s * cz
    ];
  }

  // Monde -> caméra.
  function rotateInv(q, v) {
    return rotate([-q[0], -q[1], -q[2], q[3]], v);
  }

  function quatAngle(a, b) {
    var d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    if (d > 1) d = 1;
    return 2 * Math.acos(d);
  }

  // Recette W3C / three.js DeviceOrientationControls.
  // alpha/beta/gamma décrivent l'écran ; les deux corrections qui suivent sont
  // indispensables et non devinables :
  //  - q1 = -90° autour de X, parce que l'IMU décrit un téléphone à plat alors
  //    qu'on le tient dressé, l'objectif vers l'avant ;
  //  - -screenAngle autour de Z, parce que le flux vidéo arrive déjà redressé
  //    par iOS : sans ça le panorama bascule quand l'utilisateur tourne l'écran.
  function quatFromDeviceOrientation(alphaDeg, betaDeg, gammaDeg, screenAngleDeg) {
    var a = (alphaDeg || 0) * PI / 180;
    var b = (betaDeg || 0) * PI / 180;
    var g = (gammaDeg || 0) * PI / 180;
    var o = (screenAngleDeg || 0) * PI / 180;

    // Euler YXZ (beta, alpha, -gamma) -> quaternion, comme la spec le prescrit.
    var c1 = Math.cos(b / 2), s1 = Math.sin(b / 2);
    var c2 = Math.cos(a / 2), s2 = Math.sin(a / 2);
    var c3 = Math.cos(-g / 2), s3 = Math.sin(-g / 2);
    var q = [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 - s1 * s2 * c3,
      c1 * c2 * c3 + s1 * s2 * s3
    ];
    q = quatMul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    q = quatMul(q, [0, 0, Math.sin(-o / 2), Math.cos(-o / 2)]);
    return quatNorm(q);
  }

  /* ------------------------------------------------------------------ */
  /* WebGL                                                               */
  /* ------------------------------------------------------------------ */

  var VS_RECT = [
    "#version 300 es",
    "in vec2 aPos;",          // quad unitaire 0..1
    "uniform vec4 uRect;",    // (x0,y0,x1,y1) en coordonnées équirect normalisées
    "out vec2 vUV;",
    "void main() {",
    "  vUV = mix(uRect.xy, uRect.zw, aPos);",
    "  gl_Position = vec4(vUV * 2.0 - 1.0, 0.0, 1.0);",
    "}"
  ].join("\n");

  // Quad plein cadre, mais vUV reste libre : sert aux passes « normaliser » et
  // « mesurer » qui n'ont pas de découpe.
  var VS_FULL = [
    "#version 300 es",
    "in vec2 aPos;",
    "out vec2 vUV;",
    "void main() {",
    "  vUV = aPos;",
    "  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);",
    "}"
  ].join("\n");

  var GLSL_COMMON = [
    "precision highp float;",
    "const float PIf = 3.14159265358979;",
    "const float TAUf = 6.28318530717959;",
    // Rotation par quaternion (u = q.xyz, s = q.w).
    "vec3 qrot(vec4 q, vec3 v) {",
    "  vec3 u = q.xyz; float s = q.w;",
    "  return 2.0 * dot(u, v) * u + (s * s - dot(u, u)) * v + 2.0 * s * cross(u, v);",
    "}",
    "vec3 qrotInv(vec4 q, vec3 v) { return qrot(vec4(-q.xyz, q.w), v); }",
    // gamma 2.2 plutôt que la vraie courbe sRGB : les deux fonctions sont
    // exactement inverses l'une de l'autre, donc le trajet aller-retour est
    // neutre, et c'est ce qui compte ici.
    "vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }",
    "vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }",
    "float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }"
  ].join("\n");

  var FS_ACCUM = [
    "#version 300 es",
    GLSL_COMMON,
    "in vec2 vUV;",
    "uniform sampler2D uCam;",
    "uniform vec4 uQuat;",
    "uniform vec2 uTan;",     // tan(hfov/2), tan(vfov/2)
    "uniform float uGain;",
    "uniform float uFeather;",
    "out vec4 oCol;",
    // Fondu en cosinus : dérivée nulle aux deux extrémités, donc pas de cassure
    // de pente visible là où deux images se recouvrent.
    "float fade(float t, float f) {",
    "  float d = clamp(min(t, 1.0 - t) / f, 0.0, 1.0);",
    "  return 0.5 - 0.5 * cos(PIf * d);",
    "}",
    "void main() {",
    "  float lon = (vUV.x - 0.5) * TAUf;",
    "  float lat = (vUV.y - 0.5) * PIf;",
    "  float cl = cos(lat);",
    "  vec3 dir = vec3(sin(lon) * cl, sin(lat), -cos(lon) * cl);",
    "  vec3 c = qrotInv(uQuat, dir);",
    "  if (c.z > -1e-5) discard;",                  // derrière la caméra
    "  vec2 ndc = vec2(c.x, c.y) / (-c.z) / uTan;",
    "  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) discard;",
    "  vec2 uv = ndc * 0.5 + 0.5;",
    "  float w = fade(uv.x, uFeather) * fade(uv.y, uFeather);",
    "  if (w <= 0.0) discard;",
    // Accumulation en lumière linéaire : une moyenne pondérée faite sur des
    // valeurs sRGB assombrit les zones de recouvrement (halo sombre le long
    // des coutures).
    "  vec3 col = toLin(texture(uCam, uv).rgb) * uGain;",
    "  oCol = vec4(col * w, w);",
    "}"
  ].join("\n");

  var FS_MEASURE = [
    "#version 300 es",
    GLSL_COMMON,
    "in vec2 vUV;",
    "uniform sampler2D uCam;",
    "uniform sampler2D uAcc;",
    "uniform vec4 uQuat;",
    "uniform vec2 uTan;",
    "uniform float uEps;",
    "out vec4 oCol;",
    "void main() {",
    // On reste dans les 80 % centraux : les bords de l'image sont vignetés et
    // fausseraient la mesure de luminance.
    "  vec2 ndc = (vUV * 2.0 - 1.0) * 0.8;",
    "  vec3 dir = qrot(uQuat, normalize(vec3(ndc * uTan, -1.0)));",
    "  float lat = asin(clamp(dir.y, -1.0, 1.0));",
    "  float lon = atan(dir.x, -dir.z);",
    "  vec4 a = texture(uAcc, vec2(lon / TAUf + 0.5, lat / PIf + 0.5));",
    "  float ok = step(uEps, a.a);",
    "  float la = lum(a.rgb / max(a.a, 1e-6));",
    "  float li = lum(toLin(texture(uCam, (vUV - 0.5) * 0.8 + 0.5).rgb));",
    "  oCol = vec4(clamp(la, 0.0, 1.0) * ok, clamp(li, 0.0, 1.0) * ok, ok, 1.0);",
    "}"
  ].join("\n");

  var FS_NORMALIZE = [
    "#version 300 es",
    GLSL_COMMON,
    "in vec2 vUV;",
    "uniform sampler2D uAcc;",
    "uniform float uEps;",
    "out vec4 oCol;",
    "void main() {",
    "  vec4 a = texture(uAcc, vUV);",
    "  float cov = step(uEps, a.a);",
    "  vec3 c = toSrgb(clamp(a.rgb / max(a.a, 1e-6), 0.0, 1.0));",
    // Sortie prémultipliée : le canvas WebGL est créé en premultipliedAlpha,
    // c'est ce qui permet un drawImage propre vers le canvas 2D final.
    "  oCol = vec4(c * cov, cov);",
    "}"
  ].join("\n");

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(s) + "\n" + src);
    }
    return s;
  }

  function program(gl, vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("link: " + gl.getProgramInfoLog(p));
    }
    var u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p: p, u: u };
  }

  /* ------------------------------------------------------------------ */
  /* Empreinte équirectangulaire d'une image (les « ciseaux »)           */
  /* ------------------------------------------------------------------ */

  // Renvoie 1 ou 2 rectangles normalisés couvrant exactement la projection de
  // l'image courante. Redessiner les 4096×2048 à chaque image coûte ~8 M
  // fragments : injouable sur un iPhone à 20 images/s, d'où cette découpe.
  // Deux rectangles sont nécessaires quand l'image chevauche le méridien de
  // bouclage (lon = ±180°).
  function footprint(quat, tanH, tanV, texW, texH) {
    var lons = [];
    var latMin = 1e9, latMax = -1e9;
    var N = 24;
    var i, k, t, ndc, dir;

    // Échantillonnage du BORD de l'image, pas seulement des coins : l'extremum
    // de latitude tombe souvent au milieu d'une arête quand on vise en biais.
    for (k = 0; k < 4; k++) {
      for (i = 0; i <= N; i++) {
        t = -1 + 2 * i / N;
        ndc = k === 0 ? [t, -1] : k === 1 ? [t, 1] : k === 2 ? [-1, t] : [1, t];
        dir = rotate(quat, [ndc[0] * tanH, ndc[1] * tanV, -1]);
        var n = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
        var lat = Math.asin(Math.max(-1, Math.min(1, dir[1] / n)));
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
        lons.push(Math.atan2(dir[0], -dir[2]));
      }
    }

    // Un pôle dans le champ fait exploser la longitude : tout le tour est
    // concerné, et la latitude va jusqu'au bout.
    var poleN = insideFrustum(quat, [0, 1, 0], tanH, tanV);
    var poleS = insideFrustum(quat, [0, -1, 0], tanH, tanV);
    if (poleN) latMax = PI / 2;
    if (poleS) latMin = -PI / 2;

    var mLat = 2 * PI / texH; // marge de deux texels : les arrondis ne doivent
    var mLon = 2 * TAU / texW; // pas ronger un liseré au bord de l'empreinte
    var y0 = clamp01((latMin - mLat) / PI + 0.5);
    var y1 = clamp01((latMax + mLat) / PI + 0.5);

    if (poleN || poleS) return [[0, y0, 1, y1]];

    // Arc de longitude = complémentaire du plus grand trou dans les
    // échantillons. Raisonner sur le trou évite tout cas particulier de signe.
    lons.sort(function (a, b) { return a - b; });
    var gapAt = 0, gap = lons[0] + TAU - lons[lons.length - 1];
    for (i = 1; i < lons.length; i++) {
      var g = lons[i] - lons[i - 1];
      if (g > gap) { gap = g; gapAt = i; }
    }
    var lonStart = lons[gapAt === 0 ? 0 : gapAt];
    var lonEnd = lons[gapAt === 0 ? lons.length - 1 : gapAt - 1];
    if (lonEnd < lonStart) lonEnd += TAU;

    var x0 = lonStart / TAU + 0.5 - mLon;
    var x1 = lonEnd / TAU + 0.5 + mLon;
    if (x1 - x0 >= 1) return [[0, y0, 1, y1]];
    if (x0 < 0) return [[x0 + 1, y0, 1, y1], [0, y0, x1, y1]];
    if (x1 > 1) return [[x0, y0, 1, y1], [0, y0, x1 - 1, y1]];
    return [[x0, y0, x1, y1]];
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function insideFrustum(quat, dir, tanH, tanV, margin) {
    var c = rotateInv(quat, dir);
    if (c[2] >= -1e-6) return false;
    var m = margin === undefined ? 1 : margin;
    return Math.abs(c[0] / -c[2] / tanH) <= m && Math.abs(c[1] / -c[2] / tanV) <= m;
  }

  /* ------------------------------------------------------------------ */
  /* Couverture                                                          */
  /* ------------------------------------------------------------------ */

  function markCoverage(cells, quat, tanH, tanV) {
    var gx, gy, lon, lat, cl, hit = 0;
    for (gy = 0; gy < COV_H; gy++) {
      lat = ((gy + 0.5) / COV_H - 0.5) * PI;
      cl = Math.cos(lat);
      for (gx = 0; gx < COV_W; gx++) {
        var idx = gy * COV_W + gx;
        if (cells[idx]) { hit++; continue; }
        lon = ((gx + 0.5) / COV_W - 0.5) * TAU;
        // Marge 0.9 : on ne compte pas comme « couvert » un liseré qui n'aura
        // reçu qu'un poids de fondu quasi nul.
        if (insideFrustum(quat, [Math.sin(lon) * cl, Math.sin(lat), -Math.cos(lon) * cl], tanH, tanV, 0.9)) {
          cells[idx] = 1;
          hit++;
        }
      }
    }
    return hit / (COV_W * COV_H);
  }

  /* ------------------------------------------------------------------ */
  /* Contexte de rendu                                                   */
  /* ------------------------------------------------------------------ */

  function createRig(wantW, wantH) {
    var cv = document.createElement("canvas");
    var gl = cv.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance"
    });
    if (!gl) return null;

    // Repli demandé : certains appareils plafonnent à 2048 (ou moins). Mieux
    // vaut un panorama moitié moins défini qu'un échec de capture.
    var maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    var w = wantW, h = wantH;
    while (w > maxTex && w > 512) { w >>= 1; h >>= 1; }

    cv.width = w;
    cv.height = h;

    // RGBA16F d'abord : le mélange additif y est accepté partout où le rendu
    // flottant l'est, alors que RGBA32F réclame en plus EXT_float_blend, absent
    // de plusieurs iPhone. La précision d'un demi-flottant est largement
    // suffisante pour une somme d'une dizaine de contributions.
    gl.getExtension("EXT_color_buffer_half_float");
    var hasFloat = !!gl.getExtension("EXT_color_buffer_float") ||
      !!gl.getExtension("EXT_color_buffer_half_float");

    var rig = {
      canvas: cv, gl: gl, w: w, h: h,
      float: hasFloat,
      // Sans cible flottante on retombe sur RGBA8, qui sature à 1.0 : on divise
      // alors les poids pour que la somme reste dans la plage. Le rendu est
      // dégradé (bandes de quantification) mais la capture aboutit.
      weightScale: hasFloat ? 1 : 1 / 8
    };

    var fmt = hasFloat ? gl.RGBA16F : gl.RGBA8;
    var type = hasFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    rig.accTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rig.accTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // REPEAT en longitude : l'échantillonnage de l'accumulateur près du
    // méridien de bouclage doit revenir de l'autre côté, sinon la mesure
    // d'exposition y lit du vide.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    rig.accFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rig.accFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rig.accTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      if (!hasFloat) return null;
      // La cible flottante annoncée n'est pas réellement rendable : on refait
      // tout en RGBA8 plutôt que d'abandonner.
      gl.deleteTexture(rig.accTex);
      gl.deleteFramebuffer(rig.accFbo);
      return createRigU8(rig);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    finishRig(rig);
    return rig;
  }

  function createRigU8(rig) {
    var gl = rig.gl;
    rig.float = false;
    rig.weightScale = 1 / 8;
    rig.accTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rig.accTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, rig.w, rig.h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    rig.accFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rig.accFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rig.accTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    finishRig(rig);
    return rig;
  }

  function finishRig(rig) {
    var gl = rig.gl;

    rig.vao = gl.createVertexArray();
    gl.bindVertexArray(rig.vao);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    rig.progAccum = program(gl, VS_RECT, FS_ACCUM);
    rig.progMeasure = program(gl, VS_FULL, FS_MEASURE);
    rig.progNorm = program(gl, VS_FULL, FS_NORMALIZE);

    rig.camTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rig.camTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    rig.measTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rig.measTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, MEAS_W, MEAS_H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    rig.measFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rig.measFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rig.measTex, 0);
    rig.measBuf = new Uint8Array(MEAS_W * MEAS_H * 4);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  function destroyRig(rig) {
    var gl = rig.gl;
    gl.deleteTexture(rig.accTex);
    gl.deleteTexture(rig.camTex);
    gl.deleteTexture(rig.measTex);
    gl.deleteFramebuffer(rig.accFbo);
    gl.deleteFramebuffer(rig.measFbo);
    var lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
  }

  function uploadCam(rig, image) {
    var gl = rig.gl;
    gl.bindTexture(gl.TEXTURE_2D, rig.camTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  // Gain à appliquer à l'image entrante pour qu'elle s'aligne sur ce qui est
  // déjà accumulé. Sans cela, l'auto-exposition de l'iPhone zèbre le panorama
  // de bandes claires et sombres — le défaut n°1 des panoramas faits main.
  function measureGain(rig, quat, tanH, tanV) {
    var gl = rig.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rig.measFbo);
    gl.viewport(0, 0, MEAS_W, MEAS_H);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    var pr = rig.progMeasure;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rig.camTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, rig.accTex);
    gl.uniform1i(pr.u.uCam, 0);
    gl.uniform1i(pr.u.uAcc, 1);
    gl.uniform4fv(pr.u.uQuat, quat);
    gl.uniform2f(pr.u.uTan, tanH, tanV);
    gl.uniform1f(pr.u.uEps, WEIGHT_EPS * rig.weightScale);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.readPixels(0, 0, MEAS_W, MEAS_H, gl.RGBA, gl.UNSIGNED_BYTE, rig.measBuf);
    var b = rig.measBuf, sa = 0, si = 0, n = 0, i;
    for (i = 0; i < b.length; i += 4) {
      if (b[i + 2] > 127) { sa += b[i]; si += b[i + 1]; n++; }
    }
    // Recouvrement trop maigre : l'estimation serait dominée par le bruit, on
    // préfère ne pas corriger.
    if (n < MEAS_W * MEAS_H * 0.12 || si < 1) return 1;
    var g = sa / si;
    if (!isFinite(g)) return 1;
    return g < GAIN_MIN ? GAIN_MIN : g > GAIN_MAX ? GAIN_MAX : g;
  }

  function accumulate(rig, quat, tanH, tanV, gain) {
    var gl = rig.gl;
    var rects = footprint(quat, tanH, tanV, rig.w, rig.h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, rig.accFbo);
    gl.viewport(0, 0, rig.w, rig.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.SCISSOR_TEST);

    var pr = rig.progAccum;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rig.camTex);
    gl.uniform1i(pr.u.uCam, 0);
    gl.uniform4fv(pr.u.uQuat, quat);
    gl.uniform2f(pr.u.uTan, tanH, tanV);
    gl.uniform1f(pr.u.uGain, gain);
    gl.uniform1f(pr.u.uFeather, FEATHER);

    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r[2] <= r[0] || r[3] <= r[1]) continue;
      var px = Math.floor(r[0] * rig.w), py = Math.floor(r[1] * rig.h);
      var pw = Math.ceil(r[2] * rig.w) - px, ph = Math.ceil(r[3] * rig.h) - py;
      gl.scissor(px, py, pw, ph);
      gl.uniform4f(pr.u.uRect, r[0], r[1], r[2], r[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    return rects;
  }

  function resolveEquirect(rig) {
    var gl = rig.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, rig.w, rig.h);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    var pr = rig.progNorm;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rig.accTex);
    gl.uniform1i(pr.u.uAcc, 0);
    gl.uniform1f(pr.u.uEps, WEIGHT_EPS * rig.weightScale);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();

    // Recopie dans un canvas 2D : le consommateur (visionneuse, envoi serveur)
    // n'a alors ni contexte WebGL à gérer ni perte de contexte à craindre.
    var out = document.createElement("canvas");
    out.width = rig.w;
    out.height = rig.h;
    out.getContext("2d").drawImage(rig.canvas, 0, 0);
    return out;
  }

  function encode(canvas) {
    return new Promise(function (resolve) {
      var done = false;
      function fallback() {
        canvas.toBlob(function (b) { resolve(b); }, "image/jpeg", 0.92);
      }
      try {
        canvas.toBlob(function (b) {
          if (done) return;
          done = true;
          // Safari a longtemps ignoré le type demandé et renvoyé du PNG : on
          // vérifie ce qu'on a réellement obtenu avant de se rabattre.
          if (b && b.type === "image/webp") resolve(b); else fallback();
        }, "image/webp", 0.92);
      } catch (e) {
        fallback();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Support                                                             */
  /* ------------------------------------------------------------------ */

  function support() {
    return new Promise(function (resolve) {
      if (typeof window === "undefined" || !window.isSecureContext) return resolve("insecure");

      var probe = document.createElement("canvas").getContext("webgl2");
      // Pas de valeur dédiée dans le contrat : sans WebGL2 la capture ne peut
      // simplement pas démarrer, on le signale comme « blocked ».
      if (!probe) return resolve("blocked");

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return resolve("no-camera");
      if (!window.DeviceOrientationEvent) return resolve("no-orientation");

      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "camera" }).then(function (st) {
          resolve(st.state === "denied" ? "blocked" : "ready");
        }, function () { resolve("ready"); });
      } else {
        resolve("ready");
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Capture                                                             */
  /* ------------------------------------------------------------------ */

  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
  }

  function imageSize(img) {
    return [img.videoWidth || img.width, img.videoHeight || img.height];
  }

  function start(opts) {
    opts = opts || {};
    var size = opts.size || { w: 4096, h: 2048 };
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

    var rig = createRig(size.w | 0 || 4096, size.h | 0 || 2048);
    if (!rig) return Promise.resolve(null);

    var cells = new Uint8Array(COV_W * COV_H);
    var state = { frames: 0, coverage: 0, stop: false, cancel: false };

    /* Ce que la capture a réellement vu. Sans iPhone sous la main, c'est le
       seul moyen de savoir pourquoi une panoramique sort floue : le champ a-t-il
       été mesuré ou supposé, sur combien d'avis concordants, et à quelle vitesse
       le téléphone tournait-il pendant les prises. */
    var diag = {
      video: null, screenAngle: null,
      hfovDeg: null, hfovMeasured: false, hfovSamples: 0, hfovSpreadDeg: null,
      speedMedian: null, speedMax: null, skippedFast: 0,
      orientEvents: 0, calibError: null
    };

    function ingest(fr) {
      var dims = imageSize(fr.image);
      if (!dims[0] || !dims[1]) return false;
      var quat = quatNorm(fr.quat);
      var tanH = Math.tan(fr.hfov / 2);
      var tanV = tanH * dims[1] / dims[0];

      uploadCam(rig, fr.image);
      var gain = state.frames === 0 ? 1 : measureGain(rig, quat, tanH, tanV);
      accumulate(rig, quat, tanH, tanV, gain * rig.weightScale);
      state.frames++;
      state.coverage = markCoverage(cells, quat, tanH, tanV);
      if (onProgress) onProgress(state.coverage, state.frames);
      return true;
    }

    function finish() {
      var canvas = resolveEquirect(rig);
      return encode(canvas).then(function (blob) {
        destroyRig(rig);
        return {
          canvas: canvas,
          width: rig.w,
          height: rig.h,
          coverage: state.coverage,
          frames: state.frames,
          blob: blob,
          diag: diag
        };
      });
    }

    if (opts.source) return runSource(opts.source, ingest, finish, rig, state);
    // `cells` en plus : le chemin réel en a besoin pour guider le geste (savoir
    // quelle zone il manque et où elle se trouve). Le chemin injecté n'y touche
    // jamais — aucune ligne de runSource ci-dessus n'a changé.
    return runCamera(opts, ingest, finish, rig, state, cells, diag);
  }

  // Chemin injecté : aucun accès à getUserMedia ni à DeviceOrientationEvent.
  function runSource(source, ingest, finish, rig, state) {
    if (typeof source.start === "function") source.start();
    function step() {
      var fr = null;
      try { fr = source.frame(); } catch (e) { fr = null; }
      if (!fr) {
        if (typeof source.stop === "function") source.stop();
        if (state.frames === 0) { destroyRig(rig); return Promise.resolve(null); }
        return finish();
      }
      ingest(fr);
      // On rend la main au navigateur entre deux images : c'est ce qui permet
      // à une vraie capture d'afficher sa progression, et ça garde le même
      // rythme que le chemin caméra.
      return nextFrame().then(step);
    }
    return Promise.resolve().then(step);
  }

  /* ------------------------------------------------------------------ */
  /* Chemin réel : caméra + IMU + interface guidée                       */
  /* ------------------------------------------------------------------ */

  // Messages d'échec du chemin caméra réel, écrits pour la personne qui tient
  // le téléphone (pas pour un développeur) : le nom d'erreur brut du navigateur
  // ne dit ni ce qui s'est passé ni quoi faire. `code` garde une trace stable
  // pour l'instrumentation ; `cause` garde l'erreur d'origine pour le débogage.
  function captureErrorMessage(code) {
    switch (code) {
      case "camera-denied":
        return "L'accès à la caméra a été refusé. Autorisez-la pour ce site dans les réglages de votre navigateur, puis recommencez.";
      case "camera-not-found":
        return "Aucune caméra arrière n'a été trouvée sur cet appareil.";
      case "camera-busy":
        return "La caméra est déjà utilisée par une autre application. Fermez-la, puis recommencez.";
      case "motion-denied":
        return "L'accès aux capteurs de mouvement a été refusé. Sans eux, impossible de savoir où vous visez. Autorisez le mouvement puis recommencez.";
      case "no-frames":
        return "Aucune image n'a été captée. Tenez le téléphone à la verticale et tournez lentement sur vous-même.";
      default:
        return "Impossible de démarrer la prise de vue. Vérifiez que la caméra et le mouvement sont autorisés pour ce site, et que la page n'est pas affichée dans un cadre (iframe) qui bloque ces accès.";
    }
  }

  function makeCaptureError(code, originalErr) {
    var err = new Error(captureErrorMessage(code));
    err.code = code;
    err.cause = originalErr || null;
    return err;
  }

  // getUserMedia ne distingue ces cas que par `err.name` : à nous de les
  // traduire, sinon l'utilisateur lit un message anglais de navigateur sans
  // savoir s'il doit changer un réglage ou fermer une autre application.
  function mapGetUserMediaError(err) {
    var name = err && err.name;
    if (name === "NotAllowedError") return makeCaptureError("camera-denied", err);
    if (name === "NotFoundError" || name === "OverconstrainedError") return makeCaptureError("camera-not-found", err);
    if (name === "NotReadableError") return makeCaptureError("camera-busy", err);
    return makeCaptureError("generic", err);
  }

  /* ------------------------------------------------------------------ */
  /* Mesurer le champ de vision au lieu de le supposer                    */
  /*                                                                      */
  /* Aucune API web ne donne l'angle de champ d'une caméra. Le flux        */
  /* demandé en 1920×1080 est de surcroît un RECADRAGE du capteur, dont    */
  /* l'angle n'est pas celui de l'objectif : la valeur varie d'un modèle   */
  /* à l'autre, et entre l'objectif principal et l'ultra grand-angle.      */
  /*                                                                      */
  /* Une supposition fausse ne dégrade pas un peu, elle détruit : mesuré   */
  /* sur la vérité terrain, 12 % d'écart font tomber le PSNR de 30 à 18 dB */
  /* et transforment la panoramique en filé horizontal, texte fantômé et   */
  /* grille dédoublée.                                                     */
  /*                                                                      */
  /* On le mesure donc sur les images elles-mêmes. Entre deux prises, le   */
  /* capteur d'orientation donne l'angle dont le téléphone a tourné, et la */
  /* corrélation des deux images donne le décalage en pixels. Le rapport   */
  /* des deux EST la distance focale : f = Δpixels / Δangle. C'est la même */
  /* mesure qu'un photographe fait en comparant un déplacement connu à son */
  /* effet sur le film.                                                    */
  /* ------------------------------------------------------------------ */

  var STRIP_W = 256;      // largeur du profil comparé
  var STRIP_SEARCH = 80;  // décalage maximal cherché, en pixels de profil

  /* Un profil de luminance : la bande centrale de l'image, réduite à une
     ligne. Moyenner verticalement supprime le bruit sans rien coûter, et
     conserve exactement ce dont la corrélation a besoin — les variations
     horizontales. */
  function lumaStrip(image, w, h) {
    var cv = lumaStrip.canvas || (lumaStrip.canvas = document.createElement("canvas"));
    var rows = 4;
    cv.width = STRIP_W; cv.height = rows;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    // Bande centrale : le haut et le bas d'une image de pièce sont souvent
    // un plafond ou un sol unis, sans rien à corréler.
    var sy = Math.round(h * 0.35), sh = Math.max(1, Math.round(h * 0.30));
    ctx.drawImage(image, 0, sy, w, sh, 0, 0, STRIP_W, rows);
    var px;
    try { px = ctx.getImageData(0, 0, STRIP_W, rows).data; } catch (e) { return null; }
    var out = new Float32Array(STRIP_W);
    for (var x = 0; x < STRIP_W; x++) {
      var sum = 0;
      for (var y = 0; y < rows; y++) {
        var o = (y * STRIP_W + x) * 4;
        sum += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
      }
      out[x] = sum / rows;
    }
    return out;
  }

  /* Décalage horizontal entre deux profils, par somme des écarts absolus.
     On rend aussi la confiance du résultat.

     Attention au piège : le deuxième meilleur score est presque toujours le
     VOISIN IMMÉDIAT du meilleur, et il en est forcément proche. Comparer les
     deux donnerait un contraste minuscule pour toute correspondance, même
     parfaite — mesuré : le filtre écartait précisément les bonnes mesures. On
     cherche donc le second minimum HORS d'une fenêtre autour du premier :
     c'est lui qui dit si un autre alignement était plausible, ce qui arrive
     dès qu'une pièce contient un motif répété — carrelage, lames de parquet,
     montants d'étagère. */
  /* On ne compare que la MOITIÉ CENTRALE du profil, et c'est ce qui décide de
     la justesse. En projection perspective, une rotation ne décale pas l'image
     uniformément : le déplacement croît avec l'écart au centre, en sec² de
     l'angle. Une corrélation sur toute la largeur est donc tirée par les bords,
     surestime le décalage, et sous-estime le champ — mesuré, 4 à 5 % de biais
     systématique, dans le même sens sur les quatre champs essayés. Sur la
     moitié centrale, le facteur tombe de 14 % à 3,5 %, et le reste se corrige
     analytiquement plus bas. */
  var TPL_FROM = STRIP_W / 4, TPL_TO = STRIP_W - STRIP_W / 4;

  function stripShift(a, b) {
    var scores = new Float32Array(2 * STRIP_SEARCH + 1);
    var valid = new Uint8Array(2 * STRIP_SEARCH + 1);
    var best = 0, bestScore = Infinity, d, i;

    for (d = -STRIP_SEARCH; d <= STRIP_SEARCH; d++) {
      i = d + STRIP_SEARCH;
      var from = Math.max(TPL_FROM, -d), to = Math.min(TPL_TO, STRIP_W - d);
      if (to - from < (TPL_TO - TPL_FROM) * 0.7) continue;   // recouvrement trop faible
      var sum = 0, n = 0;
      for (var x = from; x < to; x++) { sum += Math.abs(a[x] - b[x + d]); n++; }
      scores[i] = sum / n;
      valid[i] = 1;
      if (scores[i] < bestScore) { bestScore = scores[i]; best = d; }
    }
    if (!isFinite(bestScore)) return null;

    var rival = Infinity;
    for (d = -STRIP_SEARCH; d <= STRIP_SEARCH; d++) {
      if (Math.abs(d - best) <= 4) continue;     // le voisinage du pic ne compte pas
      i = d + STRIP_SEARCH;
      if (valid[i] && scores[i] < rival) rival = scores[i];
    }
    if (!isFinite(rival) || rival <= 0) return null;

    /* Affinement sous-pixel par parabole sur les trois points du minimum.
       À 2° de rotation le décalage ne fait que quelques pixels : l'arrondi
       au pixel coûterait plusieurs pour cent sur la focale. */
    var refined = best;
    var im = best - 1 + STRIP_SEARCH, ip = best + 1 + STRIP_SEARCH, ic = best + STRIP_SEARCH;
    if (im >= 0 && ip < scores.length && valid[im] && valid[ip]) {
      var denom = scores[im] - 2 * scores[ic] + scores[ip];
      if (denom > 1e-6) {
        var delta = 0.5 * (scores[im] - scores[ip]) / denom;
        if (Math.abs(delta) <= 1) refined = best + delta;
      }
    }

    /* Trois mesures, parce qu'aucune ne suffit seule.

       RELIEF : la variation moyenne du profil. Un mur uni n'a rien à
       corréler ; il se superpose parfaitement à lui-même quel que soit le
       décalage, et toute mesure qu'on en tire est du bruit.

       AJUSTEMENT : l'erreur du meilleur alignement, rapportée à l'amplitude
       du profil. C'est ce qui manquait : le rapport entre le meilleur score
       et son rival est un rapport de deux erreurs, et quand les deux
       approchent zéro — profil plat — il s'envole au lieu de s'effondrer.
       Mesuré : un décalage nul annoncé avec 0,63 de confiance, pendant que
       les couples justes étaient écartés.

       RIVALITÉ : le second minimum hors du pic, qui dit si un autre
       alignement était plausible — le cas des motifs répétés. */
    var mean = 0, x2;
    for (x2 = TPL_FROM; x2 < TPL_TO; x2++) mean += a[x2];
    mean /= (TPL_TO - TPL_FROM);
    var relief = 0, amplitude = 0;
    for (x2 = TPL_FROM; x2 < TPL_TO - 1; x2++) relief += Math.abs(a[x2 + 1] - a[x2]);
    relief /= (TPL_TO - TPL_FROM - 1);
    for (x2 = TPL_FROM; x2 < TPL_TO; x2++) amplitude += Math.abs(a[x2] - mean);
    amplitude /= (TPL_TO - TPL_FROM);

    return {
      shift: refined,
      relief: relief,
      fit: amplitude > 0 ? 1 - bestScore / amplitude : 0,
      confidence: (rival - bestScore) / rival
    };
  }

  /* L'angle dont la visée a tourné autour de la verticale, entre deux poses. */
  function yawBetween(qa, qb) {
    var fa = rotate(qa, [0, 0, -1]);
    var fb = rotate(qb, [0, 0, -1]);
    var ax = fa[0], az = fa[2], bx = fb[0], bz = fb[2];
    var la = Math.sqrt(ax * ax + az * az), lb = Math.sqrt(bx * bx + bz * bz);
    // Visée presque verticale : la composante horizontale disparaît et
    // l'angle n'a plus de sens.
    if (la < 0.25 || lb < 0.25) return null;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
  }

  /* Une estimation de champ, à partir d'un couple d'images et de leurs poses.
     Exposée pour les essais : c'est le cœur de la mesure, et il doit pouvoir
     être vérifié sans caméra. */
  function hfovFromPair(stripA, quatA, stripB, quatB) {
    var yaw = yawBetween(quatA, quatB);
    if (yaw === null) return null;
    var deg = Math.abs(yaw) * 180 / Math.PI;
    /* Trop grand : la perspective déforme l'image, et un simple décalage ne
       la décrit plus — mesuré, au-delà de cinq degrés l'estimation finit par
       s'accrocher au mauvais alignement dès que la pièce a un motif répété.
       Trop petit aussi : à un degré et demi, un objectif large ne décale
       l'image que de quatre pixels de profil, et un tiers de pixel d'erreur
       d'affinement coûte déjà sept pour cent sur le champ. */
    if (deg < 2 || deg > 5) return null;

    var m = stripShift(stripA, stripB);
    /* Seuil de confiance volontairement bas. Un motif répété — carrelage,
       lames de parquet, montants d'étagère — crée un alignement rival tout
       aussi plausible, et exiger une correspondance franche rendait
       l'estimateur muet précisément dans les pièces qui en ont le plus
       besoin. On accepte donc quelques verrouillages erronés : la médiane
       sur des dizaines de couples les met en minorité, là où un silence ne
       corrige rien du tout. */
    if (!m) return null;
    if (m.relief < 2) return null;          // profil sans relief : rien à corréler
    if (m.fit < 0.5) return null;           // le meilleur alignement n'explique pas le profil
    if (m.confidence < 0.02) return null;   // un autre alignement était tout aussi bon
    if (Math.abs(m.shift) < 1.5) return null;

    // Le décalage est mesuré en pixels de PROFIL ; la focale se compte dans
    // la même unité, et le champ s'en déduit sur la largeur du profil.
    var f = Math.abs(m.shift) / Math.abs(yaw);
    if (!isFinite(f) || f <= 0) return null;

    /* Le décalage mesuré vaut Δθ·f·(1 + t²/12) sur la moitié centrale, où
       t = tan(champ/2) : le reste du terme en sec². On inverse cette relation
       par quelques itérations — elle converge en trois tours, et sans elle il
       resterait 3 % de biais, toujours dans le même sens. */
    var t = (STRIP_W / 2) / f;
    for (var k = 0; k < 4; k++) t = ((STRIP_W / 2) / f) * (1 + t * t / 12);

    var hfov = 2 * Math.atan(t);
    if (!(hfov > 0.5) || hfov > 2.6) return null;   // hors de [29°, 149°]
    return hfov;
  }

  function median(values) {
    var v = values.slice().sort(function (x, y) { return x - y; });
    var n = v.length;
    if (!n) return null;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  /* L'autorisation de mouvement, demandée DEPUIS LE GESTE.

     iOS 13+ n'accorde `deviceorientation` que si `requestPermission()` part
     de l'activation utilisateur en cours. Ce n'est pas « peu après le clic » :
     toute promesse attendue entre le doigt et l'appel consomme l'activation,
     et Safari refuse alors sans même afficher de demande — l'utilisateur voit
     un refus qu'on ne lui a jamais soumis.

     D'où cette séparation : `primeMotion()` est appelé SYNCHRONEMENT dans le
     gestionnaire de clic, et `start()` récupère plus tard la promesse ainsi
     amorcée. C'est la seule façon d'avoir la fenêtre d'autorisation. */
  var motionGrant = null;

  function primeMotion() {
    if (!window.DeviceOrientationEvent ||
        typeof window.DeviceOrientationEvent.requestPermission !== "function") {
      // Android et les navigateurs de bureau n'ont pas de garde : rien à demander.
      motionGrant = Promise.resolve(true);
      return motionGrant;
    }
    try {
      motionGrant = window.DeviceOrientationEvent.requestPermission()
        .then(function (r) { return r === "granted"; }, function () { return false; });
    } catch (e) {
      motionGrant = Promise.resolve(false);
    }
    return motionGrant;
  }

  function requestOrientationPermission() {
    // Une demande amorcée ne sert qu'une fois : sans cela, un deuxième tour
    // rejouerait la réponse du premier au lieu de redemander.
    var pending = motionGrant;
    motionGrant = null;
    if (!pending) pending = primeMotion();
    return pending.then(function (granted) {
      if (!granted) throw makeCaptureError("motion-denied");
    });
  }

  /* ------------------------------------------------------------------ */
  /* Guidage du geste                                                    */
  /*                                                                      */
  /* Le module tient déjà tout ce qu'il faut pour dire à l'utilisateur où */
  /* viser : la grille de couverture 64×32 et le quaternion courant. Une  */
  /* barre de progression seule ne dit jamais QUOI faire ensuite — et pour */
  /* FULMO (retrouver un objet en haut d'une étagère ou au ras du sol),   */
  /* ce sont justement les latitudes extrêmes, que personne ne vise      */
  /* spontanément, qui comptent le plus.                                 */
  /* ------------------------------------------------------------------ */

  // Trou de couverture le plus proche angulairement de la visée actuelle —
  // pas le premier trou trouvé, ni le plus grand : le plus proche, pour ne
  // jamais envoyer l'utilisateur à l'autre bout de la pièce s'il reste un
  // trou juste à côté de ce qu'il regarde déjà.
  function nearestUncoveredDir(cells, quat) {
    var boresight = rotate(quat, [0, 0, -1]);
    var curLon = Math.atan2(boresight[0], -boresight[2]);
    var curLat = Math.asin(Math.max(-1, Math.min(1, boresight[1])));
    var best = null, bestScore = -2, gx, gy;
    for (gy = 0; gy < COV_H; gy++) {
      var lat = ((gy + 0.5) / COV_H - 0.5) * PI;
      var cl = Math.cos(lat);
      for (gx = 0; gx < COV_W; gx++) {
        if (cells[gy * COV_W + gx]) continue;
        var lon = ((gx + 0.5) / COV_W - 0.5) * TAU;
        var dir = [Math.sin(lon) * cl, Math.sin(lat), -Math.cos(lon) * cl];
        var score = dir[0] * boresight[0] + dir[1] * boresight[1] + dir[2] * boresight[2];
        if (score > bestScore) { bestScore = score; best = { lon: lon, lat: lat, dir: dir }; }
      }
    }
    if (!best) return null;
    best.yawDelta = wrapPi(best.lon - curLon);
    best.pitchDelta = best.lat - curLat;
    return best;
  }

  function wrapPi(a) {
    a = a % TAU;
    if (a > PI) a -= TAU;
    if (a < -PI) a += TAU;
    return a;
  }

  // NDC caméra -> position écran normalisée [0,1], en tenant compte du
  // recadrage d'`object-fit:cover` : le flux demandé (souvent 16:9) ne
  // correspond presque jamais à l'écran du téléphone (plus haut, plus
  // étroit), donc le centre de l'image caméra n'est pas le centre affiché
  // sans cette correction — sinon le réticule dérive par rapport à ce que
  // l'utilisateur voit réellement.
  function ndcToScreen(ndcX, ndcY, videoW, videoH, boxW, boxH) {
    var contentAR = videoW / videoH;
    var boxAR = boxW / boxH;
    var visX = ndcX, visY = ndcY;
    if (contentAR > boxAR) visX = ndcX * (boxAR / contentAR);
    else visY = ndcY * (contentAR / boxAR);
    return { x: (visX + 1) / 2, y: (1 - visY) / 2 };
  }

  // Phrase courte, latitude prioritaire sur longitude : c'est la consigne la
  // plus utile pour FULMO (voir plus haut) et celle qu'un simple pourcentage
  // ne donne jamais.
  function guidanceText(target) {
    if (!target) return "Couverture complète — vous pouvez terminer.";
    var yd = target.yawDelta * 180 / PI, pd = target.pitchDelta * 180 / PI;
    if (Math.abs(pd) > 8 && Math.abs(pd) >= Math.abs(yd)) {
      return pd > 0 ? "Inclinez le téléphone vers le haut" : "Inclinez le téléphone vers le bas — visez le sol";
    }
    if (Math.abs(yd) > 8) {
      return yd > 0 ? "Tournez lentement vers la droite" : "Tournez lentement vers la gauche";
    }
    return "Continuez à balayer lentement";
  }

  function buildOverlay(roomName) {
    var root = document.createElement("div");
    root.setAttribute("data-fulmo-pano", "1");
    root.style.cssText = "position:fixed;inset:0;z-index:99999;background:#000;overflow:hidden;" +
      "display:flex;flex-direction:column;font:500 15px system-ui,-apple-system,sans-serif;color:#fff";

    var video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.autoplay = true;
    video.muted = true;
    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";

    // Réticule façon Zillow : la cible à viser, visible seulement quand le
    // trou de couverture le plus proche tombe dans le champ actuel. S'éteint
    // dès que la zone est captée — la cible suivante apparaît ailleurs.
    var reticle = document.createElement("div");
    reticle.style.cssText = "position:absolute;width:64px;height:64px;margin:-32px 0 0 -32px;" +
      "border:3px solid #ffd400;border-radius:50%;" +
      "box-shadow:0 0 0 3px rgba(0,0,0,.55),0 0 18px rgba(255,212,0,.8);" +
      "display:none;pointer-events:none;transition:left .12s linear,top .12s linear";
    var reticleDot = document.createElement("div");
    reticleDot.style.cssText = "position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;" +
      "border-radius:50%;background:#ffd400";
    reticle.appendChild(reticleDot);

    // Flèche de cap : la cible est hors champ. Pas de position exacte hors
    // écran à calculer — un simple cap (haut/bas/gauche/droite) suffit pour
    // se réorienter, et c'est plus robuste qu'une extrapolation de bord.
    var arrow = document.createElement("div");
    arrow.style.cssText = "position:absolute;font-size:44px;line-height:1;color:#ffd400;" +
      "text-shadow:0 2px 8px rgba(0,0,0,.7);display:none;pointer-events:none";

    var hud = document.createElement("div");
    hud.style.cssText = "position:relative;margin-top:auto;padding:16px 16px calc(16px + env(safe-area-inset-bottom));" +
      "background:linear-gradient(transparent,rgba(0,0,0,.78) 35%);display:flex;flex-direction:column;gap:10px";

    var topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:baseline;gap:12px";
    var hint = document.createElement("div");
    hint.style.cssText = "flex:1;font-weight:700;font-size:16px";
    hint.textContent = "Balayez la pièce lentement — " + (roomName || "panorama");
    var pctLabel = document.createElement("div");
    pctLabel.style.cssText = "font-size:12px;opacity:.65;font-variant-numeric:tabular-nums;white-space:nowrap";
    pctLabel.textContent = "0 %";
    topRow.appendChild(hint);
    topRow.appendChild(pctLabel);

    // Mini-carte : la grille de couverture 64×32 déroulée telle quelle. C'est
    // le seul indicateur qui distingue « il me manque un bout de mur » de
    // « il me manque tout le plafond » — un pourcentage seul ne le peut pas.
    var minimapWrap = document.createElement("div");
    minimapWrap.style.cssText = "position:relative;align-self:center;width:220px;height:110px;" +
      "border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.35)";
    var minimap = document.createElement("canvas");
    minimap.width = COV_W;
    minimap.height = COV_H;
    minimap.style.cssText = "width:100%;height:100%;display:block;image-rendering:pixelated";
    var aimDot = document.createElement("div");
    aimDot.style.cssText = "position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;" +
      "border-radius:50%;background:#fff;box-shadow:0 0 0 2px #000";
    minimapWrap.appendChild(minimap);
    minimapWrap.appendChild(aimDot);

    // Avertissement de couverture faible : jamais un blocage, juste un rappel
    // tant que "Terminer" couperait court trop tôt. Vide sinon.
    var warn = document.createElement("div");
    warn.style.cssText = "font-size:12px;color:#ffb648;text-align:center;min-height:16px";

    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:12px";
    var cancel = document.createElement("button");
    cancel.textContent = "Annuler";
    cancel.style.cssText = "flex:1;padding:14px;border:0;border-radius:12px;background:rgba(255,255,255,.18);color:#fff;font:inherit";
    var done = document.createElement("button");
    done.textContent = "Terminer";
    done.style.cssText = "flex:2;padding:14px;border:0;border-radius:12px;background:#ffd400;color:#111;font:inherit;font-weight:700";
    row.appendChild(cancel);
    row.appendChild(done);

    hud.appendChild(topRow);
    hud.appendChild(minimapWrap);
    hud.appendChild(warn);
    hud.appendChild(row);
    root.appendChild(video);
    root.appendChild(reticle);
    root.appendChild(arrow);
    root.appendChild(hud);
    document.body.appendChild(root);

    return {
      root: root, video: video, hint: hint, pctLabel: pctLabel, warn: warn,
      reticle: reticle, arrow: arrow,
      minimap: minimap, minimapCtx: minimap.getContext("2d"), aimDot: aimDot,
      cancel: cancel, done: done
    };
  }

  /* Au-delà de cette vitesse, l'image est filée par la pose de la caméra et
     ne vaut plus la peine d'être accumulée. Trente degrés par seconde, c'est
     un tour complet en douze secondes : lent pour qui se dépêche, confortable
     pour qui suit un réticule. */
  var SPEED_MAX = 0.52;   // rad/s, ~30°/s

  function runCamera(opts, ingest, finish, rig, state, cells, diag) {
    var ui = null, stream = null, orient = null, quat = null, lastQuat = null;
    var lastMs = 0, speeds = [];
    var lastOrientMs = 0;
    var hfov = opts.hfov || DEFAULT_HFOV;

    /* Mesure du champ, avant toute accumulation.

       On ne peut pas accumuler puis corriger : la sphère est écrite au fur et
       à mesure, et les premières images y resteraient peintes de travers. La
       capture commence donc par quelques secondes où l'on ne fait que
       mesurer — l'utilisateur tourne, le module compare ses images à ce que
       dit le capteur d'orientation, et en déduit la focale.

       Si la pièce ne s'y prête pas — murs unis, motif répété partout — la
       mesure se tait plutôt que de deviner, et on repart sur la valeur par
       défaut. C'est alors exactement le comportement d'avant, pas pire. */
    var CALIB_MIN = 12;        // estimations avant de figer
    var CALIB_MS = 9000;       // au-delà, on prend ce qu'on a, ou le défaut
    var calib = {
      locked: false, measured: false,
      strip: null, quat: null, estimates: [], started: 0, tries: 0
    };

    function calibrate(video, q, vw, vh) {
      calib.tries += 1;
      var strip = lumaStrip(video, vw, vh);
      if (!strip) { calib.locked = true; return; }
      if (calib.strip) {
        var est = hfovFromPair(calib.strip, calib.quat, strip, q);
        if (est !== null) calib.estimates.push(est);
      }
      calib.strip = strip;
      calib.quat = q;

      var elapsed = Date.now() - calib.started;
      if (calib.estimates.length >= CALIB_MIN || (elapsed > CALIB_MS && calib.tries > 8)) {
        lockCalibration();
      }
    }

    function lockCalibration() {
      if (calib.locked) return;
      var m = median(calib.estimates);
        // Au moins cinq avis concordants : en dessous, la médiane ne protège
        // plus de rien et le défaut est un pari plus sûr.
      if (m !== null && calib.estimates.length >= 5) { hfov = m; calib.measured = true; }
      calib.locked = true;

      diag.hfovDeg = hfov * 180 / PI;
      diag.hfovMeasured = calib.measured;
      diag.hfovSamples = calib.estimates.length;
      if (calib.estimates.length >= 2) {
        var sorted = calib.estimates.slice().sort(function (x, y) { return x - y; });
        // Écart interquartile : la dispersion des avis dit s'ils s'accordent,
        // et une médiane tirée d'avis discordants ne vaut rien.
        var q1 = sorted[Math.floor(sorted.length * 0.25)];
        var q3 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
        diag.hfovSpreadDeg = (q3 - q1) * 180 / PI;
      }
    }

    function cleanup() {
      if (orient) window.removeEventListener("deviceorientation", orient, true);
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      if (ui && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
    }

    // Redessine la mini-carte à partir de la grille de couverture. Coûteux à
    // l'échelle de « une fois par image captée » (rare : gatée par le
    // déplacement angulaire minimal), jamais à l'échelle de chaque tick.
    function drawMinimap() {
      var ctx = ui.minimapCtx, gx, gy;
      for (gy = 0; gy < COV_H; gy++) {
        // Rangée 0 du canvas = latitude la plus haute (plafond), comme dans
        // l'équirect final : la mini-carte doit s'orienter comme la pièce.
        var row = COV_H - 1 - gy;
        for (gx = 0; gx < COV_W; gx++) {
          ctx.fillStyle = cells[gy * COV_W + gx] ? "#ffd400" : "rgba(255,255,255,.15)";
          ctx.fillRect(gx, row, 1, 1);
        }
      }
    }

    // Tourne à chaque image affichée (pas seulement à chaque capture) : c'est
    // ce qui rend le réticule et le point de visée fluides pendant que le
    // téléphone bouge, indépendamment du rythme d'ingestion.
    function updateGuidance() {
      if (!quat) return;
      var dims = imageSize(ui.video);
      var tanH = Math.tan(hfov / 2);
      var tanV = (dims[0] && dims[1]) ? tanH * dims[1] / dims[0] : tanH;

      var boresight = rotate(quat, [0, 0, -1]);
      var curLon = Math.atan2(boresight[0], -boresight[2]);
      var curLat = Math.asin(Math.max(-1, Math.min(1, boresight[1])));
      var mx = (curLon / TAU + 0.5) * COV_W;
      var my = COV_H - 1 - (curLat / PI + 0.5) * COV_H;
      ui.aimDot.style.left = (mx / COV_W * 100) + "%";
      ui.aimDot.style.top = (my / COV_H * 100) + "%";

      var target = nearestUncoveredDir(cells, quat);
      ui.hint.textContent = guidanceText(target);

      if (!target) {
        ui.reticle.style.display = "none";
        ui.arrow.style.display = "none";
        return;
      }

      if (insideFrustum(quat, target.dir, tanH, tanV, 1)) {
        var c = rotateInv(quat, target.dir);
        var ndcX = c[0] / (-c[2]) / tanH, ndcY = c[1] / (-c[2]) / tanV;
        var box = ui.video.getBoundingClientRect();
        var scr = ndcToScreen(ndcX, ndcY, dims[0] || 16, dims[1] || 9, box.width || 1, box.height || 1);
        ui.reticle.style.left = (scr.x * 100) + "%";
        ui.reticle.style.top = (scr.y * 100) + "%";
        ui.reticle.style.display = "block";
        ui.arrow.style.display = "none";
      } else {
        ui.reticle.style.display = "none";
        var yd = target.yawDelta, pd = target.pitchDelta;
        if (Math.abs(pd) >= Math.abs(yd)) {
          ui.arrow.textContent = pd > 0 ? "↑" : "↓";
          ui.arrow.style.left = "50%"; ui.arrow.style.top = pd > 0 ? "8%" : "82%";
        } else {
          ui.arrow.textContent = yd > 0 ? "→" : "←";
          ui.arrow.style.left = yd > 0 ? "88%" : "8%"; ui.arrow.style.top = "45%";
        }
        ui.arrow.style.display = "block";
      }
    }

    return requestOrientationPermission().then(function () {
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      }).catch(function (err) {
        // Mappé ici, précisément à la source de l'échec : plus bas dans la
        // chaîne, un rejet ne serait plus forcément un problème de caméra.
        throw mapGetUserMediaError(err);
      }).then(function (s) {
        stream = s;
        ui = buildOverlay(opts.roomName);
        ui.video.srcObject = s;
        drawMinimap();

        orient = function (e) {
          var angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
          quat = quatFromDeviceOrientation(e.alpha, e.beta, e.gamma, angle);
          lastOrientMs = Date.now();
          diag.orientEvents += 1;
        };
        window.addEventListener("deviceorientation", orient, true);

        return new Promise(function (resolve, reject) {
          /* Sortir de la capture ne doit dépendre de rien.

             Les deux boutons ne faisaient que poser un drapeau que la boucle
             de rendu venait lire. Le jour où cette boucle est morte — une
             exception dans la mesure du champ a suffi — l'utilisateur s'est
             retrouvé enfermé en plein écran, sans pouvoir ni enregistrer ni
             annuler. Un bouton de sortie qui dépend de l'état sain du
             programme n'est pas un bouton de sortie.

             `settle()` fait donc tout le travail, immédiatement, et se protège
             d'un double appel : c'est le seul point où la capture se termine,
             que l'ordre vienne du doigt ou de la boucle. */
          var settled = false;

          function settle() {
            if (settled) return;
            settled = true;
            cleanup();
            if (state.cancel) { destroyRig(rig); return resolve(null); }
            if (state.frames === 0) { destroyRig(rig); return reject(makeCaptureError("no-frames")); }
            diag.speedMedian = median(speeds);
            diag.video = ui.video.videoWidth + "×" + ui.video.videoHeight;
            diag.screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
            return finish().then(resolve, reject);
          }

          ui.cancel.onclick = function () { state.cancel = true; state.stop = true; settle(); };
          // Ne bloque jamais : qui veut s'arrêter s'arrête. Le guidage
          // dissuade de terminer trop tôt, il ne l'empêche jamais.
          ui.done.onclick = function () { state.stop = true; settle(); };

          function loop() {
            if (settled) return;
            // `null` ne doit signifier qu'une chose : un appui volontaire sur
            // Annuler. Terminer sans avoir capté une seule image n'est pas une
            // annulation — l'utilisateur a agi, mais rien d'exploitable n'a été
            // produit — donc ça rejette, avec de quoi corriger le tir. Toute
            // cette logique vit maintenant dans settle().
            if (state.stop) { return settle(); }
            if (quat && ui.video.readyState >= 2) {
              // On n'accumule qu'après un déplacement angulaire réel : rester
              // immobile n'apporte rien et gonflerait le poids local, ce qui
              // déséquilibrerait la moyenne pondérée.
              var moved = !lastQuat || quatAngle(lastQuat, quat) > 0.045; // ~2,6°

              if (!calib.locked) {
                if (!calib.started) calib.started = Date.now();

                /* Le plafond de temps est appliqué ICI, dans la boucle, et pas
                   seulement au creux de la mesure. Sinon il ne s'applique que
                   si la mesure continue d'être appelée — et le jour où elle
                   cesse de l'être, faute de mouvement détecté, la capture reste
                   bloquée sur son écran de mesure sans jamais en sortir. */
                if (Date.now() - calib.started > CALIB_MS + 3000) lockCalibration();
                else if (moved) {
                  /* Protégée, comme l'accumulation l'était déjà. La mesure du
                     champ est un bonus : si elle échoue, on prend le réglage
                     par défaut et la capture continue. Elle ne doit jamais
                     emporter la boucle avec elle. */
                  try {
                    calibrate(ui.video, quat, ui.video.videoWidth, ui.video.videoHeight);
                  } catch (err) {
                    diag.calibError = String((err && err.message) || err);
                    lockCalibration();
                  }
                  lastQuat = quat;
                }
                ui.hint.textContent = "Tournez lentement sur vous-même : je mesure votre objectif.";
                ui.pctLabel.textContent = Math.min(99, Math.round(calib.estimates.length / CALIB_MIN * 100)) + " %";
                if (calib.locked) {
                  lastQuat = null;   // la mesure finie, la capture repart de zéro
                  ui.warn.textContent = calib.measured ? "" :
                    "Objectif non mesurable ici : réglage par défaut. Le résultat peut être flou.";
                }
                requestAnimationFrame(loop);
                return;
              }

              /* Vitesse de rotation. En lumière d'intérieur, une caméra de
                 téléphone pose long : à vingt degrés par seconde, chaque image
                 est déjà filée d'un ou deux degrés, et une panoramique faite de
                 quarante images filées reste floue même parfaitement alignée.
                 On laisse donc passer le mouvement lent et on écarte le reste,
                 en le disant. */
              var now = Date.now();
              var speed = null;
              if (lastQuat && lastMs) {
                var dt = (now - lastMs) / 1000;
                if (dt > 0.008) speed = quatAngle(lastQuat, quat) / dt;
              }
              if (speed !== null) {
                speeds.push(speed);
                if (diag.speedMax === null || speed > diag.speedMax) diag.speedMax = speed;
              }
              var tooFast = speed !== null && speed > SPEED_MAX;
              if (tooFast) {
                diag.skippedFast += 1;
                lastMs = now;
                ui.hint.textContent = "Trop vite : ralentissez, sinon les images sont filées.";
              }

              if (moved && !tooFast) {
                var ok = false;
                try { ok = ingest({ image: ui.video, hfov: hfov, quat: quat }); } catch (err) { ok = false; }
                if (ok) {
                  lastQuat = quat;
                  lastMs = now;
                  drawMinimap();
                  ui.pctLabel.textContent = Math.round(state.coverage * 100) + " %";
                  // Avertit sans bloquer : voir le commentaire sur ui.done.onclick.
                  ui.warn.textContent = state.coverage < 0.7
                    ? "Couverture incomplète : le résultat aura des trous si vous terminez maintenant."
                    : "";
                  if (state.coverage > 0.985) state.stop = true;
                }
              }
            }
            /* Le flux d'orientation s'est tu. Sans lui, plus rien n'avance :
               autant le dire, plutôt que de laisser un écran figé sur lequel
               l'utilisateur bouge sans effet. */
            if (lastOrientMs && Date.now() - lastOrientMs > 4000) {
              ui.hint.textContent = "Plus aucune donnée d'orientation. Terminez, puis vérifiez Réglages › Safari › Mouvement et orientation.";
            }

            try { updateGuidance(); } catch (err) { /* le guidage n'est qu'un confort */ }
            requestAnimationFrame(loop);
          }
          requestAnimationFrame(loop);
        });
      });
    }).catch(function (err) {
      // Point de sortie unique pour toute panne qui rejette (permission
      // mouvement refusée, getUserMedia rejeté, aucune image captée, ou tout
      // autre échec imprévu) : la caméra et le contexte WebGL ne doivent jamais
      // survivre à une erreur, quel que soit l'endroit où elle a été levée.
      // Seul le chemin Annuler (qui résout au lieu de rejeter) fait sa propre
      // extinction plus haut, puisqu'il ne repasse pas par ce catch.
      cleanup();
      destroyRig(rig);
      throw (err && err.code) ? err : makeCaptureError("generic", err);
    });
  }

  window.FulmoPanoCapture = {
    support: support,
    start: start,
    // Doit être appelé dans le gestionnaire de clic, avant tout `await` :
    // c'est là, et seulement là, qu'iOS accepte de demander le mouvement.
    primeMotion: primeMotion,
    // Exposés pour les essais : la mesure du champ doit pouvoir être
    // vérifiée sans caméra, puisque c'est elle qui décide de la netteté.
    _hfovFromPair: hfovFromPair,
    _stripShift: stripShift,
    _yawBetween: yawBetween,
    _lumaStrip: lumaStrip,
    _median: median,
    // Exposé pour les tests et la visionneuse : la conversion IMU -> quaternion
    // est la partie la plus facile à casser silencieusement.
    _quatFromDeviceOrientation: quatFromDeviceOrientation
  };
})();

