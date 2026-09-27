/* ═══ pano-view.js ═══ */
/* ==========================================================================
   FULMO — Visionneuse de panoramique sphérique (équirectangulaire 2:1).
   WebGL2 nu, sans dépendance, sans build.

   Principe : aucun maillage de sphère. Un triangle plein écran, et pour chaque
   fragment on reconstruit la direction du rayon puis on échantillonne la
   texture équirectangulaire. Une sphère maillée introduirait des artefacts
   d'interpolation aux pôles (les quads dégénèrent) et forcerait un compromis
   entre densité de triangles et précision ; le ray-cast par fragment est exact
   partout et coûte moins cher.
   ========================================================================== */
(function () {
  "use strict";

  var DEG = Math.PI / 180;
  var TWO_PI = Math.PI * 2;
  var HFOV_MIN = 35 * DEG;
  var HFOV_MAX = 100 * DEG;
  /* Butée dure : on n'atteint jamais exactement le pôle, sinon la base caméra
     (construite à partir de l'axe monde Y) devient dégénérée. */
  var PITCH_HARD = 89.2 * DEG;
  /* À partir de cette latitude le glissé est progressivement freiné : c'est
     l'amortissement en butée, qui remplace un blocage sec très perceptible. */
  var PITCH_SOFT = 70 * DEG;
  var SPHERE_R = 3;
  var FADE_MS = 450;

  /* ---------------------------------------------------------------- shaders */

  var VERT_SRC = [
    "#version 300 es",
    "out vec2 vNdc;",
    "void main() {",
    /* Triangle unique qui déborde de l'écran : pas de VBO, pas d'attribut, et
       une seule interpolation continue (deux triangles créeraient une arête
       diagonale où les dérivées analytiques seraient inutilement recalculées). */
    "  vec2 p = vec2(gl_VertexID == 2 ? 3.0 : -1.0, gl_VertexID == 1 ? 3.0 : -1.0);",
    "  vNdc = p;",
    "  gl_Position = vec4(p, 0.0, 1.0);",
    "}"
  ].join("\n");

  var FRAG_SRC = [
    "#version 300 es",
    "precision highp float;",
    "precision highp sampler2D;",
    "in vec2 vNdc;",
    "uniform mat3 uBasis;",     /* colonnes : droite, haut, avant */
    "uniform vec2 uScale;",     /* tan(hfov/2), tan(vfov/2) */
    "uniform vec2 uPix;",       /* pas d'un pixel en NDC : 2/W, 2/H */
    "uniform sampler2D uTexA;",
    "uniform sampler2D uTexB;",
    "uniform float uMix;",
    "uniform float uAniso;",
    "out vec4 oColor;",
    "",
    "const float INV_TWO_PI = 0.15915494309189535;",
    "const float INV_PI = 0.31830988618379069;",
    "",
    "vec3 encodeSrgb(vec3 c) {",
    "  c = max(c, vec3(0.0));",
    "  vec3 lo = c * 12.92;",
    "  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;",
    "  return mix(hi, lo, step(c, vec3(0.0031308)));",
    "}",
    "",
    "void main() {",
    "  vec3 P = uBasis * vec3(vNdc.x * uScale.x, vNdc.y * uScale.y, 1.0);",
    "  float len = length(P);",
    "  vec3 d = P / len;",
    "",
    /* Dérivées écran du rayon, calculées à la main.
       POURQUOI : si on laisse le GPU dériver u = atan2(...)/2pi par différences
       finies, la discontinuité de atan2 à +/-pi fait croire au matériel que u
       varie d'un tour complet entre deux pixels voisins du méridien. Le niveau
       de mipmap saute alors au plus grossier sur cette colonne : c'est la bande
       floue d'un pixel qu'on voit sur la plupart des visionneuses. En dérivant
       analytiquement la direction (continue partout) puis en propageant vers u
       et v, le niveau de mipmap reste continu au passage de la couture. */
    "  vec3 Px = uBasis[0] * (uPix.x * uScale.x);",
    "  vec3 Py = uBasis[1] * (uPix.y * uScale.y);",
    "  vec3 dDx = (Px - d * dot(d, Px)) / len;",
    "  vec3 dDy = (Py - d * dot(d, Py)) / len;",
    "",
    "  vec2 hd = vec2(d.x, -d.z);",
    "  float hh = dot(hd, hd);",
    /* Au pôle exact le couple (x, -z) s'annule et atan2 n'est pas défini :
       on choisit une longitude arbitraire, elle n'a aucune incidence visible
       car le mipmap y moyenne déjà tout le parallèle. */
    "  if (hh < 1e-18) { hd = vec2(0.0, 1.0); hh = 1.0; }",
    "  float u = atan(hd.x, hd.y) * INV_TWO_PI + 0.5;",
    "  float y = clamp(d.y, -1.0, 1.0);",
    "  float v = 0.5 - asin(y) * INV_PI;",
    "",
    "  float invH = 1.0 / hh;",
    "  float dux = (-d.z * dDx.x + d.x * dDx.z) * invH * INV_TWO_PI;",
    "  float duy = (-d.z * dDy.x + d.x * dDy.z) * invH * INV_TWO_PI;",
    /* d(asin)/dy = 1/sqrt(1-y^2). Le 0/0 du pôle se simplifie analytiquement
       (dDy.y tend vers 0 à la même vitesse), le garde-fou n'est là que pour la
       précision flottante. */
    "  float s = sqrt(max(1.0 - y * y, 1e-12));",
    "  float dvx = -dDx.y / s * INV_PI;",
    "  float dvy = -dDy.y / s * INV_PI;",
    "",
    /* Près des pôles du/dx explose (tout le tour d'horizon se comprime dans
       quelques pixels). C'est géométriquement exact, mais si on laisse le
       gradient tel quel le matériel choisit le dernier niveau de mipmap et le
       zénith rouge devient un disque gris (la moyenne de toute l'image). On
       plafonne donc le rapport d'anisotropie à ce que le matériel sait traiter :
       le niveau de mipmap reste piloté par la dérivée verticale (nette) et le
       filtrage anisotrope moyenne le long du parallèle, ce qui est exactement
       le filtre voulu. */
    "  float vlen = max(max(abs(dvx), abs(dvy)), 1e-9);",
    "  float ulen = max(abs(dux), abs(duy));",
    "  float lim = vlen * uAniso;",
    "  if (ulen > lim) { float k = lim / ulen; dux *= k; duy *= k; }",
    "",
    "  vec2 gx = vec2(dux, dvx);",
    "  vec2 gy = vec2(duy, dvy);",
    "  vec2 uv = vec2(u, v);",
    /* Les textures sont en SRGB8_ALPHA8 : le matériel décode en linéaire AVANT
       le filtrage trilinéaire/anisotrope, donc les mélanges de texels sont
       physiquement justes. On ré-encode à la toute fin pour le canvas sRGB. */
    "  vec3 c = textureGrad(uTexA, uv, gx, gy).rgb;",
    "  if (uMix > 0.0) {",
    "    c = mix(c, textureGrad(uTexB, uv, gx, gy).rgb, uMix);",
    "  }",
    "  oColor = vec4(encodeSrgb(c), 1.0);",
    "}"
  ].join("\n");

  /* Réduction 2x1 : un seul tap bilinéaire posé au centre exact du bloc 2x2
     vaut la moyenne des quatre texels, sans dépendre d'un textureGather. */
  var MIP_SRC = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D uSrc;",
    "uniform vec2 uInvDst;",
    "out vec4 oColor;",
    "void main() {",
    "  oColor = texture(uSrc, gl_FragCoord.xy * uInvDst);",
    "}"
  ].join("\n");

  /* ---------------------------------------------------------------- helpers */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function smooth01(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  function easeOut(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }

  /* Écart angulaire le plus court : indispensable pour animer le lacet sans
     faire faire un tour complet à la vue quand on traverse le méridien. */
  function wrapPi(a) {
    a = (a + Math.PI) % TWO_PI;
    if (a < 0) { a += TWO_PI; }
    return a - Math.PI;
  }

  function sourceSize(src) {
    var w = src.naturalWidth || src.videoWidth || src.width || 0;
    var h = src.naturalHeight || src.videoHeight || src.height || 0;
    return [w | 0, h | 0];
  }

  /* ------------------------------------------------------------------ usine */

  function create(canvas, pinLayer, source, opts) {
    if (!canvas || !source) { return null; }
    opts = opts || {};

    var gl = null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,           /* le filtrage de texture fait tout l'AA utile */
        premultipliedAlpha: false,
        preserveDrawingBuffer: opts.preserveDrawingBuffer !== false,
        powerPreference: "high-performance",
        desynchronized: false
      });
    } catch (e) { gl = null; }
    if (!gl) { return null; }

    var srcSize = sourceSize(source);
    if (!srcSize[0] || !srcSize[1]) { return null; }

    /* -------------------------------------------------- extensions & limites */
    var anisoExt = gl.getExtension("EXT_texture_filter_anisotropic") ||
                   gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
    var anisoMax = anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    /* Sans anisotropie matérielle on plafonne quand même le gradient : un pôle
       légèrement crénelé reste infiniment préférable à un pôle gris. */
    var anisoClamp = anisoExt ? anisoMax : 4;

    /* ----------------------------------------------------------- programmes */
    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        lastError = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }

    function link(vsSrc, fsSrc) {
      var vs = compile(gl.VERTEX_SHADER, vsSrc);
      var fs = vs ? compile(gl.FRAGMENT_SHADER, fsSrc) : null;
      if (!vs || !fs) { return null; }
      var p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        lastError = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        return null;
      }
      return p;
    }

    var lastError = "";
    var prog = link(VERT_SRC, FRAG_SRC);
    var mipProg = link(VERT_SRC, MIP_SRC);
    if (!prog || !mipProg) { return null; }

    var uBasis = gl.getUniformLocation(prog, "uBasis");
    var uScale = gl.getUniformLocation(prog, "uScale");
    var uPix = gl.getUniformLocation(prog, "uPix");
    var uMixLoc = gl.getUniformLocation(prog, "uMix");
    var uAnisoLoc = gl.getUniformLocation(prog, "uAniso");
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, "uTexA"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uTexB"), 1);
    gl.uniform1f(uAnisoLoc, anisoClamp);

    var uMipInv = gl.getUniformLocation(mipProg, "uInvDst");
    gl.useProgram(mipProg);
    gl.uniform1i(gl.getUniformLocation(mipProg, "uSrc"), 0);

    var vao = gl.createVertexArray();
    var mipFbo = gl.createFramebuffer();

    /* -------------------------------------------------------------- texture */

    function levelCount(w, h) {
      return Math.floor(Math.log(Math.max(w, h)) / Math.LN2) + 1;
    }

    function buildMips(tex, w, h, levels) {
      /* On construit la chaîne nous-mêmes plutôt que via generateMipmap :
         la spécification ES3 laisse l'implémentation libre de réduire une
         texture sRGB directement dans l'espace gamma, ce qui assombrit
         visiblement les niveaux grossiers (la grille de 32 px vire au gris
         sale au dézoom). Ici la lecture décode en linéaire, la moyenne se fait
         en linéaire et l'écriture dans une cible sRGB ré-encode : la réduction
         est photométriquement juste. */
      var prevBind = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, mipFbo);
      gl.useProgram(mipProg);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

      var ok = true;
      var sw = w, sh = h, i;
      for (i = 1; i < levels; i++) {
        var dw = Math.max(1, sw >> 1);
        var dh = Math.max(1, sh >> 1);
        /* Lire et écrire la même texture n'est licite que si les niveaux
           accessibles à l'échantillonnage excluent la cible. */
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, i - 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, i - 1);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, i);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { ok = false; break; }
        gl.viewport(0, 0, dw, dh);
        gl.uniform2f(uMipInv, 1 / dw, 1 / dh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        sw = dw; sh = dh;
      }

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevBind);
      if (!ok) { gl.generateMipmap(gl.TEXTURE_2D); }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      return ok;
    }

    var mipsAreLinear = true;

    function makeTexture(src) {
      var size = sourceSize(src);
      var w = size[0], h = size[1];
      if (!w || !h) { return null; }
      var levels = levelCount(w, h);
      var tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      /* Pas de conversion de profil par le navigateur : on veut les octets
         source tels quels, sinon la fidélité colorimétrique dépend de l'écran
         de la machine qui a encodé l'image. */
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.SRGB8_ALPHA8, w, h);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
      /* REPEAT en S : la longitude boucle, un CLAMP laisserait une colonne de
         texels étirés au méridien. CLAMP_TO_EDGE en T : la latitude ne boucle
         pas, un REPEAT ferait apparaître le sol juste au-dessus du zénith. */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (anisoExt) {
        gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, anisoMax);
      }
      mipsAreLinear = buildMips(tex, w, h, levels);
      return { tex: tex, w: w, h: h, levels: levels };
    }

    var texA = makeTexture(source);
    if (!texA) { return null; }
    var texB = null;

    /* ---------------------------------------------------------------- état */

    var startHfov = clamp(typeof opts.hfov === "number" ? opts.hfov : 1.2, HFOV_MIN, HFOV_MAX);
    var yaw = 0, pitch = 0, hfov = startHfov;
    var hfovTarget = startHfov;
    var vYaw = 0, vPitch = 0;          /* inertie, rad/s */
    var anim = null;                   /* animation focusOn / double-tape */
    var fade = null;                   /* crossfade en cours */
    var pins = (opts.pins && opts.pins.slice) ? opts.pins.slice(0) : [];
    var picking = false;
    var disposed = false;
    var dirty = true;
    var running = false;
    var rafId = 0;
    var lastT = 0;
    var frames = 0;
    var lastDrawMs = 0;
    var vw = 0, vh = 0;                /* taille du tampon de dessin */
    var cssW = 1, cssH = 1;
    var detachedSince = 0;             /* instant depuis lequel le canevas est hors DOM */

    /* ---------------------------------------------------------- géométrie */

    function basis(y, p, out) {
      var cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
      /* colonne 0 : droite */
      out[0] = cy; out[1] = 0; out[2] = sy;
      /* colonne 1 : haut */
      out[3] = -sy * sp; out[4] = cp; out[5] = cy * sp;
      /* colonne 2 : avant (lacet 0 = -Z) */
      out[6] = sy * cp; out[7] = sp; out[8] = -cy * cp;
      return out;
    }

    var mat = new Float32Array(9);

    function tanHalfH() { return Math.tan(hfov * 0.5); }

    function tanHalfV() { return Math.tan(hfov * 0.5) * (cssH / Math.max(1, cssW)); }

    /* Direction monde sous un point écran. */
    function dirFromNdc(nx, ny) {
      basis(yaw, pitch, mat);
      var ax = nx * tanHalfH(), ay = ny * tanHalfV();
      var x = mat[0] * ax + mat[3] * ay + mat[6];
      var y = mat[1] * ax + mat[4] * ay + mat[7];
      var z = mat[2] * ax + mat[5] * ay + mat[8];
      var l = Math.sqrt(x * x + y * y + z * z) || 1;
      return [x / l, y / l, z / l];
    }

    function yawOf(d) { return Math.atan2(d[0], -d[2]); }
    function pitchOf(d) { return Math.asin(clamp(d[1], -1, 1)); }

    /* ------------------------------------------------------------- rendu */

    function resize() {
      /* Un noeud détaché renvoie un rectangle nul : on ne redimensionne pas
         sur cette base, sinon le tampon s'effondrerait à 1x1 le temps du
         déplacement, ce qu'on verrait comme une image figée en noir. */
      if (!canvas.isConnected) { return; }
      var r = canvas.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width || canvas.clientWidth || canvas.width));
      cssH = Math.max(1, Math.round(r.height || canvas.clientHeight || canvas.height));
      var dpr = window.devicePixelRatio || 1;
      /* Léger suréchantillonnage sur les écrans peu denses : c'est ce qui
         empêche les arêtes de la grille de baver en bordure de champ, là où la
         projection rectilinéaire étire le plus. Plafonné à 2 pour le coût. */
      var scale = Math.min(2, Math.max(1, dpr * 1.5));
      if (typeof opts.renderScale === "number") { scale = opts.renderScale; }
      var w = Math.max(1, Math.round(cssW * scale));
      var h = Math.max(1, Math.round(cssH * scale));
      var maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      w = Math.min(w, maxTex); h = Math.min(h, maxTex);
      if (w !== vw || h !== vh) {
        vw = w; vh = h;
        canvas.width = w; canvas.height = h;
        dirty = true;
      }
    }

    function draw() {
      var t0 = (performance && performance.now) ? performance.now() : 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, vw, vh);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA.tex);
      gl.activeTexture(gl.TEXTURE1);
      /* Toujours une texture complète sur l'unité 1, même sans fondu : certains
         pilotes refusent un échantillonneur non initialisé à la validation. */
      gl.bindTexture(gl.TEXTURE_2D, texB ? texB.tex : texA.tex);

      var fovNow = hfov;
      var mixNow = 0;
      if (fade) {
        var ft = clamp((fade.now - fade.t0) / fade.ms, 0, 1);
        mixNow = smooth01(ft);
        /* Très légère poussée de champ : la vue « avance » de 3,5 % pendant le
           fondu puis se stabilise. Sans ce mouvement le fondu ressemble à un
           bug d'affichage ; avec lui on lit un déplacement. */
        fovNow = hfov * (1 + 0.035 * (1 - easeOut(ft)));
        fovNow = clamp(fovNow, HFOV_MIN * 0.9, HFOV_MAX * 1.1);
      }

      var th = Math.tan(fovNow * 0.5);
      var tv = th * (cssH / Math.max(1, cssW));
      basis(yaw, pitch, mat);
      gl.uniformMatrix3fv(uBasis, false, mat);
      gl.uniform2f(uScale, th, tv);
      gl.uniform2f(uPix, 2 / vw, 2 / vh);
      gl.uniform1f(uMixLoc, mixNow);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frames++;
      lastDrawMs = ((performance && performance.now) ? performance.now() : 0) - t0;
    }

    /* --------------------------------------------------------- pastilles */

    /* Une pastille éteinte est invisible à l'œil, mais un `opacity: 0` ne la
       retire ni du parcours de tabulation ni de ce qu'annonce un lecteur
       d'écran : on tomberait au clavier sur un rangement situé derrière soi,
       sans rien voir bouger. On la retire donc explicitement. */
    function hidePin(el) {
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
      if (el.tabIndex !== -1) { el.tabIndex = -1; }
      if (el.getAttribute("aria-hidden") !== "true") { el.setAttribute("aria-hidden", "true"); }
    }

    function showPin(el) {
      if (el.tabIndex !== 0) { el.tabIndex = 0; }
      if (el.hasAttribute("aria-hidden")) { el.removeAttribute("aria-hidden"); }
    }

    function updatePins() {
      if (!pinLayer) { return; }
      var kids = pinLayer.children;
      var n = Math.min(kids.length, pins.length);
      basis(yaw, pitch, mat);
      var th = tanHalfH(), tv = tanHalfV();
      var i;
      for (i = 0; i < kids.length; i++) {
        var el = kids[i];
        var p = i < n ? pins[i] : null;
        if (!p) { hidePin(el); continue; }
        var l = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
        var dx = p.x / l, dy = p.y / l, dz = p.z / l;
        var cz = dx * mat[6] + dy * mat[7] + dz * mat[8];
        /* Derrière la caméra (ou rasant le plan image) : la division par cz
           projetterait la pastille à l'infini, et pire, un point à l'arrière
           réapparaîtrait symétriquement à l'écran. */
        if (cz <= 0.01) { hidePin(el); continue; }
        var cx = dx * mat[0] + dy * mat[1] + dz * mat[2];
        var cy = dx * mat[3] + dy * mat[4] + dz * mat[5];
        var sx = (cx / cz / th * 0.5 + 0.5) * cssW;
        var sy = (0.5 - cy / cz / tv * 0.5) * cssH;
        var m = Math.max(cssW, cssH) * 0.35;
        if (sx < -m || sy < -m || sx > cssW + m || sy > cssH + m) {
          hidePin(el); continue;
        }
        el.style.transform = "translate(-50%,-50%) translate(" + sx.toFixed(1) + "px," + sy.toFixed(1) + "px)";
        /* Fondu sur les 6 derniers degrés avant la disparition : une pastille
           qui s'éteint net au bord du champ trahit la projection. */
        el.style.opacity = String(clamp((cz - 0.01) / 0.1, 0, 1).toFixed(3));
        el.style.pointerEvents = "auto";
        showPin(el);
      }
    }

    /* ------------------------------------------------------- boucle rAF */

    function busy() {
      return !!anim || !!fade || Math.abs(vYaw) > 1e-4 || Math.abs(vPitch) > 1e-4 ||
             Math.abs(hfovTarget - hfov) > 1e-5 || dragging || keysHeld > 0 || gyroOn;
    }

    function wake() {
      dirty = true;
      if (!running && !disposed) {
        running = true;
        lastT = 0;
        rafId = requestAnimationFrame(tick);
      }
    }

    function applyPitch(p) {
      return clamp(p, -PITCH_HARD, PITCH_HARD);
    }

    function tick(now) {
      if (disposed) { return; }

      /* L'application déplace parfois le canevas d'un arbre DOM à un autre en
         cours de rendu (ex. rattachement à une autre mise en page) : il se
         retrouve détaché pendant une ou quelques frames. On saute simplement
         le dessin tant qu'il en est ainsi, sans casser la boucle rAF — un
         getBoundingClientRect() sur un noeud détaché est nul et dessiner
         dessus écraserait la vue. On n'abandonne la boucle que si la
         déconnexion se prolonge (~2 s) : passé ce délai, il est plus probable
         que le canevas ait été retiré pour de bon, et tourner indéfiniment à
         vide gâcherait du CPU/de la batterie pour rien. */
      if (!canvas.isConnected) {
        if (!detachedSince) { detachedSince = now; }
        if (now - detachedSince > 2000) {
          running = false;
          return;
        }
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (detachedSince) {
        detachedSince = 0;
        dirty = true;                  /* le rattachement a pu changer la taille */
      }

      var dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
      lastT = now;

      if (anim) {
        var at = clamp((now - anim.t0) / anim.ms, 0, 1);
        var e = easeOut(at);
        yaw = anim.y0 + anim.dy * e;
        pitch = applyPitch(anim.p0 + anim.dp * e);
        if (anim.dh) { hfov = anim.h0 + anim.dh * e; hfovTarget = hfov; }
        dirty = true;
        if (at >= 1) { anim = null; }
      } else if (!dragging) {
        if (Math.abs(vYaw) > 1e-4 || Math.abs(vPitch) > 1e-4) {
          /* Décroissance exponentielle indexée sur le temps réel : le glissé
             s'arrête de la même façon à 30 ou à 120 images par seconde. */
          var k = Math.exp(-dt * 4.2);
          yaw += vYaw * dt;
          var np = pitch + vPitch * dt;
          if (np > PITCH_HARD || np < -PITCH_HARD) { vPitch = 0; }
          pitch = applyPitch(np);
          vYaw *= k; vPitch *= k;
          if (Math.abs(vYaw) < 0.004) { vYaw = 0; }
          if (Math.abs(vPitch) < 0.004) { vPitch = 0; }
          dirty = true;
        }
      }

      if (keysHeld > 0) { applyKeys(dt); }

      if (Math.abs(hfovTarget - hfov) > 1e-5) {
        hfov += (hfovTarget - hfov) * (1 - Math.exp(-dt * 14));
        dirty = true;
      }

      if (fade) {
        fade.now = now;
        dirty = true;
        if (now - fade.t0 >= fade.ms) {
          /* La bascule ne se fait qu'une fois le fondu à 100 % dessiné, sinon
             une image à mix=1 suivie d'une image source A produirait un
             clignotement d'une frame. */
          var old = texA;
          texA = texB; texB = null;
          gl.deleteTexture(old.tex);
          fade = null;
          dirty = true;
        }
      }

      if (dirty) {
        resize();
        draw();
        updatePins();
        dirty = false;
      }

      if (busy()) {
        rafId = requestAnimationFrame(tick);
      } else {
        /* Rien ne bouge : on rend la main au navigateur. Une boucle rAF
           permanente sur un panorama statique vide la batterie pour rien. */
        running = false;
      }
    }

    /* ------------------------------------------------------------ entrées */

    var dragging = false;
    var pointers = {};
    var pointerCount = 0;
    var dragMoved = 0;
    var lastPos = null;
    var pinchStart = null;
    var lastTapT = 0, lastTapX = 0, lastTapY = 0;
    var keysHeld = 0;
    var keys = {};

    function localNdc(clientX, clientY) {
      var r = canvas.getBoundingClientRect();
      var nx = ((clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
      var ny = 1 - ((clientY - r.top) / Math.max(1, r.height)) * 2;
      return [nx, ny];
    }

    function inCanvas(clientX, clientY) {
      var r = canvas.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    }

    function pitchDamp(p) {
      /* Le facteur tombe à zéro à la butée : le glissé se fige en douceur au
         lieu de buter. */
      var a = Math.abs(p);
      if (a < PITCH_SOFT) { return 1; }
      return 1 - smooth01((a - PITCH_SOFT) / (PITCH_HARD - PITCH_SOFT));
    }

    function dragBy(ndcFrom, ndcTo) {
      var th = tanHalfH(), tv = tanHalfV();
      /* Rotation exacte pour que le point de l'image reste sous le doigt :
         l'angle d'un point écran vaut atan(ndc * tan(fov/2)), pas ndc * fov/2.
         Sans cette correction le panorama « glisse » sous le doigt en grand
         champ, ce qui est le premier défaut qu'on voit face à Street View. */
      var dy = Math.atan(ndcTo[0] * th) - Math.atan(ndcFrom[0] * th);
      var dp = Math.atan(ndcTo[1] * tv) - Math.atan(ndcFrom[1] * tv);
      var damp = pitchDamp(pitch + dp * 0);
      yaw -= dy;
      var want = pitch - dp * (dp * pitch > 0 ? damp : 1);
      pitch = applyPitch(want);
      return [-dy, -(dp * (dp * pitch > 0 ? damp : 1))];
    }

    function onPointerDown(e) {
      if (disposed) { return; }
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      pointerCount++;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
      if (pointerCount === 1) {
        dragging = true;
        dragMoved = 0;
        vYaw = 0; vPitch = 0;
        anim = null;
        lastPos = { x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now() };
      } else if (pointerCount === 2) {
        dragging = false;
        pinchStart = pinchState();
      }
      if (canvas.focus) { canvas.focus({ preventScroll: true }); }
      e.preventDefault();
      wake();
    }

    function pinchState() {
      var ids = Object.keys(pointers);
      if (ids.length < 2) { return null; }
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var dx = a.x - b.x, dy = a.y - b.y;
      return { d: Math.max(1, Math.sqrt(dx * dx + dy * dy)), hfov: hfov };
    }

    function onPointerMove(e) {
      if (disposed || !pointers[e.pointerId]) { return; }
      pointers[e.pointerId].x = e.clientX;
      pointers[e.pointerId].y = e.clientY;

      if (pointerCount >= 2) {
        var st = pinchState();
        if (st && pinchStart) {
          hfovTarget = clamp(pinchStart.hfov * (pinchStart.d / st.d), HFOV_MIN, HFOV_MAX);
          hfov = hfovTarget;               /* le pincement doit coller aux doigts */
          dirty = true;
          wake();
        }
        return;
      }
      if (!dragging || !lastPos) { return; }
      var from = localNdc(lastPos.x, lastPos.y);
      var to = localNdc(e.clientX, e.clientY);
      var d = dragBy(from, to);
      var t = e.timeStamp || performance.now();
      var dt = Math.max(1, t - lastPos.t) / 1000;
      dragMoved += Math.abs(e.clientX - lastPos.x) + Math.abs(e.clientY - lastPos.y);
      /* Vitesse lissée : une moyenne glissante évite qu'un dernier événement
         parasite (doigt qui s'immobilise avant de se lever) lance la vue. */
      var iy = d[0] / dt, ip = d[1] / dt;
      vYaw = vYaw * 0.7 + iy * 0.3;
      vPitch = vPitch * 0.7 + ip * 0.3;
      lastPos = { x: e.clientX, y: e.clientY, t: t };
      dirty = true;
      wake();
    }

    function onPointerUp(e) {
      if (!pointers[e.pointerId]) { return; }
      delete pointers[e.pointerId];
      pointerCount = Math.max(0, pointerCount - 1);
      if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} }
      /* Quand un doigt se lève alors qu'il en reste au moins deux au sol, la
         paire qui pilote le zoom change : `pinchState()` mesure désormais une
         distance entre deux AUTRES doigts, sans rapport avec celle qui avait
         servi de référence. Sans réarmement, le champ saute — 40° mesurés. On
         repart donc de la nouvelle paire, au champ courant. */
      if (pointerCount < 2) { pinchStart = null; }
      else { pinchStart = pinchState(); }
      if (pointerCount === 0) {
        var wasDragging = dragging;
        dragging = false;
        if (wasDragging && dragMoved < 8) {
          vYaw = 0; vPitch = 0;
          handleTap(e);
        } else if (wasDragging) {
          /* Si le doigt s'est arrêté avant le relâchement, pas d'inertie. */
          var age = (e.timeStamp || performance.now()) - (lastPos ? lastPos.t : 0);
          if (age > 90) { vYaw = 0; vPitch = 0; }
          vYaw = clamp(vYaw, -6, 6);
          vPitch = clamp(vPitch, -6, 6);
        }
        lastPos = null;
      } else if (pointerCount === 1) {
        var ids = Object.keys(pointers);
        var p = pointers[ids[0]];
        dragging = true;
        lastPos = { x: p.x, y: p.y, t: e.timeStamp || performance.now() };
      }
      wake();
    }

    function handleTap(e) {
      var now = e.timeStamp || performance.now();
      var isDouble = (now - lastTapT) < 320 &&
                     Math.abs(e.clientX - lastTapX) < 28 &&
                     Math.abs(e.clientY - lastTapY) < 28;
      lastTapT = now; lastTapX = e.clientX; lastTapY = e.clientY;
      if (isDouble) {
        lastTapT = 0;
        reframe(e.clientX, e.clientY);
        return;
      }
      if (picking && typeof opts.onPick === "function") {
        var p = api.pick(e.clientX, e.clientY);
        if (p) { opts.onPick(p); }
      }
    }

    function reframe(clientX, clientY) {
      var n = localNdc(clientX, clientY);
      var d = dirFromNdc(n[0], n[1]);
      /* Deux états seulement : rapproché sur le point visé, ou cadrage
         d'origine. Un double-tape qui zoome sans fin serait impossible à
         annuler d'une main. */
      var zoomed = hfovTarget < startHfov * 0.8;
      var h = zoomed ? startHfov : clamp(startHfov * 0.5, HFOV_MIN, HFOV_MAX);
      animateTo(yawOf(d), zoomed ? 0 : pitchOf(d), h, 480);
    }

    function animateTo(ty, tp, th, ms) {
      anim = {
        t0: (performance && performance.now) ? performance.now() : Date.now(),
        ms: ms || 520,
        y0: yaw, dy: wrapPi(ty - yaw),
        p0: pitch, dp: applyPitch(tp) - pitch,
        h0: hfov, dh: (typeof th === "number") ? clamp(th, HFOV_MIN, HFOV_MAX) - hfov : 0
      };
      vYaw = 0; vPitch = 0;
      wake();
    }

    function onWheel(e) {
      e.preventDefault();
      var n = localNdc(e.clientX, e.clientY);
      var before = dirFromNdc(n[0], n[1]);
      /* Pas multiplicatif : un cran de molette change le champ du même
         pourcentage quel que soit le zoom courant. deltaMode 1 = lignes. */
      var unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
      var f = Math.exp((e.deltaY * unit) * 0.0016);
      hfovTarget = clamp(hfov * f, HFOV_MIN, HFOV_MAX);
      hfov = hfovTarget;
      /* On recale la vue pour que le point sous le curseur ne bouge pas :
         c'est le comportement de toutes les cartes, et son absence donne
         l'impression que le zoom « dérape ». */
      var ty = yawOf(before) - Math.atan(n[0] * tanHalfH());
      var tp = pitchOf(before) - Math.atan(n[1] * tanHalfV() / Math.sqrt(1 + n[0] * n[0] * tanHalfH() * tanHalfH()));
      yaw = ty;
      pitch = applyPitch(tp);
      dirty = true;
      wake();
    }

    function onKeyDown(e) {
      var k = e.key;
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
        if (!keys[k]) { keys[k] = 1; keysHeld++; }
        e.preventDefault();
        anim = null;
        wake();
      } else if (k === "+" || k === "=" ) {
        hfovTarget = clamp(hfovTarget / 1.18, HFOV_MIN, HFOV_MAX); e.preventDefault(); wake();
      } else if (k === "-" || k === "_") {
        hfovTarget = clamp(hfovTarget * 1.18, HFOV_MIN, HFOV_MAX); e.preventDefault(); wake();
      } else if (k === "Home" || k === "0") {
        api.reset(); e.preventDefault();
      }
    }

    function onKeyUp(e) {
      if (keys[e.key]) { delete keys[e.key]; keysHeld = Math.max(0, keysHeld - 1); }
    }

    function onBlur() { keys = {}; keysHeld = 0; }

    function applyKeys(dt) {
      /* Vitesse proportionnelle au champ : au zoom fort les flèches deviennent
         fines, sinon la navigation au clavier est inutilisable en gros plan. */
      var sp = hfov * 1.1 * dt;
      if (keys.ArrowLeft) { yaw -= sp; }
      if (keys.ArrowRight) { yaw += sp; }
      if (keys.ArrowUp) { pitch = applyPitch(pitch + sp * pitchDamp(pitch)); }
      if (keys.ArrowDown) { pitch = applyPitch(pitch - sp * pitchDamp(pitch)); }
      dirty = true;
    }

    var onResize = function () { dirty = true; wake(); };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    canvas.style.touchAction = "none";
    if (!canvas.hasAttribute("tabindex")) { canvas.setAttribute("tabindex", "0"); }
    if (!canvas.hasAttribute("role")) { canvas.setAttribute("role", "application"); }
    if (!canvas.hasAttribute("aria-label")) {
      canvas.setAttribute("aria-label",
        "Panoramique de la pièce. Flèches pour regarder autour, plus et moins pour le zoom.");
    }

    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(onResize);
      try { ro.observe(canvas); } catch (e2) { ro = null; }
    }

    /* ------------------------------------------------------- gyroscope */

    var gyroOn = false;
    var gyroRef = null;

    function screenAngle() {
      var o = window.screen && window.screen.orientation;
      if (o && typeof o.angle === "number") { return o.angle * DEG; }
      return ((window.orientation || 0) * DEG);
    }

    function onOrient(e) {
      if (!gyroOn || e.alpha === null || e.alpha === undefined) { return; }
      var a = e.alpha * DEG, b = e.beta * DEG, g = e.gamma * DEG;
      /* Euler ZXY du référentiel appareil -> quaternion. */
      var ca = Math.cos(a / 2), sa = Math.sin(a / 2);
      var cb = Math.cos(b / 2), sb = Math.sin(b / 2);
      var cg = Math.cos(g / 2), sg = Math.sin(g / 2);
      var qx = sb * cg * ca - cb * sg * sa;
      var qy = cb * sg * ca + sb * cg * sa;
      var qz = cb * cg * sa + sb * sg * ca;
      var qw = cb * cg * ca - sb * sg * sa;
      /* Rotation d'écran (paysage) puis -90° autour de X : l'écran regarde
         l'horizon quand le téléphone est tenu droit, pas le sol. */
      var s = screenAngle();
      var cs = Math.cos(-s / 2), ss = Math.sin(-s / 2);
      var rx = qx * cs + qy * ss, ry = qy * cs - qx * ss;
      var rz = qz * cs + qw * ss, rw = qw * cs - qz * ss;
      var h = Math.SQRT1_2;
      var mx = rw * -h + rx * h, my = ry * h + rz * -h;
      var mz = rz * h + ry * h, mw = rw * h - rx * -h;
      /* Vecteur avant = q * (0,0,-1) * q^-1. */
      var fx = -2 * (mx * mz + mw * my);
      var fy = -2 * (my * mz - mw * mx);
      var fz = -(1 - 2 * (mx * mx + my * my));
      var l = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      var gy2 = Math.atan2(fx / l, -fz / l);
      var gp = Math.asin(clamp(fy / l, -1, 1));
      if (!gyroRef) {
        /* On mémorise l'écart au moment de l'activation : la vue ne saute pas
           à l'azimut magnétique, elle reprend là où l'utilisateur en était. */
        gyroRef = { dy: wrapPi(yaw - gy2), dp: pitch - gp };
      }
      var ty = gy2 + gyroRef.dy, tp = clamp(gp + gyroRef.dp, -PITCH_HARD, PITCH_HARD);
      /* Lissage : les capteurs sont bruités, un suivi direct fait vibrer. */
      yaw += wrapPi(ty - yaw) * 0.18;
      pitch += (tp - pitch) * 0.18;
      dirty = true;
      wake();
    }

    function setGyro(on) {
      if (!on) {
        gyroOn = false; gyroRef = null;
        window.removeEventListener("deviceorientation", onOrient);
        return Promise.resolve(false);
      }
      var DOE = window.DeviceOrientationEvent;
      if (!DOE) { return Promise.resolve(false); }
      function attach() {
        gyroOn = true; gyroRef = null;
        window.addEventListener("deviceorientation", onOrient);
        wake();
        return true;
      }
      /* iOS 13+ exige un appel depuis un geste utilisateur : setGyro(true) doit
         donc être appelé dans le gestionnaire de clic, pas au chargement. */
      if (typeof DOE.requestPermission === "function") {
        return DOE.requestPermission().then(function (r) {
          return r === "granted" ? attach() : false;
        })["catch"](function () { return false; });
      }
      return Promise.resolve(attach());
    }

    /* ------------------------------------------------------------- API */

    var api = {
      kind: "pano",
      count: srcSize[0] * srcSize[1],

      reset: function () {
        animateTo(0, 0, startHfov, 420);
      },

      orbit: function (dyaw) {
        if (typeof dyaw !== "number" || !isFinite(dyaw)) { return; }
        anim = null;
        yaw += dyaw;
        dirty = true;
        wake();
      },

      focusOn: function (point) {
        if (!point) { return; }
        var l = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z);
        if (!l) { return; }
        var d = [point.x / l, point.y / l, point.z / l];
        animateTo(yawOf(d), pitchOf(d), 0, 520);
      },

      setPins: function (points) {
        pins = (points && points.slice) ? points.slice(0) : [];
        dirty = true;
        wake();
      },

      setPicking: function (on) {
        picking = !!on;
        canvas.style.cursor = picking ? "crosshair" : "grab";
      },

      pick: function (clientX, clientY) {
        if (disposed || !inCanvas(clientX, clientY)) { return null; }
        var n = localNdc(clientX, clientY);
        var d = dirFromNdc(n[0], n[1]);
        return { x: d[0] * SPHERE_R, y: d[1] * SPHERE_R, z: d[2] * SPHERE_R };
      },

      crossfadeTo: function (nextSource, ms) {
        if (disposed || !nextSource) { return; }
        if (fade) {
          /* Un fondu déjà en cours : on le termine instantanément plutôt que
             d'empiler trois textures, sinon un enchaînement rapide de pièces
             laisse voir la plus ancienne. */
          var old = texA;
          texA = texB; texB = null; fade = null;
          gl.deleteTexture(old.tex);
        }
        var t = makeTexture(nextSource);
        if (!t) { return; }
        if (texB) { gl.deleteTexture(texB.tex); }
        texB = t;
        var size = sourceSize(nextSource);
        api.count = size[0] * size[1];
        fade = {
          t0: (performance && performance.now) ? performance.now() : Date.now(),
          ms: (typeof ms === "number" && ms > 0) ? ms : FADE_MS
        };
        fade.now = fade.t0;
        /* Première image du fondu dessinée tout de suite : si on attendait la
           prochaine frame rAF, le canvas garderait l'image précédente le temps
           d'un battement, ce qui se lit comme un à-coup. */
        dirty = true;
        wake();
      },

      setGyro: setGyro,

      /* Diagnostic (HUD, tests) — hors contrat, sans effet de bord. */
      state: function () {
        return {
          yaw: yaw, pitch: pitch, hfov: hfov, vYaw: vYaw, vPitch: vPitch,
          frames: frames, lastDrawMs: lastDrawMs,
          aniso: anisoMax, anisoUsed: anisoClamp,
          linearMips: mipsAreLinear,
          width: vw, height: vh,
          gyro: gyroOn, fading: !!fade,
          source: srcSize[0] + "x" + srcSize[1]
        };
      },

      dispose: function () {
        if (disposed) { return; }
        disposed = true;
        running = false;
        if (rafId) { cancelAnimationFrame(rafId); }
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("keydown", onKeyDown);
        canvas.removeEventListener("keyup", onKeyUp);
        canvas.removeEventListener("blur", onBlur);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("deviceorientation", onOrient);
        if (ro) { try { ro.disconnect(); } catch (e3) {} }
        if (texA) { gl.deleteTexture(texA.tex); }
        if (texB) { gl.deleteTexture(texB.tex); }
        gl.deleteFramebuffer(mipFbo);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(prog);
        gl.deleteProgram(mipProg);
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) { lose.loseContext(); }
      }
    };

    canvas.style.cursor = "grab";
    resize();
    wake();
    return api;
  }

  window.FulmoPanoView = create;
}());

