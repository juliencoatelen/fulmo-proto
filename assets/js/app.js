(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════════════
     Prototype FULMO.

     Tout vit dans le navigateur : chaque visiteur a son propre logement,
     stocké en local, et rien ne part sur un serveur. C'est le bon choix pour
     une démonstration — deux personnes qui ouvrent le lien ne doivent pas
     partager le même foyer — et cela permet de tester hors ligne.

     Deux exceptions, et seulement sur action explicite : le Scan Éclair et la
     recherche en langage naturel appellent Claude via la capacité `sample`.
     Comme dans la vraie application, la recherche IA n'envoie QUE la phrase
     tapée ; l'inventaire ne quitte jamais l'appareil.
     ═══════════════════════════════════════════════════════════════════════ */

  var STORE_KEY = "fulmo.demo.v2";
  var root = document.getElementById("root");
  var sampleApi = null;      // résolu plus tard, ou null
  var sampleImages = null;   // limites d'image si disponibles
  var sampleChecked = false; // les limites ont répondu (disponibles ou non)
  var downloadsApi = null;   // remise d'un fichier au visiteur, ou null

  /* ─── Persistance ─────────────────────────────────────────────────── */

  function blank() {
    return {
      account: null,
      plan: "free",
      planSeen: false,
      household: null,
      history: [],
      scans: [],
      locations: [],
      items: [],
      screen: "signup",
      tab: "search",
      theme: "light"
    };
  }

  var state = load();

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return blank();
      var parsed = JSON.parse(raw);
      var base = blank();
      Object.keys(base).forEach(function (key) {
        if (parsed[key] !== undefined) base[key] = parsed[key];
      });
      // Un réglage « système » enregistré par une version précédente : le
      // produit n'a plus que deux thèmes, et le blanc est celui par défaut.
      if (base.theme !== "dark") base.theme = "light";
      return base;
    } catch (e) {
      // Navigation privée, stockage bloqué, données corrompues : on repart
      // d'un état propre plutôt que de planter au chargement.
      return blank();
    }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  var seq = 0;
  function uid(prefix) { seq += 1; return prefix + "-" + Date.now().toString(36) + "-" + seq; }

  /* ─── Nuages de points : où ils vivent ────────────────────────────────

     Une pièce scannée pèse de quelques centaines de kilooctets à plusieurs
     mégaoctets. localStorage plafonne à cinq mégaoctets pour TOUT le
     prototype : on y garde donc le registre — quelques lignes de texte par
     scan — et les points partent dans IndexedDB, qui accepte les tableaux
     typés tels quels et se compte en centaines de mégaoctets.

     Un cache mémoire double le tout : rejouer une pièce déjà ouverte ne doit
     pas attendre le disque. */

  var scanStore = (function () {
    var opening = null;
    var memory = Object.create(null);

    function db() {
      if (opening) return opening;
      opening = new Promise(function (resolve, reject) {
        if (!window.indexedDB) return reject(new Error("indexedDB absent"));
        var request = indexedDB.open("fulmo", 1);
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains("clouds")) request.result.createObjectStore("clouds");
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
      return opening;
    }

    function tx(mode, run) {
      return db().then(function (handle) {
        return new Promise(function (resolve, reject) {
          var store = handle.transaction("clouds", mode).objectStore("clouds");
          var request = run(store);
          request.onsuccess = function () { resolve(request.result); };
          request.onerror = function () { reject(request.error); };
        });
      });
    }

    /* Deux formes de relevé y cohabitent, et IndexedDB les accepte toutes
       deux sans conversion : un nuage de points ({pos, col}, tableaux typés)
       et une panoramique ({pano}, un Blob d'image). Le clonage structuré les
       transporte tels quels — ni base64, ni sérialisation, ni perte. */
    return {
      put: function (id, record) {
        memory[id] = record;
        return tx("readwrite", function (s) { return s.put(record, id); })
          .catch(function () { /* on garde au moins la copie mémoire */ });
      },
      get: function (id) {
        if (memory[id]) return Promise.resolve(memory[id]);
        return tx("readonly", function (s) { return s.get(id); })
          .then(function (value) {
            if (!value) return null;
            memory[id] = value;
            return value;
          })
          .catch(function () { return null; });
      },
      del: function (id) {
        delete memory[id];
        return tx("readwrite", function (s) { return s["delete"](id); }).catch(function () {});
      }
    };
  })();

  /* Un relevé se lit d'abord par son GENRE : c'est lui qui décide du moteur de
     rendu, du geste de capture et de ce que l'on peut en faire. */
  function scanKind(scan) {
    if (!scan) return null;
    if (scan.kind) return scan.kind;
    return scan.source === "demo" ? "demo" : "cloud";   // relevés d'avant le genre
  }

  /* Un nuage : des positions en mètres, des couleurs en octets. Rien d'autre —
     ni normale ni covariance. C'est ce que rend un capteur de profondeur, et
     c'est assez pour reconnaître une pièce et y poser des repères. */
  function makeCloud(pos, col) {
    return { pos: pos, col: col || new Uint8Array(pos.length), count: pos.length / 3 };
  }

  function cloudBounds(cloud) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < cloud.count; i++) {
      for (var a = 0; a < 3; a++) {
        var v = cloud.pos[i * 3 + a];
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
      }
    }
    if (!isFinite(lo[0])) { lo = [-1, -1, -1]; hi = [1, 1, 1]; }
    return {
      lo: lo, hi: hi,
      mid: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
      size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    };
  }

  /* Recentrage. Un scan arrive dans le repère du téléphone au moment où la
     session s'ouvre : arbitraire, et différent à chaque capture. On ramène
     l'origine au milieu du sol, pour que la caméra s'ouvre toujours au bon
     endroit et que deux scans de la même pièce se superposent. */
  function recentreCloud(cloud) {
    var b = cloudBounds(cloud);
    for (var i = 0; i < cloud.count; i++) {
      cloud.pos[i * 3] -= b.mid[0];
      cloud.pos[i * 3 + 1] -= b.lo[1];
      cloud.pos[i * 3 + 2] -= b.mid[2];
    }
    return cloud;
  }

  /* Remise d'aplomb d'un fichier importé. Les exportateurs ne s'accordent pas
     sur l'axe vertical — Y chez les uns, Z chez les autres, parfois vers le
     bas. Plutôt que de deviner en silence, on propose la bascule à l'écran de
     relecture : l'utilisateur voit tout de suite laquelle est la bonne. */
  function orientCloud(cloud, up, flip) {
    var sign = flip ? -1 : 1;
    for (var i = 0; i < cloud.count; i++) {
      var x = cloud.pos[i * 3], y = cloud.pos[i * 3 + 1], z = cloud.pos[i * 3 + 2];
      if (up === "z") { cloud.pos[i * 3 + 1] = sign * z; cloud.pos[i * 3 + 2] = sign * y; }
      else { cloud.pos[i * 3 + 1] = sign * y; cloud.pos[i * 3 + 2] = sign * z; }
      cloud.pos[i * 3] = x;
    }
    return cloud;
  }

  function scanOf(locationId) {
    var found = null;
    (state.scans || []).forEach(function (scan) { if (scan.locationId === locationId) found = scan; });
    return found;
  }

  /* ─── Normalisation ───────────────────────────────────────────────────
     Réplique exacte de `fulmo_normalize` côté Postgres : les deux doivent
     rester alignés, sinon la démo et le produit ne trouvent pas les mêmes
     objets. */

  function norm(value) {
    return String(value == null ? "" : value)
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
  }

  function trigrams(value) {
    var padded = "  " + value + " ";
    var set = Object.create(null);
    for (var i = 0; i < padded.length - 2; i++) set[padded.slice(i, i + 3)] = true;
    return set;
  }

  /* Coefficient de Dice sur les trigrammes — c'est ce que fait pg_trgm, et
     c'est ce qui rattrape « mollette » pour « molette ». */
  function similarity(a, b) {
    if (!a || !b) return 0;
    var A = trigrams(a), B = trigrams(b);
    var keysA = Object.keys(A), keysB = Object.keys(B);
    if (keysA.length === 0 || keysB.length === 0) return 0;
    var shared = 0;
    for (var i = 0; i < keysA.length; i++) if (B[keysA[i]]) shared += 1;
    return (2 * shared) / (keysA.length + keysB.length);
  }

  /* ─── Lieux ───────────────────────────────────────────────────────── */

  function locById(id) {
    for (var i = 0; i < state.locations.length; i++) if (state.locations[i].id === id) return state.locations[i];
    return null;
  }

  function pathOf(id) {
    var out = [], guard = 0, node = locById(id);
    while (node && guard < 12) { out.unshift(node.name); node = node.parentId ? locById(node.parentId) : null; guard += 1; }
    return out;
  }

  function childrenOf(id) {
    return state.locations.filter(function (l) { return l.parentId === id; });
  }

  function descendantIds(id) {
    var out = [id];
    childrenOf(id).forEach(function (child) { out = out.concat(descendantIds(child.id)); });
    return out;
  }

  /* ─── Recherche ───────────────────────────────────────────────────────
     Trois signaux combinés, comme dans la fonction SQL : plein texte pour les
     pluriels, préfixe pour la frappe en cours, trigrammes pour les fautes. Un
     mot-clé exact domine tout le reste. */

  function searchIndex(item) {
    return norm([
      item.name,
      item.description || "",
      (item.tags || []).join(" "),
      item.spot || "",
      pathOf(item.locationId).join(" "),
      item.lentTo || ""
    ].join(" "));
  }

  function search(query) {
    var q = norm(query);
    var items = state.items;

    if (!q) {
      return items.slice().sort(function (a, b) {
        return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
      }).map(function (item) { return { item: item, score: 0, reason: "recent" }; });
    }

    var words = q.split(" ").filter(Boolean);
    var scored = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var name = norm(item.name);
      var index = searchIndex(item);
      var tags = (item.tags || []).map(norm);

      var score = 0, reason = null;

      if (tags.indexOf(q) !== -1) { score += 4; reason = "tag"; }
      else if (tags.some(function (t) { return t.indexOf(q) === 0; })) { score += 2.6; reason = "tag"; }

      if (name === q) score += 3.2;
      else if (name.indexOf(q) === 0) { score += 2.2; reason = reason || "name"; }
      else if (name.indexOf(q) !== -1) { score += 1.6; reason = reason || "name"; }

      // Chaque mot retrouvé quelque part dans l'index compte : c'est ce qui
      // fait marcher « chargeur photo » sur « Chargeur Canon LP-E6 ».
      var hits = 0;
      for (var w = 0; w < words.length; w++) if (index.indexOf(words[w]) !== -1) hits += 1;
      if (hits > 0) {
        score += 1.2 * (hits / words.length);
        reason = reason || (hits === words.length ? "text" : null);
      }

      var sim = similarity(name, q);
      if (sim > 0.26) { score += sim * 2; reason = reason || "fuzzy"; }

      // Faute de frappe sur un seul mot d'une expression : on compare mot à mot.
      if (!reason && words.length > 1) {
        var best = 0;
        var nameWords = name.split(" ");
        for (var a = 0; a < words.length; a++) {
          for (var b = 0; b < nameWords.length; b++) best = Math.max(best, similarity(nameWords[b], words[a]));
        }
        if (best > 0.55) { score += best; reason = "fuzzy"; }
      }

      if (score > 0.45) scored.push({ item: item, score: score, reason: reason || "text" });
    }

    scored.sort(function (x, y) {
      return y.score - x.score || (y.item.lastSeenAt || 0) - (x.item.lastSeenAt || 0);
    });
    return scored;
  }

  /* ─── Alertes ─────────────────────────────────────────────────────── */

  function daysUntil(dateString) {
    if (!dateString) return null;
    var target = new Date(dateString + "T00:00:00");
    if (isNaN(target)) return null;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  function alerts() {
    var out = [];
    state.items.forEach(function (item) {
      var expiry = daysUntil(item.expiresAt);
      if (expiry !== null && expiry <= 30) out.push({ item: item, kind: "expiry", days: expiry });

      var warranty = daysUntil(item.warrantyUntil);
      if (warranty !== null && warranty >= 0 && warranty <= 60) out.push({ item: item, kind: "warranty", days: warranty });

      if (item.lentTo && item.lentAt) {
        var days = Math.round((Date.now() - item.lentAt) / 86400000);
        if (days >= 21) out.push({ item: item, kind: "lent", days: days });
      }
    });
    out.sort(function (a, b) { return a.days - b.days; });
    return out;
  }

  /* ─── Presets ─────────────────────────────────────────────────────── */

  var ROOMS = [
    { key: "cuisine",   label: "Cuisine",          icon: "r-cuisine", kind: "room", common: true,  suggests: ["Placard haut", "Tiroir à couverts", "Sous l'évier"] },
    { key: "salon",     label: "Salon",            icon: "r-salon", kind: "room", common: true,  suggests: ["Buffet", "Bibliothèque"] },
    { key: "chambre",   label: "Chambre",          icon: "r-chambre", kind: "room", common: true,  suggests: ["Armoire", "Table de chevet", "Sous le lit"] },
    { key: "sdb",       label: "Salle de bain",    icon: "r-sdb", kind: "room", common: true,  suggests: ["Armoire à pharmacie", "Placard"] },
    { key: "entree",    label: "Entrée",           icon: "r-entree", kind: "room", common: true,  suggests: ["Placard", "Coffre"] },
    { key: "bureau",    label: "Bureau",           icon: "r-bureau", kind: "room", common: true,  suggests: ["Bureau", "Bibliothèque", "Meuble à tiroirs"] },
    { key: "enfant",    label: "Chambre d'enfant", icon: "r-enfant", kind: "room", suggests: ["Armoire", "Bac de rangement"] },
    { key: "sam",       label: "Salle à manger",   icon: "r-sam", kind: "room", suggests: ["Buffet"] },
    { key: "wc",        label: "WC",               icon: "r-wc", kind: "room", suggests: ["Étagère"] },
    { key: "buanderie", label: "Buanderie",        icon: "r-buanderie", kind: "room", suggests: ["Étagère", "Placard"] },
    { key: "dressing",  label: "Dressing",         icon: "r-dressing", kind: "room", suggests: ["Armoire", "Étagère"] },
    { key: "cellier",   label: "Cellier",          icon: "r-cellier", kind: "room", suggests: ["Étagère", "Bac de rangement"] },
    { key: "garage",    label: "Garage",           icon: "r-garage", kind: "zone", suggests: ["Rack mural", "Servante à outils", "Étagère"] },
    { key: "cave",      label: "Cave",             icon: "r-cave", kind: "zone", suggests: ["Rack", "Étagère"] },
    { key: "grenier",   label: "Grenier",          icon: "r-grenier", kind: "zone", suggests: ["Étagère A", "Étagère B", "Valises"] },
    { key: "cabanon",   label: "Cabanon",          icon: "r-cabanon", kind: "zone", suggests: ["Servante à outils", "Étagère"] },
    { key: "atelier",   label: "Atelier",          icon: "r-atelier", kind: "zone", suggests: ["Servante à outils", "Rack mural"] },
    { key: "jardin",    label: "Jardin",           icon: "r-jardin", kind: "zone", suggests: ["Coffre de terrasse", "Abri à vélos"] },
    { key: "terrasse",  label: "Terrasse",         icon: "r-terrasse", kind: "zone", suggests: ["Coffre"] },
    { key: "balcon",    label: "Balcon",           icon: "r-balcon", kind: "zone", suggests: ["Coffre"] },
    { key: "couloir",   label: "Couloir",          icon: "r-couloir", kind: "room", suggests: ["Placard"] },
    { key: "veranda",   label: "Véranda",          icon: "r-veranda", kind: "room", suggests: ["Coffre"] },
    { key: "debarras",  label: "Débarras",         icon: "r-debarras", kind: "room", suggests: ["Étagère", "Carton"] },
    { key: "soussol",   label: "Sous-sol",         icon: "r-soussol", kind: "zone", suggests: ["Étagère", "Bac de rangement"] }
  ];

  /* Catalogue de meubles.

     Chaque entrée porte un dessin et une phrase qui dit ce qui la DISTINGUE
     des voisines : « armoire », « placard » et « commode » désignent trois
     objets différents que les mots seuls ne séparent pas. Le dessin tranche en
     un coup d'œil, la phrase confirme. */
  var FURNITURE = [
    { key: "armoire",    label: "Armoire",             pic: "f-armoire",   hint: "Haute, avec des portes et des pieds. Penderie ou étagères dedans.", common: true },
    { key: "placard",    label: "Placard",             pic: "f-placard",   hint: "Encastré dans le mur, du sol au plafond. Ne se déplace pas.", common: true },
    { key: "commode",    label: "Commode",             pic: "f-commode",   hint: "Basse et large, uniquement des tiroirs. Pas de portes.", common: true },
    { key: "tiroirs",    label: "Meuble à tiroirs",    pic: "f-tiroirs",   hint: "Étroit et haut, tiroirs empilés. Souvent sous un bureau.", common: true },
    { key: "etagere",    label: "Étagère",             pic: "f-etagere",   hint: "Ouverte, sans portes. On voit tout ce qui est posé dessus.", common: true },
    { key: "biblio",     label: "Bibliothèque",        pic: "f-biblio",    hint: "Étagères dans un caisson fermé sur les côtés." },
    { key: "buffet",     label: "Buffet",              pic: "f-buffet",    hint: "Bas et large : tiroirs en haut, portes en bas.", common: true },
    { key: "bureau",     label: "Bureau",              pic: "f-bureau",    hint: "Un plateau, et un caisson à tiroirs sur le côté." },
    { key: "chevet",     label: "Table de chevet",     pic: "f-chevet",    hint: "Petit meuble à côté du lit, un ou deux tiroirs." },
    { key: "coffre",     label: "Coffre",              pic: "f-coffre",    hint: "Se ferme par le dessus. Un seul grand volume." },
    { key: "servante",   label: "Servante à outils",   pic: "f-servante",  hint: "Tiroirs plats sur roulettes, pour l'outillage." },
    { key: "frigo",      label: "Réfrigérateur",       pic: "f-frigo",     hint: "Pour ce qui se conserve au froid." },
    { key: "congel",     label: "Congélateur",         pic: "f-congel",    hint: "Coffre ou armoire, s'ouvre souvent par le dessus." },
    { key: "bac",        label: "Bac de rangement",    pic: "f-bac",       hint: "Bac en plastique, empilable, sans couvercle rigide." },
    { key: "carton",     label: "Carton",              pic: "f-carton",    hint: "Boîte fermée par des rabats. Souvent au grenier ou à la cave." },
    { key: "valise",     label: "Valise",              pic: "f-valise",    hint: "Sert aussi de rangement quand elle ne voyage pas." },
    { key: "rack",       label: "Rack mural",          pic: "f-rack",      hint: "Fixé au mur, avec des crochets. Outils, vélos, câbles." },
    { key: "pharmacie",  label: "Armoire à pharmacie", pic: "f-pharmacie", hint: "Petit meuble mural, médicaments et soins." },
    { key: "souslit",    label: "Sous le lit",         pic: "f-souslit",   hint: "L'espace sous le lit, avec ou sans bacs." }
  ];

  function furnitureByLabel(label) {
    for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].label === label) return FURNITURE[i];
    return null;
  }

  /* Palette d'icônes. Volontairement courte et domestique : une liste de mille
     emoji fait perdre plus de temps qu'elle n'en fait gagner. */
  /* Palette d'icônes.

     Des pictogrammes du même jeu, pas des emoji : l'emoji change de dessin
     d'un système à l'autre, impose sa couleur, et jure avec tout le reste de
     l'interface. Quatre groupes, volontairement courts — une liste de mille
     symboles fait perdre plus de temps qu'elle n'en fait gagner. */
  var ICON_PALETTE = [
    ["Pièces", ["r-cuisine", "r-salon", "r-chambre", "r-enfant", "r-sdb", "r-wc", "r-bureau", "r-entree",
                "r-sam", "r-buanderie", "r-dressing", "r-cellier", "r-couloir", "r-veranda", "r-piece"]],
    ["Extérieur et annexes", ["r-garage", "r-cave", "r-grenier", "r-soussol", "r-cabanon", "r-atelier",
                              "r-jardin", "r-terrasse", "r-balcon", "r-debarras", "r-zone"]],
    ["Rangements", ["f-armoire", "f-placard", "f-commode", "f-etagere", "f-biblio", "f-buffet", "f-coffre",
                    "f-servante", "f-frigo", "f-bac", "f-carton", "f-valise", "f-rack", "f-pharmacie"]],
    ["Thèmes", ["t-noel", "t-ski", "t-camping", "t-sport", "t-jeux", "t-bebe", "t-papiers", "t-photo",
                "t-musique", "t-animal", "t-velo", "t-elec"]]
  ];
  var ICON_BY_KIND = { zone: "r-zone", room: "r-piece", furniture: "f-armoire", container: "f-carton" };

  /* ─── Jeu d'exemple ───────────────────────────────────────────────────
     Un prototype vide ne prouve rien : on ne peut pas tester une recherche
     sans rien à trouver. Ce logement est celui des maquettes du site. */

  function seedHousehold() {
    state.household = { name: "La maison", type: "house", floors: 2 };
    state.locations = [];
    state.items = [];

    function place(name, kind, parentId, icon, floor, space) {
      var node = { id: uid("loc"), parentId: parentId || null, kind: kind, name: name, icon: icon || null, floor: floor == null ? null : floor, space: space || null };
      state.locations.push(node);
      return node.id;
    }

    var cuisine  = place("Cuisine", "room", null, "r-cuisine", 0);
    var placard  = place("Placard haut", "furniture", cuisine);
    var tiroirC  = place("Tiroir à couverts", "furniture", cuisine);
    var salon    = place("Salon", "room", null, "r-salon", 0);
    var buffet   = place("Buffet", "furniture", salon);
    var tiroirB  = place("Tiroir bas", "container", buffet);
    var panier   = place("Panier câbles", "container", buffet);
    var biblio   = place("Bibliothèque", "furniture", salon);
    var chambre  = place("Chambre de Léa", "room", null, "r-chambre", 1);
    var commode  = place("Commode", "furniture", chambre);
    var tiroirH  = place("Tiroir du haut", "container", commode);
    var sousLit  = place("Sous le lit", "furniture", chambre);
    var sdb      = place("Salle de bain", "room", null, "r-sdb", 1);
    var pharma   = place("Armoire à pharmacie", "furniture", sdb);
    var bureau   = place("Bureau", "room", null, "r-bureau", 1);
    var meubleT  = place("Meuble à tiroirs", "furniture", bureau);
    var tiroirBu = place("Tiroir du haut", "container", meubleT);
    var placardB = place("Placard", "furniture", bureau);
    // Le grenier est la pièce scannée de la démonstration : ses rangements
    // portent déjà leur point dans le nuage, comme après un premier placement.
    var grenier  = place("Grenier", "zone", null, "r-grenier", 2);
    var etagereA = place("Étagère A", "furniture", grenier, null, null, { x: 1.10, y: 0.40, z: -2.14 });
    var etagereB = place("Étagère B", "furniture", grenier, null, null, { x: 2.70, y: 1.90, z: -2.14 });
    var bac1     = place("Bac 1", "container", etagereB, null, null, { x: 2.33, y: 1.28, z: -2.08 });
    var bac3     = place("Bac 3", "container", etagereB, null, null, { x: 1.31, y: 1.24, z: -2.08 });
    var cabanon  = place("Cabanon", "zone", null, "r-cabanon", 0);
    var servante = place("Servante à outils", "furniture", cabanon);
    var tiroir2  = place("Tiroir 2", "container", servante);
    var rack     = place("Rack mural", "furniture", cabanon);
    var jardin   = place("Jardin", "zone", null, "r-jardin", 0);
    var coffre   = place("Coffre de terrasse", "furniture", jardin);

    // Le scan de démonstration est rattaché au grenier comme n'importe quel
    // relevé : la vue 3D ne connaît qu'une sorte d'entrée.
    state.scans = [{ id: "demo", kind: "demo", locationId: grenier, source: "demo", count: 140460, capturedAt: Date.now() }];

    var now = Date.now();
    var day = 86400000;

    function iso(offsetDays) {
      return new Date(now + offsetDays * day).toISOString().slice(0, 10);
    }

    var seed = [
      ["Carton décorations de Noël", bac3, "Bac du fond", ["noël", "déco", "fragile"], "Guirlandes, boules et sujets", 1],
      ["Guirlande lumineuse 10 m", bac3, null, ["noël", "électrique"], "LED blanc chaud", 2],
      ["Étoile de sapin", bac1, null, ["noël", "déco"], null, 1],
      ["Nœuds de sapin", bac1, null, ["noël", "déco"], null, 24],
      ["Bougies rouges", tiroirB, null, ["noël", "déco"], null, 12],
      ["Papier cadeau et rubans", placardB, "Étagère haute", ["emballage", "noël"], null, 1],
      ["Clé à molette 30 mm", tiroir2, "Compartiment gauche", ["outillage"], "Grande taille", 1],
      ["Tournevis cruciforme", tiroir2, null, ["outillage"], "Jeu de 4", 4],
      ["Perceuse sans fil", servante, "Étagère du bas", ["outillage", "électrique"], "Deux batteries", 1],
      ["Boîte de vis 4 mm", servante, "Bac à visserie", ["outillage", "visserie"], null, 1],
      ["Mètre ruban 5 m", tiroir2, null, ["outillage"], null, 1],
      ["Pince coupante", tiroir2, null, ["outillage"], null, 1],
      ["Rallonge extérieure 15 m", rack, "Crochet 2", ["électricité", "jardin"], null, 1],
      ["Taille-haie", rack, null, ["jardin", "électrique"], null, 1],
      ["Passeport", tiroirBu, null, ["papiers", "urgent"], "Valable jusqu'en 2031", 1],
      ["Carnet de santé de Léa", tiroirBu, null, ["papiers", "santé"], null, 1],
      ["Livret de famille", tiroirBu, null, ["papiers"], null, 1],
      ["Chargeur Canon LP-E6", panier, "Pochette noire", ["photo", "câbles"], "Batterie reflex", 1],
      ["Câbles HDMI", panier, null, ["câbles"], null, 3],
      ["Chargeur universel USB-C", panier, null, ["câbles"], null, 2],
      ["Doliprane 1000 mg", pharma, "Étagère du haut", ["santé", "médicaments"], null, 2],
      ["Thermomètre", pharma, null, ["santé"], null, 1],
      ["Crème solaire indice 50", pharma, null, ["plage", "été", "santé"], null, 1],
      ["Trousse de secours", pharma, null, ["santé", "urgent"], null, 1],
      ["Chaussures de ski", sousLit, null, ["ski", "hiver", "sport"], "Pointure 38", 2],
      ["Combinaison de ski", sousLit, null, ["ski", "hiver"], null, 1],
      ["Masque et tuba", coffre, null, ["plage", "été"], null, 2],
      ["Parasol", coffre, null, ["plage", "été", "jardin"], null, 1],
      ["Pompe à matelas électrique", coffre, null, ["camping", "plage"], "Prise allume-cigare", 1],
      ["Matelas gonflable 2 places", etagereA, null, ["camping"], null, 1],
      ["Tente 4 places", etagereA, null, ["camping"], null, 1],
      ["Réchaud de camping", etagereA, null, ["camping"], null, 1],
      ["Moule à gâteau", placard, "Deuxième étagère", ["cuisine", "pâtisserie"], null, 2],
      ["Robot pâtissier", placard, null, ["cuisine", "pâtisserie"], null, 1],
      ["Couverts à poisson", tiroirC, null, ["cuisine"], null, 6],
      ["Jeux de société", biblio, "Étagère du bas", ["jeux"], null, 8],
      ["Albums photo", biblio, null, ["souvenirs"], null, 5],
      ["Vêtements de bébé 0-6 mois", commode, "Deux tiroirs du bas", ["bébé", "vêtements"], null, 1],
      ["Poussette pliante", grenier, "Contre le mur nord", ["bébé"], null, 1],
      ["Guirlande d'anniversaire", tiroirH, null, ["fête", "déco"], null, 1]
    ];

    seed.forEach(function (row, index) {
      state.items.push({
        id: uid("it"),
        name: row[0],
        locationId: row[1],
        spot: row[2],
        tags: row[3],
        description: row[4],
        quantity: row[5],
        expiresAt: null,
        warrantyUntil: null,
        lentTo: null,
        lentAt: null,
        lastSeenAt: now - index * 3600000,
        createdAt: now - index * 3600000
      });
    });

    // Quelques échéances, pour que la page Alertes ait de quoi dire.
    setItemField("Crème solaire indice 50", { expiresAt: iso(12) });
    setItemField("Doliprane 1000 mg", { expiresAt: iso(-8) });
    setItemField("Perceuse sans fil", { warrantyUntil: iso(41) });
    setItemField("Clé à molette 30 mm", { lentTo: "Marc", lentAt: now - 41 * day });
    setItemField("Robot pâtissier", { warrantyUntil: iso(18) });
  }

  function setItemField(name, patch) {
    state.items.forEach(function (item) {
      if (item.name === name) Object.keys(patch).forEach(function (key) { item[key] = patch[key]; });
    });
  }

  /* ─── Aides de rendu ──────────────────────────────────────────────── */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value == null || value === false) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "html") node.innerHTML = value;
        else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === "style") node.setAttribute("style", value);
        else node.setAttribute(key, value === true ? "" : String(value));
      });
    }
    // Les enfants peuvent arriver en tableau, en nœud seul ou en simple
    // chaîne : normaliser ici évite une exception à chaque appel distrait, et
    // une exception pendant le rendu laisse l'écran précédent à l'écran.
    var list = children == null ? [] : (Array.isArray(children) ? children : [children]);
    list.forEach(function (child) {
      if (child == null || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function icon(name, size) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    if (size) svg.setAttribute("style", "font-size:" + size + "px");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-" + name);
    svg.appendChild(use);
    return svg;
  }

  /* Les pictogrammes de meubles vivent dans le même sprite que les icônes,
     mais sur une grille de 48 : ils portent assez de détail pour qu'on
     reconnaisse une commode d'une armoire sans lire le mot. */
  /* Un seul aide pour tous les pictogrammes du sprite.

     Deux grilles cohabitent : 24 pour ce qui se lit dans une liste (pièces,
     thèmes, interface), 48 pour ce qui se regarde dans une carte (meubles,
     qui portent assez de détail pour qu'on distingue une commode d'une
     armoire). Le préfixe de l'identifiant suffit à choisir. */
  function sym(name, size) {
    var big = name.indexOf("f-") === 0;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", big ? "pic" : "icon");
    svg.setAttribute("viewBox", big ? "0 0 48 48" : "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (size) svg.setAttribute("style", "font-size:" + size + "px;width:" + size + "px;height:" + size + "px");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + name);
    svg.appendChild(use);
    return svg;
  }

  function pic(name) { return sym(name); }

  function logo(size) {
    return el("span", { class: "logo", style: "font-size:" + (size || 22) + "px", "aria-label": "FULMO" }, [
      el("span", { "aria-hidden": "true", text: "FULM" }),
      (function () {
        var wrap = document.createElement("span");
        wrap.innerHTML = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:block">' +
          '<circle cx="24" cy="24" r="19.8" stroke="currentColor" stroke-width="4.2"/>' +
          '<path d="M28.5 4.5 L13.5 27 h8.4 L19 43.5 L34.5 20 h-8.5 Z" fill="#d9ff3d" stroke="#050506" stroke-width="1.7" stroke-linejoin="round"/></svg>';
        wrap.style.display = "inline-flex";
        wrap.style.width = "0.92em";
        wrap.style.height = "0.92em";
        return wrap;
      })()
    ]);
  }

  var toastTimer = null;
  function toast(message) {
    var existing = document.querySelector(".toast");
    if (existing) existing.remove();
    var node = el("div", { class: "toast", role: "status", text: message });
    document.body.appendChild(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.remove(); }, 2600);
  }

  function plural(count, one, many) { return count + " " + (Math.abs(count) < 2 ? one : many); }

  /* ─── Modale générique ────────────────────────────────────────────── */

  var openSheet = null;

  function sheet(options) {
    closeSheet();

    var body = el("div", { class: "sheet-body" }, options.body || []);
    var card = el("div", {
      class: "sheet" + (options.wide ? " sheet-wide" : ""),
      role: "dialog", "aria-modal": "true", "aria-label": options.title
    }, [
      el("div", { class: "sheet-head" }, [
        el("h2", { class: "display t-md", text: options.title }),
        el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", onclick: function () { closeSheet(); if (options.onClose) options.onClose(); } }, [icon("x", 18)])
      ]),
      body,
      options.foot ? el("div", { class: "sheet-foot" }, options.foot) : null
    ]);

    var backdrop = el("div", {
      class: "sheet-backdrop",
      onclick: function (event) {
        if (event.target !== backdrop) return;
        closeSheet();
        if (options.onClose) options.onClose();
      }
    }, [card]);

    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";
    openSheet = { backdrop: backdrop, onClose: options.onClose };

    // Échappement et piège de focus : les deux choses qu'une modale doit faire
    // et que l'on oublie une fois sur deux.
    var previous = document.activeElement;
    var focusables = card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusables.length) focusables[Math.min(1, focusables.length - 1)].focus();

    openSheet.onKey = function (event) {
      if (event.key === "Escape") { event.preventDefault(); closeSheet(); if (options.onClose) options.onClose(); return; }
      if (event.key !== "Tab" || focusables.length === 0) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    openSheet.previous = previous;
    document.addEventListener("keydown", openSheet.onKey);
    return card;
  }

  function closeSheet() {
    if (!openSheet) return;
    document.removeEventListener("keydown", openSheet.onKey);
    openSheet.backdrop.remove();
    document.body.style.overflow = "";
    if (openSheet.previous && openSheet.previous.focus) openSheet.previous.focus();
    openSheet = null;
  }

  /* ─── Sélecteur de meubles ────────────────────────────────────────────
     Une poignée d'exemples ne couvre pas un logement réel, et une liste de
     mots ne dit pas ce qui sépare une armoire d'un placard. Le catalogue
     entier est donc consultable, chaque entrée porte son dessin et sa
     phrase, et tout ce qui manque s'ajoute à la main. */

  function furniturePicker(room, onDone, locked) {
    var locks = locked || [];
    var query = "";
    var grid = el("div", { class: "fpick-grid" });
    var counter = el("p", { class: "label", style: "color:var(--accent)" });

    function has(label) { return room.furniture.indexOf(label) !== -1; }

    function toggle(label) {
      room.furniture = has(label)
        ? room.furniture.filter(function (f) { return f !== label; })
        : room.furniture.concat([label]);
      paint();
    }

    function card(entry) {
      // Un meuble déjà créé reste visible mais figé : le décocher ici
      // supprimerait un rangement qui contient peut-être des objets.
      var already = locks.indexOf(entry.label) !== -1;
      var on = already || has(entry.label);
      return el("button", {
        class: "fpick-card" + (on ? " on" : ""), type: "button", disabled: already,
        "aria-pressed": on ? "true" : "false",
        onclick: already ? null : function () { toggle(entry.label); }
      }, [
        el("span", { class: "box" }, [pic(entry.pic)]),
        el("span", { class: "nm", text: entry.label }),
        el("span", { class: "hint", text: already ? "Déjà dans " + room.label + "." : entry.hint }),
        el("span", { class: "tick" + (on ? "" : " off") }, [icon("check", 15)])
      ]);
    }

    function paint() {
      var q = norm(query);
      var matches = function (text) { return !q || norm(text).indexOf(q) !== -1; };

      var cards = FURNITURE
        .filter(function (entry) { return matches(entry.label) || matches(entry.hint); })
        .map(card);

      // Les meubles saisis à la main ne sont pas au catalogue : sans cette
      // boucle ils disparaîtraient de la grille dès qu'on la rouvre.
      room.furniture.forEach(function (label) {
        if (furnitureByLabel(label) || !matches(label)) return;
        cards.push(card({ label: label, pic: "f-autre", hint: "Ajouté par vous." }));
      });

      grid.replaceChildren.apply(grid, cards.length ? cards : [
        el("p", { class: "loc-empty", text: "Aucun meuble ne correspond. Ajoutez-le ci-dessous." })
      ]);
      counter.textContent = room.furniture.length === 0
        ? "Aucun meuble pour l'instant"
        : plural(room.furniture.length, "meuble ajouté", "meubles ajoutés");
    }

    var custom = "";
    var addButton;

    function addCustom() {
      var label = custom.trim().slice(0, 80);
      if (!label || has(label) || locks.indexOf(label) !== -1) { custom = ""; return; }
      room.furniture = room.furniture.concat([label]);
      custom = "";
      customInput.value = "";
      addButton.disabled = true;
      paint();
      customInput.focus();
    }

    var customInput = el("input", {
      class: "input", style: "flex:1;min-width:180px", maxlength: 80,
      placeholder: "Autre meuble : « Malle du grenier », « Bac à jouets »…",
      "aria-label": "Ajouter un meuble qui n'est pas dans la liste",
      oninput: function (event) { custom = event.target.value; addButton.disabled = !custom.trim(); },
      onkeydown: function (event) { if (event.key === "Enter") { event.preventDefault(); addCustom(); } }
    });

    addButton = el("button", { class: "btn btn-line", type: "button", disabled: true, onclick: addCustom }, [icon("plus", 15), "Ajouter"]);

    paint();

    sheet({
      title: "Rangements — " + room.label,
      wide: true,
      onClose: onDone,
      body: [
        el("div", { class: "pick-search" }, [
          el("input", {
            class: "input", type: "search", placeholder: "Rechercher un meuble…",
            "aria-label": "Rechercher un meuble",
            oninput: function (event) { query = event.target.value; paint(); }
          })
        ]),
        grid,
        el("div", { class: "stack-sm" }, [
          el("p", { class: "label", text: "Il manque quelque chose ?" }),
          el("div", { class: "inline" }, [customInput, addButton])
        ]),
        counter
      ],
      foot: [
        el("button", {
          class: "btn btn-lg btn-volt", type: "button", style: "width:100%",
          onclick: function () { closeSheet(); onDone(); }
        }, "Terminer")
      ]
    });
  }

  /* ─── Sélecteur d'icône ───────────────────────────────────────────────
     L'icône n'est pas décorative : c'est ce que l'œil accroche en premier
     dans l'arborescence. Elle doit donc pouvoir être changée partout. */

  function iconPicker(options) {
    function choose(value) { closeSheet(); options.onPick(value); }

    var groups = ICON_PALETTE.map(function (group) {
      return el("div", { class: "stack-sm" }, [
        el("p", { class: "label", text: group[0] }),
        el("div", { class: "icon-grid" }, group[1].map(function (name) {
          var on = options.current === name;
          return el("button", {
            class: on ? "on" : null, type: "button", "aria-label": name,
            "aria-pressed": on ? "true" : "false",
            onclick: function () { choose(name); }
          }, [sym(name, 22)]);
        }))
      ]);
    });

    sheet({
      title: options.title || "Choisir une icône",
      body: groups.concat([
        el("button", {
          class: "btn btn-line", type: "button", style: "align-self:flex-start",
          onclick: function () { choose(null); }
        }, [icon("x", 15), "Icône par défaut"])
      ])
    });
  }

  /* ─── Choix d'un emplacement ──────────────────────────────────────────
     Une liste déroulante native devient illisible passé une trentaine de
     lignes, et un logement référencé en compte vite cent. Un champ de
     recherche filtre, la liste suit, et l'emplacement choisi reste affiché
     même quand le filtre l'exclut. */

  function locationField(options) {
    var current = options.value || null;
    var query = "";
    var list = el("div", { class: "loc-list", role: "listbox", "aria-label": options.label });
    var summary = el("span", { style: "font-size:.75rem;color:var(--faint)" });

    // Les endroits les PLUS PRÉCIS d'abord : un tiroir est une meilleure
    // réponse qu'une pièce, et c'est ce qu'on veut encourager.
    var places = state.locations.slice().sort(function (a, b) {
      return pathOf(b.id).length - pathOf(a.id).length || a.name.localeCompare(b.name);
    });

    function option(id) {
      var on = current === id;
      var path = id ? pathOf(id) : [];
      var parents = path.slice(0, -1).join(" / ");
      return el("button", {
        class: "loc-opt" + (on ? " on" : ""), type: "button", role: "option",
        "aria-selected": on ? "true" : "false",
        onclick: function () { current = id; options.onChange(id); paint(); }
      }, [
        el("span", { class: "lf", text: id ? path[path.length - 1] : "À ranger" }),
        el("span", { class: "up", text: id ? parents : "sans emplacement" }),
        on ? icon("check", 14) : null
      ]);
    }

    function paint() {
      var tokens = norm(query).split(" ").filter(function (t) { return t.length > 0; });

      var matches = places.filter(function (place) {
        if (tokens.length === 0) return true;
        var hay = norm(pathOf(place.id).join(" "));
        return tokens.every(function (token) { return hay.indexOf(token) !== -1; });
      });

      var rows = tokens.length === 0 ? [option(null)] : [];

      // La sélection courante reste visible même filtrée : sinon on ne sait
      // plus ce qui est choisi au moment où on tape.
      if (current && !matches.some(function (place) { return place.id === current; }) && locById(current)) {
        rows.push(option(current));
      }
      matches.slice(0, 80).forEach(function (place) { rows.push(option(place.id)); });
      if (rows.length === 0) rows.push(el("p", { class: "loc-empty", text: "Aucun lieu ne correspond." }));

      list.replaceChildren.apply(list, rows);
      summary.textContent = current
        ? "Choisi : " + pathOf(current).join(" / ")
        : "Aucun emplacement : l'objet restera dans « à ranger ».";

      if (tokens.length === 0 && current) {
        var selected = list.querySelector(".loc-opt.on");
        if (selected) list.scrollTop = Math.max(0, selected.offsetTop - list.clientHeight / 2 + selected.offsetHeight / 2);
      }
    }

    paint();

    return el("label", { class: "field" }, [
      el("span", { text: options.label }),
      el("input", {
        class: "input", type: "search",
        placeholder: options.placeholder || "Rechercher une pièce, un meuble…",
        oninput: function (event) { query = event.target.value; paint(); }
      }),
      list,
      summary
    ]);
  }

  /* ═══ Palette de recherche ═════════════════════════════════════════════

     Le référencement est le coût, la recherche est la valeur. Elle ne peut
     donc pas être un onglet parmi six : elle s'ouvre de partout, à ⌘K comme
     au doigt, par-dessus ce qu'on faisait.

     Elle ne cherche pas que des objets. Les lieux et les actions sont dans le
     même index, parce que « cave » veut dire « montre-moi la cave » aussi
     souvent que « trouve un objet nommé cave », et parce qu'on ouvre le
     référencement plus vite en le tapant qu'en le cherchant des yeux. */

  var cmdk = null;

  var CMDK_ACTIONS = [
    { label: "Référencer un objet", hint: "Ajouter quelque chose à l'inventaire", ic: "plus",
      keys: "nouvel objet ajouter referencer creer", run: function () { itemSheet(null); } },
    { label: "Mes lieux", hint: "L'arborescence du logement", ic: "grid",
      keys: "lieux pieces meubles arborescence", run: function () { goTab("places"); } },
    { label: "Scan Éclair", hint: "Photographier un rangement", ic: "scan", premium: true,
      keys: "scan photo camera ia", run: function () { goTab("scan"); } },
    { label: "Plan du logement", hint: "Vue d'ensemble", ic: "map", premium: true,
      keys: "plan carte map etage", run: function () { goTab("map"); } },
    { label: "Alertes", hint: "Péremptions, garanties, prêts", ic: "bell",
      keys: "alertes peremption garantie prete", run: function () { goTab("alerts"); } },
    { label: "Réglages", hint: "Foyer, membres, thème, abonnement", ic: "cog",
      keys: "reglages parametres theme foyer membres abonnement", run: function () { goTab("settings"); } }
  ];

  function goTab(id) { state.tab = id; save(); render(); }

  /* Met en évidence la portion trouvée. Sans ça on relit la ligne entière
     pour comprendre pourquoi elle est là. */
  function markMatch(text, query) {
    var wrap = document.createElement("span");
    var q = norm(query);
    if (!q) { wrap.textContent = text; return wrap; }
    var hay = norm(text);
    var at = hay.indexOf(q);
    // `norm` ne change pas la longueur (désaccentuation NFD mise à part, qui
    // retire des diacritiques combinants mais garde les lettres), donc les
    // index restent exploitables sur la chaîne d'origine dans la quasi-totalité
    // des cas. En cas de décalage, on retombe sur le texte brut.
    if (at < 0 || at + q.length > text.length) { wrap.textContent = text; return wrap; }
    wrap.appendChild(document.createTextNode(text.slice(0, at)));
    wrap.appendChild(el("mark", { text: text.slice(at, at + q.length) }));
    wrap.appendChild(document.createTextNode(text.slice(at + q.length)));
    return wrap;
  }

  var WHY = { tag: "mot-clé", name: "nom", text: "texte", fuzzy: "approchant", recent: "récent" };

  /* L'icône de la pièce racine : « grenier » se reconnaît au dessin avant
     qu'on ait lu le chemin, et c'est tout l'intérêt d'avoir des pictogrammes
     plutôt que des emoji tous de la même couleur. */
  function rootIconOf(locationId) {
    var node = locById(locationId), guard = 0;
    if (!node) return "f-carton";
    while (node.parentId && guard < 12) { node = locById(node.parentId) || node; guard += 1; }
    return node.icon || ICON_BY_KIND[node.kind];
  }

  function cmdkRows(query) {
    var q = query.trim();
    var groups = [];

    if (cmdk && cmdk.tag) {
      var tag = norm(cmdk.tag);
      var tagged = state.items.filter(function (it) {
        return (it.tags || []).some(function (t) { return norm(t) === tag; });
      });
      groups.push({ title: "Mot-clé « " + cmdk.tag + " »", rows: tagged.map(itemRow) });
      return groups;
    }

    if (!q) {
      groups.push({ title: "Vus récemment", rows: state.items.slice()
        .sort(function (a, b) { return (b.lastSeenAt || 0) - (a.lastSeenAt || 0); })
        .slice(0, 5).map(itemRow) });
      groups.push({ title: "Actions", rows: CMDK_ACTIONS.map(actionRow) });
      return groups;
    }

    var found = search(q);
    if (found.length) groups.push({ title: plural(found.length, "objet", "objets"), rows: found.slice(0, 40).map(itemRow) });

    var places = state.locations.filter(function (l) { return norm(l.name).indexOf(norm(q)) !== -1; });
    if (places.length) groups.push({ title: plural(places.length, "lieu", "lieux"), rows: places.slice(0, 8).map(locRow) });

    var acts = CMDK_ACTIONS.filter(function (a) {
      return norm(a.label + " " + a.keys).indexOf(norm(q)) !== -1;
    });
    if (acts.length) groups.push({ title: "Actions", rows: acts.map(actionRow) });

    return groups;

    function itemRow(row) {
      var item = row.item || row;
      var path = pathOf(item.locationId);
      return {
        art: rootIconOf(item.locationId),
        name: item.name + (item.quantity > 1 ? "  ×" + item.quantity : ""),
        sub: path.length ? path.join(" / ") : "À ranger",
        spot: item.spot,
        why: row.reason ? WHY[row.reason] : null,
        isTag: row.reason === "tag",
        run: function () { itemSheet(item); }
      };
    }
    function locRow(loc) {
      var ids = descendantIds(loc.id);
      var n = state.items.filter(function (it) { return ids.indexOf(it.locationId) !== -1; }).length;
      return {
        name: loc.name,
        sub: pathOf(loc.id).slice(0, -1).join(" / ") || "Racine",
        why: plural(n, "objet", "objets"),
        art: loc.icon || ICON_BY_KIND[loc.kind],
        run: function () { goTab("places"); }
      };
    }
    function actionRow(a) {
      return {
        name: a.label, sub: a.hint, icon: a.ic,
        why: a.premium && state.plan !== "premium" ? "Éclair" : null,
        run: a.run
      };
    }
  }

  function openPalette(initial) {
    if (cmdk) { cmdk.input.focus(); cmdk.input.select(); return; }
    closeSheet();

    var list = el("div", { class: "cmdk-list", role: "listbox", "aria-label": "Résultats" });

    var input = el("input", {
      type: "search", autocomplete: "off", spellcheck: "false", enterkeyhint: "go",
      placeholder: "Chercher un objet, un lieu, une action…",
      "aria-label": "Rechercher", value: initial || "",
      oninput: function () { cmdk.tag = null; paint(); }
    });

    var filters = el("div", { class: "cmdk-filters" });

    var panel = el("div", { class: "cmdk", role: "dialog", "aria-modal": "true", "aria-label": "Recherche" }, [
      el("div", { class: "cmdk-head" }, [
        icon("search", 20),
        input,
        el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", onclick: closePalette }, [icon("x", 18)])
      ]),
      filters,
      list,
      el("div", { class: "cmdk-foot" }, [
        el("span", {}, [el("kbd", { class: "kbd", text: "↑" }), el("kbd", { class: "kbd", text: "↓" }), "naviguer"]),
        el("span", {}, [el("kbd", { class: "kbd", text: "↵" }), "ouvrir"]),
        el("span", {}, [el("kbd", { class: "kbd", text: "esc" }), "fermer"])
      ])
    ]);

    var backdrop = el("div", {
      class: "cmdk-backdrop",
      onmousedown: function (event) { if (event.target === backdrop) closePalette(); }
    }, [panel]);

    cmdk = { backdrop: backdrop, input: input, list: list, filters: filters, index: 0, rows: [], tag: null };

    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";
    cmdk.onKey = paletteKey;
    document.addEventListener("keydown", cmdk.onKey);

    paint();
    input.focus();
  }

  function closePalette() {
    if (!cmdk) return;
    document.removeEventListener("keydown", cmdk.onKey);
    cmdk.backdrop.remove();
    if (!openSheet) document.body.style.overflow = "";
    cmdk = null;
  }

  function paletteKey(event) {
    if (!cmdk) return;
    if (event.key === "Escape") { event.preventDefault(); closePalette(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    if (cmdk.rows.length === 0) return;
    event.preventDefault();
    if (event.key === "Enter") { cmdk.rows[cmdk.index].run(); return; }
    cmdk.index = (cmdk.index + (event.key === "ArrowDown" ? 1 : -1) + cmdk.rows.length) % cmdk.rows.length;
    paintSelection();
  }

  function paintSelection() {
    var nodes = cmdk.list.querySelectorAll(".cmdk-row");
    for (var i = 0; i < nodes.length; i++) {
      var on = i === cmdk.index;
      nodes[i].setAttribute("aria-selected", on ? "true" : "false");
      if (on) nodes[i].scrollIntoView({ block: "nearest" });
    }
  }

  function paint() {
    var query = cmdk.input.value;
    var groups = cmdkRows(query);

    // Mots-clés les plus présents : ce sont les recherches qu'on refera.
    var counts = Object.create(null);
    state.items.forEach(function (it) {
      (it.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 8);

    cmdk.filters.replaceChildren.apply(cmdk.filters, top.map(function (tag) {
      var on = cmdk.tag === tag;
      return el("button", {
        class: "chip" + (on ? " on" : ""), type: "button", "aria-pressed": on ? "true" : "false",
        onclick: function () {
          cmdk.tag = on ? null : tag;
          cmdk.input.value = "";
          paint();
          cmdk.input.focus();
        }
      }, [tag, el("b", { text: String(counts[tag]) })]);
    }));

    var nodes = [];
    cmdk.rows = [];

    groups.forEach(function (group) {
      if (group.rows.length === 0) return;
      nodes.push(el("div", { class: "cmdk-group" }, [el("p", { class: "label", text: group.title }), el("i")]));
      group.rows.forEach(function (row) {
        var index = cmdk.rows.length;
        cmdk.rows.push(row);
        nodes.push(el("button", {
          class: "cmdk-row", type: "button", role: "option", "aria-selected": index === 0 ? "true" : "false",
          onmousemove: function () { if (cmdk.index !== index) { cmdk.index = index; paintSelection(); } },
          onclick: row.run
        }, [
          el("span", { class: "fig" }, [row.icon ? icon(row.icon, 17) : sym(row.art, 19)]),
          el("span", { class: "txt" }, [
            el("span", { class: "nm" }, [markMatch(row.name, cmdk.tag ? "" : query)]),
            el("span", { class: "sub path" }, [
              row.sub,
              row.spot ? el("span", { class: "spot", text: " · " + row.spot }) : null
            ])
          ]),
          row.why ? el("span", { class: "why" + (row.isTag ? " tag" : ""), text: row.why }) : null
        ]));
      });
    });

    if (cmdk.rows.length === 0) {
      var typed = query.trim();
      nodes = [el("div", { class: "cmdk-empty" }, [
        icon("pin", 26),
        el("p", { style: "font-size:.9375rem", text: typed ? "Rien ne correspond à « " + typed + " »." : "Votre logement est vide." }),
        el("p", { class: "muted", style: "font-size:.8125rem;max-width:40ch", text: "Vérifiez l'orthographe, essayez un mot plus court, ou référencez-le maintenant." }),
        el("div", { class: "inline", style: "justify-content:center;margin-top:4px" }, [
          state.plan === "premium" && typed ? el("button", {
            class: "btn btn-sm btn-line", type: "button",
            onclick: function () { closePalette(); searchState.query = typed; goTab("search"); setTimeout(runAiSearch, 60); }
          }, [icon("spark", 14), "Comprendre ma demande"]) : null,
          el("button", {
            class: "btn btn-sm btn-volt", type: "button",
            onclick: function () { closePalette(); itemSheet(null, typed); }
          }, [icon("plus", 14), typed ? "Référencer « " + typed + " »" : "Référencer un objet"])
        ])
      ])];
    }

    cmdk.index = 0;
    cmdk.list.replaceChildren.apply(cmdk.list, nodes);
  }

  /* ⌘K de partout, et « / » quand on n'est pas déjà en train de taper. */
  document.addEventListener("keydown", function (event) {
    if (cmdk || !state.account || !state.household) return;
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault(); openPalette(); return;
    }
    if (event.key === "/" && !typing && !openSheet) { event.preventDefault(); openPalette(); }
  });

  /* ═══ Bandeau de démonstration ══════════════════════════════════════ */

  function demoBar() {
    return el("div", { class: "demo-bar" }, [
      el("strong", { text: "Prototype" }),
      el("span", { text: "Données locales à ce navigateur · aucun paiement" }),
      el("span", { class: "spacer" }),
      state.account ? el("button", {
        type: "button",
        onclick: function () {
          if (!confirm("Effacer ce prototype et repartir de l'inscription ?")) return;
          state = blank(); save(); render();
        },
        text: "Réinitialiser"
      }) : null
    ]);
  }

  /* ═══ Écran 1 — Création de compte ══════════════════════════════════ */

  /* L'état du formulaire vit HORS de la fonction de rendu. Déclaré à
     l'intérieur, il était réinitialisé à chaque render() : les messages
     d'erreur disparaissaient avant d'être peints et les champs se vidaient —
     de l'extérieur, le bouton semblait ne rien faire. */
  var signup = { fullName: "", email: "", password: "", errors: {} };

  function screenSignup() {

    function submit(event) {
      event.preventDefault();

      var name = signup.fullName.trim();
      var email = signup.email.trim().toLowerCase();
      var password = signup.password;
      var errors = {};

      if (name.length < 1) errors.fullName = "Indiquez au moins un prénom.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = "Cette adresse email n'est pas valide.";
      // Mêmes règles que le serveur : 12 caractères et une variété minimale.
      if (password.length < 12) errors.password = "Encore " + (12 - password.length) + " caractère(s) : le mot de passe doit en faire 12 au minimum.";
      else if (new Set(password).size < 5) errors.password = "Ce mot de passe est trop répétitif. Utilisez au moins cinq caractères différents.";

      signup.errors = errors;

      if (Object.keys(errors).length > 0) {
        render();
        // Le premier champ fautif reprend le focus : sans cela, sur mobile, le
        // message s'affiche hors écran et l'utilisateur ne le voit pas.
        var first = document.querySelector('[aria-invalid="true"]');
        if (first) { first.focus(); first.scrollIntoView({ block: "center" }); }
        return;
      }

      enter({ name: name, email: email }, false);
    }

    function field(label, key, type, placeholder, autocomplete, hint) {
      var input = el("input", {
        // `name` est conservé : c'est ce sur quoi s'appuient les gestionnaires
        // de mots de passe et le remplissage automatique du navigateur.
        class: "input", type: type, name: key, placeholder: placeholder,
        autocomplete: autocomplete, value: signup[key],
        "aria-invalid": signup.errors[key] ? "true" : null,
        "aria-describedby": signup.errors[key] ? "err-" + key : null,
        oninput: function (event) {
          signup[key] = event.target.value;
          // On efface l'erreur dès la correction, sans redessiner : redessiner
          // à chaque frappe ferait perdre le curseur.
          if (signup.errors[key]) {
            signup.errors[key] = null;
            event.target.removeAttribute("aria-invalid");
            var node = document.getElementById("err-" + key);
            if (node) node.remove();
          }
        }
      });

      return el("label", { class: "field" }, [
        el("span", { text: label }),
        input,
        signup.errors[key]
          ? el("span", { class: "err", id: "err-" + key, role: "alert", text: signup.errors[key] })
          : (hint ? el("span", { style: "font-size:.75rem;color:var(--faint)", text: hint }) : null)
      ]);
    }

    return el("div", { class: "screen", style: "position:relative" }, [
      el("div", { class: "halo", "aria-hidden": "true" }),
      el("div", { class: "screen-head" }, [logo(22)]),
      el("div", { class: "screen-body" }, [
        el("div", { class: "screen-inner" }, [
          el("div", {}, [
            el("h1", { class: "display t-xl", text: "Créer votre compte" }),
            el("p", { class: "lede", style: "margin-top:10px", text: "Deux minutes pour ne plus jamais rien chercher." })
          ]),

          el("form", { class: "stack", onsubmit: submit, novalidate: true }, [
            field("Prénom et nom", "fullName", "text", "Camille Dupont", "name"),
            field("Adresse email", "email", "email", "vous@exemple.fr", "email"),
            field("Mot de passe", "password", "password", "12 caractères minimum", "new-password", "12 caractères minimum, comme dans la vraie application. Aucun email n'est envoyé."),
            el("button", { class: "btn btn-lg btn-volt", type: "submit", style: "margin-top:6px", text: "Créer mon compte" })
          ]),

          /* Entrée directe : un prototype qu'on n'atteint qu'après avoir passé
             une validation de mot de passe n'est pas un prototype utile. */
          el("div", { class: "stack-sm", style: "border-top:1px solid var(--line);padding-top:22px" }, [
            el("button", {
              class: "btn btn-line", type: "button", style: "width:100%",
              onclick: function () {
                enter({ name: "Camille Dupont", email: "camille@exemple.fr" }, true);
              }
            }, [icon("bolt", 16), "Entrer directement, logement déjà rempli"]),
            el("p", {
              style: "font-size:.75rem;line-height:1.6;color:var(--faint);text-align:center",
              text: "Compte de démonstration, Éclair activé, 40 objets déjà référencés."
            })
          ])
        ])
      ])
    ]);
  }

  /* Ouvre la session du prototype. `seeded` saute la configuration du logement
     et charge l'exemple, pour atterrir directement dans l'application. */
  function enter(account, seeded) {
    state.account = { name: account.name, email: account.email, createdAt: Date.now() };
    signup = { fullName: "", email: "", password: "", errors: {} };

    if (seeded) {
      seedHousehold();
      state.plan = "premium";
      state.planSeen = true;
      state.screen = "app";
      state.tab = "search";
      save();
      render();
      toast("Bienvenue. Éclair activé, 40 objets chargés.");
      return;
    }

    state.screen = "onboarding";
    save();
    render();
    // Le choix de formule arrive à la fin de la création du compte, avant la
    // configuration du logement.
    setTimeout(planSheet, 220);
  }

  /* ═══ Modale de formule ═════════════════════════════════════════════ */

  var FREE_FEATURES = [
    "Objets illimités", "Pièces, zones et meubles illimités",
    "Recherche tolérante aux fautes", "Mots-clés et métadonnées",
    "Foyer partagé jusqu'à 5 membres", "Export de vos données"
  ];
  var PAID_FEATURES = [
    "Tout le plan Libre, sans limite", "Scan Éclair : référencement par la caméra",
    "Plan interactif du logement", "Recherche en langage naturel",
    "Alertes péremption, garantie et prêts", "Membres du foyer illimités"
  ];

  function planSheet() {
    var chosen = state.plan;

    function card(id, name, price, suffix, pitch, features, tag) {
      var node = el("button", {
        class: "plan-card", type: "button", role: "radio",
        "aria-checked": chosen === id ? "true" : "false",
        onclick: function () { chosen = id; refresh(); }
      }, [
        el("div", { class: "plan-top" }, [
          el("div", {}, [
            el("div", { class: "inline", style: "gap:8px" }, [
              el("span", { class: "plan-name", text: name }),
              tag ? el("span", { class: "label badge", text: tag }) : null
            ]),
            el("p", { class: "muted", style: "font-size:.8125rem;margin-top:5px", text: pitch })
          ]),
          el("span", { class: "plan-radio", "aria-hidden": "true" }, [chosen === id ? icon("check", 13) : null])
        ]),
        el("p", { class: "plan-price" }, [price, suffix ? el("small", { text: suffix }) : null]),
        el("ul", { class: "plan-feats" }, features.map(function (feature) {
          return el("li", {}, [icon("check"), el("span", { text: feature })]);
        }))
      ]);
      return node;
    }

    function refresh() {
      closeSheet();
      draw();
    }

    function finish() {
      state.plan = chosen;
      state.planSeen = true;
      save();
      closeSheet();
      render();
      if (chosen === "premium") toast("Éclair activé — gratuitement, en mode prototype.");
    }

    function draw() {
      sheet({
        title: "Choisissez votre formule",
        wide: true,
        onClose: function () { state.planSeen = true; save(); render(); },
        body: [
          el("p", { class: "lede", text: "Vous pouvez commencer gratuitement et passer à l'Éclair plus tard. Aucun engagement." }),
          el("div", { class: "plan-grid", role: "radiogroup", "aria-label": "Formule" }, [
            card("free", "Libre", "0 €", null, "Tout ce qu'il faut pour ne plus jamais chercher.", FREE_FEATURES, null),
            card("premium", "Éclair", "9 €", "/mois", "Pour référencer vite et chercher encore plus vite.", PAID_FEATURES, "Recommandé")
          ]),
          el("p", {
            class: "label",
            style: "text-transform:none;letter-spacing:.04em;font-size:.75rem;line-height:1.7;color:var(--faint)",
            text: "Dans la vraie application, choisir l'Éclair ouvre un paiement Stripe. Ici, l'abonnement s'active gratuitement : c'est un prototype, aucune carte n'est demandée et rien n'est débité."
          })
        ],
        foot: [
          el("button", {
            class: "btn btn-lg btn-volt", type: "button", style: "width:100%",
            onclick: finish,
            text: chosen === "premium" ? "Activer l'Éclair (gratuit en démo)" : "Continuer avec le plan Libre"
          }),
          el("p", { class: "muted", style: "text-align:center;font-size:.75rem;margin-top:12px", text: "Vous pourrez changer de formule à tout moment depuis les réglages." })
        ]
      });
    }

    draw();
  }

  /* ═══ Écran 2 — Onboarding ══════════════════════════════════════════ */

  var wiz = null;

  function screenOnboarding() {
    if (!wiz) {
      var first = state.account ? state.account.name.split(" ")[0] : "";
      wiz = {
        step: 0,
        type: "apartment",
        name: first ? "Chez " + first : "La maison",
        floors: 1,
        rooms: [],
        custom: ""
      };
    }

    var steps = ["type", "name", "floors", "rooms", "rename", "furniture"];
    if (wiz.type === "studio" || wiz.type === "apartment") steps = steps.filter(function (s) { return s !== "floors"; });
    var current = steps[wiz.step];

    function go(delta) {
      wiz.step = Math.max(0, Math.min(steps.length - 1, wiz.step + delta));
      render();
    }

    /* Retire UN exemplaire précis, puis renumérote ce qui reste : supprimer
       « Chambre 2 » sur trois chambres ne doit pas laisser un trou entre
       « Chambre » et « Chambre 3 ». Les pièces renommées à la main sont
       laissées telles quelles — on ne réécrit pas le choix de l'utilisateur.

       La puce du panier désigne l'exemplaire exact : c'est là qu'on regarde
       quand on veut en enlever un, et c'est donc celui-là qu'on retire. */
    function removeRoomById(id, key) {
      wiz.rooms = wiz.rooms.filter(function (r) { return r.id !== id; });
      if (!key) { render(); return; }

      var preset = null;
      for (var i = 0; i < ROOMS.length; i++) if (ROOMS[i].key === key) preset = ROOMS[i];
      if (!preset) { render(); return; }

      var remaining = wiz.rooms.filter(function (r) { return r.key === key; });
      var allDefault = remaining.every(function (r) { return r.label.indexOf(preset.label) === 0; });
      if (allDefault) {
        remaining.forEach(function (room, index) {
          room.label = index === 0 ? preset.label : preset.label + " " + (index + 1);
        });
      }
      render();
    }

    function addRoom(preset) {
      var existing = wiz.rooms.filter(function (r) { return r.key === preset.key; }).length;
      wiz.rooms.push({
        id: uid("r"), key: preset.key, icon: preset.icon, kind: preset.kind,
        // Un deuxième exemplaire est numéroté d'office : « Chambre 2 » est plus
        // utile qu'une deuxième « Chambre » indistinguable.
        label: existing === 0 ? preset.label : preset.label + " " + (existing + 1),
        furniture: (preset.suggests || []).slice(0, 3)
      });
      render();
    }

    function finish() {
      state.household = { name: wiz.name.trim() || "La maison", type: wiz.type, floors: wiz.floors };
      state.locations = [];
      state.items = [];

      wiz.rooms.forEach(function (room) {
        var parent = { id: uid("loc"), parentId: null, kind: room.kind, name: room.label, icon: room.icon, floor: room.kind === "zone" ? 0 : 1 };
        state.locations.push(parent);
        room.furniture.forEach(function (name) {
          state.locations.push({ id: uid("loc"), parentId: parent.id, kind: "furniture", name: name, icon: null, floor: parent.floor });
        });
      });

      state.screen = "app";
      state.tab = "search";
      wiz = null;
      save();
      render();
    }

    var head = el("div", { class: "stack-sm", style: "margin-bottom:34px" }, [
      el("div", { class: "inline", style: "justify-content:space-between" }, [
        el("p", { class: "label", text: "Étape " + (wiz.step + 1) + " sur " + steps.length }),
        wiz.step > 0 ? el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: function () { go(-1); } }, [icon("arrow-left", 14), "Retour"]) : null
      ]),
      el("div", { class: "progress" }, [el("i", { style: "width:" + ((wiz.step + 1) / steps.length * 100) + "%" })])
    ]);

    var content;

    if (current === "type") {
      content = [
        el("h1", { class: "display t-xl", text: "Vous habitez dans…" }),
        el("p", { class: "lede", style: "margin-top:10px", text: "Cela nous sert à proposer les bons espaces." }),
        el("div", { class: "tiles", style: "margin-top:30px" }, [
          ["apartment", "h-appart", "Un appartement"], ["house", "h-maison", "Une maison"],
          ["studio", "h-studio", "Un studio"], ["other", "h-autre", "Autre chose"]
        ].map(function (option) {
          return el("button", {
            class: "tile", type: "button", "aria-pressed": wiz.type === option[0] ? "true" : "false",
            onclick: function () { wiz.type = option[0]; wiz.step = 1; render(); }
          }, [sym(option[1], 34), el("span", { text: option[2] })]);
        }))
      ];
    }

    else if (current === "name") {
      content = [
        el("h1", { class: "display t-xl", text: "Comment appelez-vous ce lieu ?" }),
        el("p", { class: "lede", style: "margin-top:10px", text: "C'est le nom de votre foyer, visible par les membres que vous inviterez." }),
        el("input", {
          class: "input", style: "margin-top:30px;font-family:var(--display);font-size:clamp(1.5rem,5vw,2.2rem);font-weight:700;letter-spacing:-.03em;border:0;border-bottom:2px solid var(--line);border-radius:0;background:transparent;padding:10px 0",
          value: wiz.name, maxlength: 80, autofocus: true,
          oninput: function (event) { wiz.name = event.target.value; },
          onkeydown: function (event) { if (event.key === "Enter") go(1); }
        }),
        el("div", { style: "margin-top:34px" }, [
          el("button", { class: "btn btn-lg btn-volt", type: "button", onclick: function () { go(1); } }, ["Suivant", icon("arrow-right", 15)])
        ])
      ];
    }

    else if (current === "floors") {
      content = [
        el("h1", { class: "display t-xl", text: "Combien de niveaux ?" }),
        el("p", { class: "lede", style: "margin-top:10px", text: "Cave et grenier compris s'ils vous servent de rangement." }),
        el("div", { class: "stepper", style: "margin-top:34px" }, [
          el("button", { class: "round-btn", type: "button", "aria-label": "Retirer un niveau", disabled: wiz.floors <= 1, onclick: function () { wiz.floors = Math.max(1, wiz.floors - 1); render(); } }, [icon("minus", 18)]),
          el("span", { class: "num", text: String(wiz.floors) }),
          el("button", { class: "round-btn", type: "button", "aria-label": "Ajouter un niveau", disabled: wiz.floors >= 8, onclick: function () { wiz.floors = Math.min(8, wiz.floors + 1); render(); } }, [icon("plus", 18)])
        ]),
        el("div", { style: "margin-top:34px" }, [
          el("button", { class: "btn btn-lg btn-volt", type: "button", onclick: function () { go(1); } }, ["Suivant", icon("arrow-right", 15)])
        ])
      ];
    }

    else if (current === "rooms") {
      content = [
        el("h1", { class: "display t-xl", text: "Quelles pièces ?" }),
        el("p", { class: "lede", style: "margin-top:10px", text: "Touchez pour ajouter, plusieurs fois pour en avoir plusieurs. La croix en retire une." }),

        el("div", { class: "pick-rows", style: "margin-top:26px" }, ROOMS.map(function (preset) {
          var count = wiz.rooms.filter(function (r) { return r.key === preset.key; }).length;
          return el("button", {
            class: "pick-row" + (count > 0 ? " on" : ""), type: "button",
            "aria-label": count > 0 ? "Ajouter une " + preset.label + " (" + count + " déjà)" : "Ajouter " + preset.label,
            onclick: function () { addRoom(preset); }
          }, [
            sym(preset.icon, 20),
            el("span", { class: "lbl", text: preset.label }),
            count > 0 ? el("span", { class: "n", text: "×" + count }) : null,
            el("span", { class: "add" }, [icon("plus", 16)])
          ]);
        })),

        /* Le panier. Il porte les pièces dans l'ordre où elles ont été
           ajoutées, chacune avec sa croix — y compris celles saisies à la
           main, qui sinon ne pouvaient plus être annulées ici. */
        el("div", { style: "margin-top:26px" }, [
          el("p", { class: "label", style: "margin-bottom:10px",
                    text: wiz.rooms.length === 0 ? "Votre sélection" : plural(wiz.rooms.length, "pièce sélectionnée", "pièces sélectionnées") }),
          el("div", { class: "tray" }, wiz.rooms.length === 0
            ? [el("span", { class: "tray-empty", text: "Rien pour l'instant. Touchez une pièce ci-dessus." })]
            : wiz.rooms.map(function (room) {
                return el("span", { class: "tray-chip accent" }, [
                  sym(room.icon, 16),
                  room.label,
                  el("button", {
                    class: "x", type: "button", "aria-label": "Retirer " + room.label, title: "Retirer",
                    onclick: function () {
                      if (room.key) { removeRoomById(room.id, room.key); }
                      else { wiz.rooms = wiz.rooms.filter(function (r) { return r.id !== room.id; }); render(); }
                    }
                  }, [icon("x", 14)])
                ]);
              }))
        ]),

        (function () {
          function addCustom() {
            var label = wiz.custom.trim();
            if (!label) return;
            wiz.rooms.push({ id: uid("r"), key: null, icon: "r-piece", kind: "room", label: label.slice(0, 80), furniture: [] });
            wiz.custom = "";
            render();
          }

          var addButton = el("button", {
            class: "btn btn-line", type: "button", disabled: !wiz.custom.trim(), onclick: addCustom
          }, [icon("plus", 15), "Ajouter"]);

          var input = el("input", {
            class: "input", style: "flex:1;min-width:180px", placeholder: "Autre pièce ou zone", maxlength: 80,
            value: wiz.custom,
            oninput: function (event) {
              wiz.custom = event.target.value;
              // L'état du bouton est mis à jour EN PLACE : le redessiner à
              // chaque frappe ferait perdre le curseur.
              addButton.disabled = !wiz.custom.trim();
            },
            onkeydown: function (event) {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addCustom();
            }
          });

          return el("div", { class: "inline", style: "margin-top:24px" }, [input, addButton]);
        })(),

        el("div", { style: "margin-top:30px" }, [
          el("button", { class: "btn btn-lg btn-volt", type: "button", disabled: wiz.rooms.length === 0, onclick: function () { go(1); } }, ["Suivant", icon("arrow-right", 15)]),
          wiz.rooms.length === 0 ? el("p", { class: "muted", style: "font-size:.8125rem;margin-top:12px", text: "Sélectionnez au moins une pièce pour continuer." }) : null
        ])
      ];
    }

    else if (current === "rename") {
      content = [
        el("h1", { class: "display t-xl", text: "Précisez les noms" }),
        el("p", { class: "lede", style: "margin-top:10px", text: "« Chambre 2 » devient « Chambre de Léa ». Touchez l'icône pour la changer. Optionnel, mais très utile à la recherche." }),
        el("ul", { class: "row-list", style: "margin-top:26px" }, wiz.rooms.map(function (room) {
          return el("li", { class: "row" }, [
            el("button", {
              class: "mini icon-edit", type: "button",
              "aria-label": "Changer l'icône de " + room.label, title: "Changer l'icône",
              onclick: function () {
                iconPicker({
                  title: "Icône de " + room.label, current: room.icon,
                  onPick: function (value) { room.icon = value || ICON_BY_KIND[room.kind]; render(); }
                });
              }
            }, [sym(room.icon, 19)]),
            el("input", {
              class: "bare", value: room.label, maxlength: 80, "aria-label": room.label,
              oninput: function (event) { room.label = event.target.value; }
            }),
            el("button", {
              class: "mini", type: "button", "aria-label": "Retirer " + room.label, title: "Retirer",
              onclick: function () { removeRoomById(room.id, room.key); }
            }, [icon("x", 15)])
          ]);
        })),
        el("div", { style: "margin-top:30px" }, [
          el("button", { class: "btn btn-lg btn-volt", type: "button", onclick: function () { go(1); } }, ["Suivant", icon("arrow-right", 15)])
        ])
      ];
    }

    else {
      content = [
        el("h1", { class: "display t-xl", text: "Les meubles de rangement" }),
        el("p", { class: "lede", style: "margin-top:10px", text: "Ajoutez les endroits où vous rangez vraiment des choses. Vous pourrez en ajouter d'autres à tout moment." }),
        el("div", { class: "stack", style: "margin-top:28px" }, wiz.rooms.map(function (room) {
          // Les meubles déjà retenus tiennent sur une ligne de puces ; le
          // catalogue complet, lui, s'ouvre à la demande. Afficher vingt
          // propositions par pièce noyait le choix.
          var chips = room.furniture.map(function (name) {
            var entry = furnitureByLabel(name);
            return el("span", { class: "tray-chip accent" }, [
              entry ? sym(entry.pic, 17) : sym("f-autre", 17),
              name,
              el("button", {
                class: "x", type: "button", "aria-label": "Retirer " + name + " de " + room.label, title: "Retirer",
                onclick: function () {
                  room.furniture = room.furniture.filter(function (f) { return f !== name; });
                  render();
                }
              }, [icon("x", 14)])
            ]);
          });

          chips.push(el("button", {
            class: "chip chip-sm", type: "button",
            onclick: function () { furniturePicker(room, render); }
          }, [icon("plus", 14), room.furniture.length === 0 ? "Ajouter un meuble" : "Ajouter"]));

          return el("section", {}, [
            el("h3", { class: "inline", style: "font-size:.9375rem;font-weight:600;margin:0;gap:9px;padding-bottom:9px;border-bottom:1.5px solid var(--line)" }, [
              sym(room.icon, 18), room.label
            ]),
            el("div", { class: "tray", style: "margin-top:12px" }, chips),
            room.furniture.length === 0
              ? el("p", { class: "muted", style: "font-size:.8125rem;margin-top:8px", text: "Vous pouvez laisser vide et compléter plus tard." })
              : null
          ]);
        })),
        el("div", { style: "margin-top:34px" }, [
          el("button", { class: "btn btn-lg btn-volt", type: "button", onclick: finish }, ["Terminer", icon("check", 15)])
        ])
      ];
    }

    return el("div", { class: "screen", style: "position:relative" }, [
      el("div", { class: "halo", "aria-hidden": "true" }),
      el("div", { class: "screen-head" }, [logo(22)]),
      el("div", { class: "screen-body" }, [
        el("div", { class: "screen-inner screen-wide" }, [head].concat(content))
      ])
    ]);
  }

  /* ═══ Écran 3 — Application ═════════════════════════════════════════ */

  var TABS = [
    { id: "search",   icon: "search", label: "Rechercher" },
    { id: "places",   icon: "grid",   label: "Mes lieux" },
    { id: "scan",     icon: "scan",   label: "Scan Éclair",  premium: true },
    { id: "map",      icon: "map",    label: "Plan",  premium: true },
    { id: "alerts",   icon: "bell",   label: "Alertes" },
    { id: "settings", icon: "cog",    label: "Réglages" }
  ];

  function screenApp() {
    var premium = state.plan === "premium";

    var rail = el("nav", { class: "rail", "aria-label": "Navigation" }, [
      el("div", { class: "rail-head" }, [logo(21)]),

      /* Le foyer et la formule en tête : on sait chez qui on est, et avec
         quoi, sans aller dans les réglages. */
      el("button", {
        class: "rail-home", type: "button",
        onclick: function () { state.tab = "settings"; save(); render(); }
      }, [
        el("span", { class: "fig" }, [sym(state.household && state.household.type === "house" ? "h-maison" : "h-appart", 26)]),
        el("span", { class: "txt" }, [
          el("span", { class: "nm", text: state.household ? state.household.name : "Mon logement" }),
          el("span", { class: "pl" + (premium ? " on" : ""), text: premium ? "FULMO Éclair" : "Formule Libre" })
        ])
      ])
    ].concat(
      TABS.map(function (tab) {
        return el("button", {
          class: "rail-btn", type: "button",
          "aria-current": state.tab === tab.id ? "page" : null,
          onclick: function () { state.tab = tab.id; save(); render(); }
        }, [
          icon(tab.icon, 19),
          el("span", { class: "lbl", text: tab.label }),
          tab.premium ? el("span", { class: "rail-bolt", title: "Fonction Éclair" }, [icon("bolt", 15)]) : null
        ]);
      })
    ).concat([
      el("div", { class: "rail-foot" }, [
        el("button", {
          class: "rail-btn", type: "button",
          onclick: function () { toast("Le prototype est en français. L'anglais existe dans le dépôt."); }
        }, [icon("globe", 18), el("span", { class: "lbl", text: "English" })])
      ])
    ]));

    var tabbar = el("nav", { class: "tabbar", "aria-label": "Navigation" }, TABS.slice(0, 5).map(function (tab) {
      return el("button", {
        class: "tab", type: "button",
        "aria-current": state.tab === tab.id ? "page" : null,
        onclick: function () { state.tab = tab.id; save(); render(); }
      }, [icon(tab.icon, 20), tab.label]);
    }));

    var views = {
      search: viewSearch, places: viewPlaces, scan: viewScan,
      map: viewMap, alerts: viewAlerts, settings: viewSettings
    };

    return el("div", { class: "app" }, [
      rail,
      el("div", { class: "app-main" }, [
        el("header", { class: "app-head" }, [
          logoMarkOnly(26),
          /* La recherche est le produit : elle est accessible depuis chaque
             onglet, pas seulement depuis le sien. */
          state.tab === "search"
            ? el("span", { style: "flex:1;font-size:.875rem;font-weight:500", text: state.household ? state.household.name : "FULMO" })
            : el("button", {
                class: "cmdk-trigger", type: "button", style: "max-width:420px",
                onclick: function () { openPalette(); }
              }, [
                icon("search", 17),
                el("span", { class: "grow", text: "Chercher un objet…" }),
                el("kbd", { class: "kbd", text: "⌘K" })
              ]),
          el("button", {
            class: "icon-btn", type: "button", "aria-label": premium ? "Éclair actif" : "Passer Éclair",
            title: premium ? "Éclair actif" : "Passer Éclair",
            style: premium ? "color:var(--accent)" : "background:var(--volt);color:var(--ink)",
            onclick: function () { state.tab = "settings"; save(); render(); }
          }, [icon("bolt", 16)])
        ]),
        views[state.tab]()
      ]),
      tabbar
    ]);
  }

  function logoMarkOnly(size) {
    var wrap = document.createElement("span");
    wrap.style.display = "inline-flex";
    wrap.style.width = (size || 30) + "px";
    wrap.style.height = (size || 30) + "px";
    wrap.setAttribute("aria-hidden", "true");
    wrap.className = "logo-mark";
    wrap.style.flexShrink = "0";
    wrap.innerHTML = '<svg viewBox="0 0 48 48" fill="none" style="display:block;width:100%;height:100%">' +
      '<circle cx="24" cy="24" r="19.8" stroke="currentColor" stroke-width="4.2"/>' +
      '<path d="M28.5 4.5 L13.5 27 h8.4 L19 43.5 L34.5 20 h-8.5 Z" fill="#d9ff3d" stroke="var(--bg)" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    return wrap;
  }

  /* ─── Vue : recherche ─────────────────────────────────────────────── */

  var searchState = { query: "", ai: null, aiBusy: false, aiTried: null, filter: null };

  /* Historique de recherche.

     Ce que l'utilisateur a CHERCHÉ, pas ce qu'il a rangé en dernier. Une
     liste d'objets récemment ajoutés ne sert qu'à celui qui vient de les
     ajouter ; un historique sert à celui qui cherche deux fois la même
     chose — c'est-à-dire tout le monde, une fois par saison.

     Enregistré à la validation, pas à la frappe : sinon « p », « pa »,
     « pas », « pass » rempliraient la liste avant « passeport ». */
  function rememberSearch(query) {
    var q = query.trim();
    if (q.length < 2) return;
    var found = search(q).length;
    state.history = (state.history || []).filter(function (entry) { return norm(entry.q) !== norm(q); });
    state.history.unshift({ q: q, n: found, at: Date.now() });
    state.history = state.history.slice(0, 12);
    save();
  }

  function forgetSearch(query) {
    state.history = (state.history || []).filter(function (entry) { return entry.q !== query; });
    save();
    render();
  }

  function viewSearch() {
    var hasQuery = searchState.query.trim().length > 0;
    var premium = state.plan === "premium";

    // « À ranger » n'est pas un mot-clé : c'est l'absence d'emplacement.
    var unsorted = state.items.filter(function (item) { return !item.locationId; }).length;
    var results = searchState.filter === "__unsorted"
      ? state.items.filter(function (item) { return !item.locationId; })
          .map(function (item) { return { item: item, score: 0, reason: "recent" }; })
      : search(searchState.query);
    var shown = results;

    var input = el("input", {
      type: "search", value: searchState.query,
      placeholder: "Chercher un objet…",
      "aria-label": "Qu'est-ce que vous cherchez ?",
      autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
      oninput: function (event) {
        searchState.query = event.target.value;
        searchState.filter = null;
        if (searchState.aiTried !== null) { searchState.ai = null; searchState.aiTried = null; }
        redrawSearch(event.target.selectionStart);
      },
      // Enregistré à la validation, pas à la frappe : sinon « p », « pa »,
      // « pas » rempliraient l'historique avant « passeport ».
      onkeydown: function (event) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        rememberSearch(searchState.query);
        render();
      },
      onblur: function () { rememberSearch(searchState.query); }
    });

    // Mots-clés les plus présents : ce sont les recherches que l'on refera.
    var counts = Object.create(null);
    state.items.forEach(function (item) {
      (item.tags || []).forEach(function (tag) { counts[tag] = (counts[tag] || 0) + 1; });
    });
    var topTags = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 7);

    var body;

    if (state.items.length === 0) {
      body = el("div", { class: "empty" }, [
        el("div", { class: "blob" }, [icon("box", 26)]),
        el("h2", { class: "display t-md", text: "Votre logement est vide pour l'instant" }),
        el("p", { class: "lede", style: "max-width:42ch", text: "Référencez un premier objet : c'est la seule chose à faire avant de pouvoir le retrouver." }),
        el("div", { class: "inline", style: "justify-content:center;margin-top:10px" }, [
          el("button", { class: "btn btn-volt", type: "button", onclick: function () { itemSheet(null); } }, [icon("plus", 16), "Référencer un objet"]),
          el("button", { class: "btn btn-line", type: "button", onclick: function () { seedHousehold(); save(); render(); toast("Logement d'exemple chargé : 40 objets."); } }, "Charger un exemple")
        ])
      ]);
    } else if (results.length === 0) {
      body = el("div", { class: "empty" }, [
        el("div", { class: "blob" }, [icon("pin", 24)]),
        el("h2", { class: "display t-md", text: searchState.aiTried ? "Même en interprétant, rien ne correspond." : "Aucun objet ne correspond." }),
        el("p", { class: "lede", style: "max-width:42ch", text: "Vérifiez l'orthographe, essayez un mot plus court, ou référencez-le maintenant." }),
        el("div", { class: "inline", style: "justify-content:center;margin-top:10px" }, [
          // La recherche IA se déclenche à la demande, jamais à chaque frappe :
          // chaque appel a un coût réel et la recherche classique suffit
          // presque toujours.
          premium && hasQuery && !searchState.aiTried ? el("button", {
            class: "btn btn-volt", type: "button", disabled: searchState.aiBusy,
            onclick: runAiSearch
          }, [icon("spark", 16), searchState.aiBusy ? "Interprétation…" : "Comprendre ma demande"]) : null,
          el("button", { class: "btn btn-line", type: "button", onclick: function () { itemSheet(null, searchState.query.trim()); } }, [icon("plus", 15), "Référencer « " + searchState.query.trim() + " »"])
        ]),
        premium && hasQuery && !searchState.aiTried ? el("p", { class: "muted", style: "font-size:.75rem;max-width:40ch", text: "L'IA interprète ce que vous cherchez, même sans le nom exact. Seule votre phrase est envoyée — jamais votre inventaire." }) : null
      ]);
    } else {
      body = el("div", {}, [
        searchState.ai ? el("p", { class: "ai-note" }, [
          icon("spark", 14),
          el("span", { class: "label", style: "color:var(--accent)", text: "Compris comme :" }),
          el("span", { class: "muted", text: searchState.ai })
        ]) : null,

        !hasQuery && !searchState.filter
          ? el("p", { class: "label", style: "margin-top:26px", text: "Tout votre logement" })
          : null,

        el("ul", { class: "results", style: "margin-top:14px" }, results.slice(0, 60).map(function (row) {
          var item = row.item;
          var path = pathOf(item.locationId);
          return el("li", { class: "result" + (row.reason === "tag" ? " tagmatch" : "") }, [
            el("span", { class: "thumb" }, [sym(rootIconOf(item.locationId), 20)]),
            el("button", { class: "body", type: "button", onclick: function () { itemSheet(item); } }, [
              el("div", { class: "name", text: item.name + (item.quantity > 1 ? "  ×" + item.quantity : "") }),
              el("div", { class: "path where" }, path.length
                ? [path.join(" / "), item.spot ? el("span", { class: "spot", text: " · " + item.spot }) : null]
                : [el("span", { style: "color:var(--warn)", text: "À ranger" })])
            ]),
            el("div", { class: "tags" }, (item.tags || []).slice(0, 2).map(function (tag) {
              return el("span", { class: "label tagpill", text: tag });
            })),
            el("button", {
              class: "mini", type: "button", title: "Je l'ai trouvé", "aria-label": "Confirmer l'emplacement de " + item.name,
              onclick: function () {
                item.lastSeenAt = Date.now(); save();
                toast("Emplacement confirmé.");
              }
            }, [icon("check", 17)])
          ]);
        }))
      ]);
    }

    var history = (state.history || []);

    return el("div", { class: "page" }, [
      el("div", { class: "search-head" }, [
        el("p", { class: "label search-kicker", text: "La mémoire de votre maison" }),
        el("h1", { class: "search-title", text: "Rechercher" }),

        el("div", { class: "search-row" }, [
          el("div", { class: "search-box" }, [
            icon("search", 24),
            input,
            searchState.query ? el("button", {
              class: "icon-btn", type: "button", "aria-label": "Effacer",
              onclick: function () {
                searchState.query = ""; searchState.ai = null; searchState.aiTried = null;
                redrawSearch();
              }
            }, [icon("x", 18)]) : el("kbd", { class: "kbd", title: "Ouvrir la palette depuis n'importe quel écran", text: "⌘K" })
          ]),

          /* La recherche IA se déclenche à la demande, jamais à chaque
             frappe : chaque appel a un coût réel, et la recherche classique
             suffit presque toujours. */
          el("button", {
            class: "search-ai", type: "button",
            disabled: !premium || !hasQuery || searchState.aiBusy,
            title: premium ? "Interpréter votre phrase (l'inventaire ne sort jamais)" : "Fonction Éclair",
            onclick: premium ? runAiSearch : function () { state.tab = "settings"; save(); render(); }
          }, [
            icon(searchState.aiBusy ? "loop" : "spark", 17),
            searchState.aiBusy ? "Interprétation…" : "Avec mes mots",
            !premium ? el("span", { class: "rail-bolt" }, [icon("bolt", 13)]) : null
          ])
        ]),

        el("div", { class: "search-filters" }, [
          el("button", {
            class: "chip chip-sm" + (searchState.filter ? "" : " on"), type: "button",
            onclick: function () { searchState.filter = null; searchState.query = ""; redrawSearch(); }
          }, ["Tous"])
        ].concat(topTags.slice(0, 5).map(function (tag) {
          var on = searchState.filter === tag;
          return el("button", {
            class: "chip chip-sm" + (on ? " on" : ""), type: "button",
            onclick: function () {
              searchState.filter = on ? null : tag;
              searchState.query = on ? "" : tag;
              redrawSearch();
            }
          }, [tag, el("b", { text: String(counts[tag]) })]);
        })).concat([
          unsorted > 0 ? el("button", {
            class: "chip chip-sm" + (searchState.filter === "__unsorted" ? " on" : ""), type: "button",
            onclick: function () {
              var on = searchState.filter === "__unsorted";
              searchState.filter = on ? null : "__unsorted";
              searchState.query = "";
              redrawSearch();
            }
          }, ["À ranger", el("b", { text: String(unsorted) })]) : null,
          el("p", { class: "label count", "aria-live": "polite",
                    text: hasQuery || searchState.filter ? plural(shown.length, "résultat", "résultats") : "" })
        ]))
      ]),

      /* L'historique prend la place des « récemment référencés » : on
         l'affiche tant qu'aucune recherche n'est en cours. */
      !hasQuery && !searchState.filter && history.length > 0 ? el("div", { style: "margin-top:26px" }, [
        el("div", { class: "inline", style: "justify-content:space-between" }, [
          el("p", { class: "label", text: "Vos recherches" }),
          el("button", {
            class: "btn btn-sm btn-quiet", type: "button", style: "padding:0;font-size:.8125rem",
            onclick: function () { state.history = []; save(); render(); }
          }, "Effacer l'historique")
        ]),
        el("div", { class: "hist" }, history.map(function (entry) {
          return el("span", { class: "hist-chip" }, [
            el("button", {
              class: "go", type: "button", "aria-label": "Rechercher " + entry.q,
              onclick: function () { searchState.query = entry.q; redrawSearch(); }
            }, [
              icon("clock", 14),
              entry.q,
              el("span", { class: "n", text: String(entry.n) })
            ]),
            el("button", {
              class: "x", type: "button", "aria-label": "Oublier " + entry.q,
              onclick: function () { forgetSearch(entry.q); }
            }, [icon("x", 13)])
          ]);
        }))
      ]) : null,

      body
    ]);
  }

  // Redessine sans perdre le focus ni la position du curseur : un render()
  // complet à chaque frappe ferait sauter le champ.
  function redrawSearch(caret) {
    render();
    var input = document.querySelector(".search-box input");
    if (!input) return;
    input.focus();
    var position = caret == null ? input.value.length : caret;
    try { input.setSelectionRange(position, position); } catch (e) {}
  }

  function runAiSearch() {
    var query = searchState.query.trim();
    if (!query || searchState.aiBusy) return;

    if (!sampleApi) {
      toast("L'assistant n'est pas disponible dans cette vue.");
      return;
    }

    searchState.aiBusy = true;
    searchState.aiTried = query;
    render();

    var prompt =
      "Tu traduis une demande en langage courant en termes de recherche pour un inventaire domestique.\n\n" +
      "La personne décrit un objet qu'elle a rangé chez elle, souvent par sa fonction ou par un mot approximatif. " +
      "Donne les noms d'objets les plus PROBABLES, tels qu'ils auraient été saisis au moment du rangement.\n\n" +
      "Règles : noms communs au singulier, sans article ; du plus probable au moins probable ; " +
      "les mots-clés thématiques ne servent que si la demande porte sur une catégorie et non sur un objet précis.\n\n" +
      "Exemples :\n" +
      "- « le machin qui gonfle les matelas » -> pompe, gonfleur, compresseur, matelas\n" +
      "- « les trucs de la plage » -> parasol, serviette, maillot, crème solaire ; mots-clés : plage, été\n\n" +
      "Demande : « " + query + " »\n\n" +
      "Réponds UNIQUEMENT par un objet JSON : " +
      '{"terms": ["..."], "tags": ["..."], "interpretation": "une phrase courte"}';

    sampleApi.json(prompt, { modelTier: "quick", cache: true })
      .then(function (plan) {
        var terms = (plan && plan.terms ? plan.terms : []).concat(plan && plan.tags ? plan.tags : []);
        // Les termes sont exécutés LOCALEMENT par le moteur de recherche :
        // l'inventaire ne quitte jamais l'appareil.
        var seen = Object.create(null);
        var found = [];
        var matched = null;

        for (var i = 0; i < terms.length && found.length < 12; i++) {
          var hits = search(String(terms[i]));
          for (var h = 0; h < hits.length; h++) {
            if (seen[hits[h].item.id]) continue;
            seen[hits[h].item.id] = true;
            found.push(hits[h]);
            matched = matched || terms[i];
          }
        }

        searchState.aiBusy = false;
        searchState.ai = plan && plan.interpretation ? plan.interpretation : null;

        if (found.length === 0) { render(); return; }

        // On remplace l'affichage par les résultats trouvés via les termes.
        aiResults = found;
        render();
      })
      .catch(function (error) {
        searchState.aiBusy = false;
        var code = error && error.code;
        toast(code === "not_granted" ? "Accès à l'assistant refusé."
            : code === "rate_limited" ? "Trop de demandes, réessayez dans un instant."
            : "L'assistant n'a pas répondu.");
        render();
      });
  }

  var aiResults = null;

  /* ─── Vue : mes lieux ─────────────────────────────────────────────── */

  var expanded = Object.create(null);
  var editing = null;
  var adding = null;

  function viewPlaces() {
    function countIn(id) {
      var ids = descendantIds(id);
      return state.items.filter(function (item) { return ids.indexOf(item.locationId) !== -1; }).length;
    }

    function childKind(kind) { return kind === "zone" || kind === "room" ? "furniture" : "container"; }

    function addNode(parent, name) {
      if (!name.trim()) return;
      state.locations.push({
        id: uid("loc"), parentId: parent ? parent.id : null,
        kind: parent ? childKind(parent.kind) : "room",
        name: name.trim().slice(0, 80), icon: null,
        floor: parent ? parent.floor : null
      });
      adding = null; save(); render();
    }

    function renderNode(node, depth) {
      var open = expanded[node.id] !== false;
      var kids = childrenOf(node.id);
      var count = countIn(node.id);

      var rows = [el("div", { class: "node", style: "padding-left:" + (depth * 18 + 8) + "px" }, [
        el("button", {
          class: "twist" + (kids.length ? "" : " hidden"), type: "button",
          "aria-expanded": open ? "true" : "false", "aria-label": node.name,
          onclick: function () { expanded[node.id] = !open; render(); }
        }, [(function () { var i = icon("chev", 15); if (open) i.style.transform = "rotate(90deg)"; return i; })()]),

        el("button", {
          class: "mini icon-edit", type: "button",
          "aria-label": "Changer l'icône de " + node.name, title: "Changer l'icône",
          onclick: function () {
            iconPicker({
              title: "Icône de " + node.name, current: node.icon,
              onPick: function (value) { node.icon = value; save(); render(); }
            });
          }
        }, [sym(node.icon || ICON_BY_KIND[node.kind], 17)]),

        editing === node.id
          ? el("input", {
              class: "input", style: "padding:5px 9px;font-size:.9375rem", value: node.name, maxlength: 80, autofocus: true,
              onblur: function (event) { node.name = event.target.value.trim() || node.name; editing = null; save(); render(); },
              onkeydown: function (event) {
                if (event.key === "Enter") event.target.blur();
                if (event.key === "Escape") { editing = null; render(); }
              }
            })
          : el("span", { class: "nm", text: node.name }),

        el("span", { class: "label", style: "flex-shrink:0", text: count > 0 ? String(count) : "" }),

        el("div", { class: "acts" }, [
          el("button", { class: "mini", type: "button", "aria-label": "Ajouter dans " + node.name, onclick: function () { adding = node.id; expanded[node.id] = true; render(); } }, [icon("plus", 15)]),
          el("button", { class: "mini", type: "button", "aria-label": "Renommer " + node.name, onclick: function () { editing = node.id; render(); } }, [icon("pencil", 14)]),
          el("button", {
            class: "mini warn", type: "button", "aria-label": "Supprimer " + node.name,
            onclick: function () {
              if (count > 0 && !confirm("« " + node.name + " » contient " + count + " objet(s). Ils remonteront au niveau supérieur. Continuer ?")) return;
              var ids = descendantIds(node.id);
              // Les objets remontent au parent : supprimer un meuble ne doit
              // jamais faire disparaître ce qu'il contenait.
              state.items.forEach(function (item) {
                if (ids.indexOf(item.locationId) !== -1) item.locationId = node.parentId;
              });
              state.locations = state.locations.filter(function (l) { return ids.indexOf(l.id) === -1; });
              save(); render();
            }
          }, [icon("trash", 14)])
        ])
      ])];

      if (adding === node.id) {
        rows.push(el("div", { class: "inline", style: "padding:6px 8px 6px " + ((depth + 1) * 18 + 34) + "px;gap:6px" }, [
          el("input", {
            class: "input", style: "flex:1;padding:7px 12px;font-size:.875rem", autofocus: true,
            placeholder: childKind(node.kind) === "furniture" ? "Nouveau meuble" : "Nouveau contenant",
            onkeydown: function (event) {
              if (event.key === "Enter") addNode(node, event.target.value);
              if (event.key === "Escape") { adding = null; render(); }
            }
          }),
          childKind(node.kind) === "furniture"
            ? el("button", {
                class: "btn btn-sm btn-line", type: "button",
                onclick: function () {
                  // Le même catalogue illustré qu'à l'installation : on ne
                  // devine pas mieux le nom d'un meuble six mois plus tard.
                  var basket = { label: node.name, furniture: [] };
                  var existing = childrenOf(node.id).map(function (child) { return child.name; });
                  furniturePicker(basket, function () {
                    basket.furniture.forEach(function (name) {
                      state.locations.push({
                        id: uid("loc"), parentId: node.id, kind: "furniture",
                        name: name, icon: null, floor: node.floor
                      });
                    });
                    adding = null;
                    if (basket.furniture.length) { save(); toast(plural(basket.furniture.length, "rangement ajouté", "rangements ajoutés") + "."); }
                    render();
                  }, existing);
                }
              }, [icon("grid", 14), "Catalogue"])
            : null,
          el("button", { class: "mini", type: "button", "aria-label": "Annuler", onclick: function () { adding = null; render(); } }, [icon("x", 15)])
        ]));
      }

      if (open) kids.forEach(function (child) { rows = rows.concat(renderNode(child, depth + 1)); });
      return rows;
    }

    var roots = state.locations.filter(function (l) { return !l.parentId; });
    var treeRows = [];
    roots.forEach(function (node) { treeRows = treeRows.concat(renderNode(node, 0)); });

    return el("div", { class: "page" }, [
      el("h1", { class: "display t-lg", text: "Mes lieux" }),
      el("p", { class: "lede", style: "margin-top:10px", text: "L'architecture de votre logement. Ajoutez, renommez, réorganisez à tout moment." }),

      el("div", { class: "tree", style: "margin-top:22px" }, treeRows.length ? treeRows : [
        el("p", { class: "muted", style: "padding:18px;text-align:center;font-size:.9375rem", text: "Aucun lieu. Ajoutez une pièce pour commencer." })
      ]),

      adding === "root"
        ? el("div", { class: "inline", style: "margin-top:14px" }, [
            el("input", {
              class: "input", style: "flex:1;min-width:180px", placeholder: "Nouvelle pièce ou zone", autofocus: true,
              onkeydown: function (event) {
                if (event.key === "Enter") addNode(null, event.target.value);
                if (event.key === "Escape") { adding = null; render(); }
              }
            }),
            el("button", { class: "btn btn-line", type: "button", onclick: function () { adding = null; render(); } }, "Annuler")
          ])
        : el("button", {
            class: "btn btn-line", type: "button", style: "margin-top:14px",
            onclick: function () { adding = "root"; render(); }
          }, [icon("plus", 15), "Nouvelle pièce ou zone"])
    ]);
  }

  /* ─── Vue : scan ──────────────────────────────────────────────────── */

  var scanState = { image: null, busy: false, detected: null, note: "", target: null, error: null, demo: false };

  /* Détection de démonstration.

     Toutes les vues ne peuvent pas envoyer d'image à l'assistant — c'est une
     capacité que le lecteur accorde ou non, et le prototype n'y peut rien.
     Plutôt qu'un message d'erreur et une impasse, on joue le parcours complet
     avec un résultat écrit d'avance, clairement annoncé : ce qui compte pour
     évaluer la fonction, c'est le geste (détecter, décocher, corriger,
     enregistrer), pas la performance du modèle. */
  var SCAN_DEMO = [
    { name: "Clé à molette 30 mm", quantity: 1, tags: ["outillage"], confidence: "high" },
    { name: "Tournevis cruciforme", quantity: 4, tags: ["outillage"], confidence: "high" },
    { name: "Mètre ruban 5 m", quantity: 1, tags: ["outillage"], confidence: "high" },
    { name: "Boîte de vis 4 mm", quantity: 1, tags: ["outillage", "visserie"], confidence: "high" },
    { name: "Pince coupante", quantity: 1, tags: ["outillage"], confidence: "medium" },
    { name: "Niveau à bulle", quantity: 1, tags: ["outillage"], confidence: "medium" }
  ];

  function runScanDemo() {
    scanState.error = null;
    scanState.detected = null;
    scanState.image = null;
    scanState.demo = true;
    scanState.busy = true;
    render();
    // Une latence courte, pour que l'écran d'analyse existe : sans elle on
    // passe du bouton au résultat sans comprendre ce qui s'est passé.
    setTimeout(function () {
      scanState.busy = false;
      scanState.detected = SCAN_DEMO.map(function (item) {
        return {
          name: item.name, quantity: item.quantity, tags: item.tags.slice(),
          confidence: item.confidence, keep: true
        };
      });
      scanState.note = "Détection de démonstration : cette vue ne peut pas envoyer de photo à l'assistant.";
      render();
    }, 900);
  }

  function viewScan() {
    if (state.plan !== "premium") return paywall("Scan Éclair", "Filmez un tiroir, il se remplit tout seul. L'IA détecte les objets, les nomme et les pré-range.");

    function analyse(file) {
      scanState.error = null;
      scanState.detected = null;

      var reader = new FileReader();
      reader.onload = function () {
        var image = new Image();
        image.onload = function () {
          // Redimensionnement AVANT l'envoi : une photo de téléphone pèse
          // plusieurs mégaoctets ; à 1400 px elle tombe sous 300 Ko, sans rien
          // retirer à la reconnaissance.
          var scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(image.naturalWidth * scale);
          canvas.height = Math.round(image.naturalHeight * scale);
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

          scanState.image = canvas.toDataURL("image/jpeg", 0.82);
          scanState.busy = true;
          render();

          canvas.toBlob(function (blob) {
            if (!sampleApi || !blob) {
              scanState.busy = false;
              scanState.error = "L'assistant n'est pas disponible dans cette vue.";
              render();
              return;
            }

            var prompt =
              "Tu regardes la photo d'un rangement domestique (étagère, tiroir, placard, servante).\n\n" +
              "Liste les objets RANGEABLES et IDENTIFIABLES que tu vois, pour aider quelqu'un à les retrouver plus tard.\n\n" +
              "Règles :\n" +
              "- Nomme chaque objet comme son propriétaire le chercherait : « clé à molette », pas « outil métallique à mâchoire réglable ».\n" +
              "- Regroupe les objets identiques en une seule entrée avec la quantité.\n" +
              "- Ignore le mobilier lui-même, les murs, le sol et les éléments de structure.\n" +
              "- Ignore ce que tu ne peux pas identifier avec un minimum de certitude.\n" +
              "- N'invente rien. Une photo floue avec deux objets reconnaissables donne deux entrées, pas dix.\n\n" +
              "Réponds UNIQUEMENT par un objet JSON :\n" +
              '{"items": [{"name": "...", "quantity": 1, "tags": ["..."], "confidence": "high|medium|low"}], "note": "remarque courte si la photo est difficile"}';

            sampleApi.json(prompt, { images: blob, modelTier: "default" })
              .then(function (result) {
                scanState.busy = false;
                var items = (result && result.items ? result.items : [])
                  // Les identifications peu sûres sont écartées : corriger une
                  // mauvaise suggestion coûte plus cher que d'ajouter l'objet
                  // oublié à la main.
                  .filter(function (item) { return item && item.name && item.confidence !== "low"; })
                  .map(function (item) {
                    return {
                      name: String(item.name).slice(0, 120),
                      quantity: Math.max(1, Math.min(500, parseInt(item.quantity, 10) || 1)),
                      tags: (item.tags || []).slice(0, 4).map(String),
                      confidence: item.confidence === "medium" ? "medium" : "high",
                      keep: true
                    };
                  });

                if (items.length === 0) {
                  scanState.error = (result && result.note) || "Rien d'identifiable sur cette image. Rapprochez-vous et réessayez.";
                } else {
                  scanState.detected = items;
                  scanState.note = (result && result.note) || "";
                }
                render();
              })
              .catch(function (error) {
                scanState.busy = false;
                var code = error && error.code;
                // Cette vue ne prend pas d'image : on ne laisse pas
                // l'utilisateur devant une impasse, on lui montre le parcours.
                if (code === "images_unavailable") {
                  sampleImages = null;
                  sampleChecked = true;
                  runScanDemo();
                  return;
                }
                scanState.error =
                  code === "not_granted" ? "Accès à l'assistant refusé."
                  : code === "rate_limited" ? "Trop de demandes, réessayez dans un instant."
                  : code === "image_rejected" ? "Cette image n'a pas pu être lue."
                  : "L'analyse a échoué.";
                render();
              });
          }, "image/jpeg", 0.82);
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    }

    function saveAll() {
      var keepers = scanState.detected.filter(function (item) { return item.keep; });
      var now = Date.now();
      keepers.forEach(function (item, index) {
        state.items.push({
          id: uid("it"), name: item.name, locationId: scanState.target || null, spot: null,
          tags: item.tags, description: null, quantity: item.quantity,
          expiresAt: null, warrantyUntil: null, lentTo: null, lentAt: null,
          lastSeenAt: now - index, createdAt: now - index
        });
      });
      save();
      scanState = { image: null, busy: false, detected: null, note: "", target: scanState.target, error: null };
      state.tab = "search";
      render();
      toast(plural(keepers.length, "objet enregistré", "objets enregistrés") + ".");
    }

    var kept = scanState.detected ? scanState.detected.filter(function (i) { return i.keep; }).length : 0;
    /* Tant que les limites n'ont pas répondu, on garde le bouton photo : c'est
       le parcours normal, et la bascule se fera au premier rendu suivant. Une
       fois la réponse connue, il faut un assistant ET le droit de lui envoyer
       une image — sans l'un des deux, le bouton n'ouvrirait l'appareil photo
       que pour finir sur un message d'erreur. */
    var photoAvailable = !sampleChecked || (!!sampleApi && !!sampleImages);

    return el("div", { class: "page" }, [
      el("div", { class: "inline", style: "gap:12px" }, [
        el("h1", { class: "display t-lg", text: "Scan Éclair" }),
        el("span", { class: "label badge", text: "Éclair" })
      ]),
      el("p", { class: "lede", style: "margin-top:10px", text: "Photographiez une étagère ou un tiroir. L'IA identifie les objets et pré-remplit le référencement." }),

      (function () {
        var field = locationField({
          label: "Ranger dans",
          value: scanState.target,
          placeholder: "Rechercher une pièce, un meuble…",
          onChange: function (id) { scanState.target = id; }
        });
        field.style.marginTop = "22px";
        return field;
      })(),

      el("div", { class: "scan-stage", style: "margin-top:16px" }, [
        scanState.image
          ? el("img", { src: scanState.image, alt: "Photo à analyser" })
          : el("div", { class: "stack-sm", style: "text-align:center;padding:24px;align-items:center" }, [
              icon("scan", 30),
              el("p", { class: "muted", style: "font-size:.875rem;max-width:34ch", text: photoAvailable ? "Prenez une photo d'un rangement, ou importez-en une depuis votre appareil." : "Démonstration : le résultat d'une analyse d'étagère, à corriger puis enregistrer." })
            ]),
        scanState.busy ? el("div", { class: "scan-overlay" }, [
          el("div", { class: "spin", "aria-hidden": "true" }),
          el("p", { style: "font-size:.9375rem", text: "Analyse en cours…" })
        ]) : null
      ]),

      scanState.error ? el("p", { class: "err", role: "alert", style: "margin-top:14px", text: scanState.error }) : null,

      !scanState.detected ? (photoAvailable
        ? el("div", { class: "inline", style: "margin-top:16px" }, [
            (function () {
              var input = el("input", {
                type: "file", accept: sampleImages ? sampleImages.mediaTypes.join(",") : "image/*",
                capture: "environment", style: "display:none",
                onchange: function (event) {
                  var file = event.target.files && event.target.files[0];
                  if (file) analyse(file);
                  event.target.value = "";
                }
              });
              var button = el("button", {
                class: "btn btn-volt", type: "button", disabled: scanState.busy,
                onclick: function () { input.click(); }
              }, [icon("scan", 16), scanState.image ? "Reprendre une photo" : "Prendre ou importer une photo"]);
              return el("span", { class: "inline" }, [input, button]);
            })()
          ])
        : el("div", { class: "stack-sm", style: "margin-top:16px" }, [
            el("p", { class: "muted", style: "font-size:.8125rem;max-width:52ch", text: "Cette vue ne peut pas transmettre de photo à l'assistant. Sur l'application installée, le bouton ouvre l'appareil photo ; ici vous pouvez dérouler le même parcours avec une détection de démonstration." }),
            el("button", {
              class: "btn btn-volt", type: "button", disabled: scanState.busy,
              onclick: function () { runScanDemo(); }
            }, [icon("scan", 16), "Lancer une détection de démonstration"])
          ])) : null,

      scanState.detected ? el("div", { style: "margin-top:22px" }, [
        el("div", { class: "inline", style: "justify-content:space-between" }, [
          el("p", { class: "label", style: "color:var(--accent)", text: plural(scanState.detected.length, "objet détecté", "objets détectés") }),
          el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: function () { scanState.detected = null; scanState.image = null; render(); } }, "Recommencer")
        ]),
        scanState.note ? el("p", { class: "muted", style: "font-size:.8125rem;margin-top:8px", text: scanState.note }) : null,
        el("p", { class: "muted", style: "font-size:.8125rem;margin-top:8px", text: "Décochez ce que vous ne voulez pas, corrigez les noms, puis validez." }),

        el("ul", { class: "row-list", style: "margin-top:14px" }, scanState.detected.map(function (item, index) {
          return el("li", { class: "row", style: item.keep ? "" : "opacity:.45" }, [
            el("button", {
              class: "mini", type: "button", role: "checkbox",
              "aria-checked": item.keep ? "true" : "false", "aria-label": item.name,
              style: "border:2px solid " + (item.keep ? "var(--volt)" : "var(--line)") + ";background:" + (item.keep ? "var(--volt)" : "transparent") + ";color:var(--ink);width:22px;height:22px;border-radius:6px",
              onclick: function () { scanState.detected[index].keep = !item.keep; render(); }
            }, [item.keep ? icon("check", 12) : null]),
            el("input", {
              class: "bare", value: item.name, maxlength: 120, "aria-label": "Nom de l'objet",
              oninput: function (event) { scanState.detected[index].name = event.target.value; }
            }),
            item.quantity > 1 ? el("span", { class: "label", text: "×" + item.quantity }) : null,
            item.confidence === "medium" ? el("span", { class: "label", style: "color:var(--warn)", text: "?" }) : null
          ]);
        })),

        el("button", {
          class: "btn btn-lg btn-volt", type: "button", style: "margin-top:20px;width:100%",
          disabled: kept === 0, onclick: saveAll,
          text: "Tout enregistrer (" + kept + ")"
        })
      ]) : null,

      el("p", {
        class: "label",
        style: "text-transform:none;letter-spacing:.04em;font-size:.75rem;line-height:1.7;margin-top:26px;color:var(--faint)",
        text: "La photo est réduite dans le navigateur avant l'envoi, et seule cette image part. Le reste de votre inventaire ne quitte pas l'appareil."
      })
    ]);
  }

  /* ═══ Scanner une pièce à la caméra ════════════════════════════════════

     WebXR, session « immersive-ar », module `depth-sensing`. Sur Android,
     Chrome s'appuie sur ARCore : à chaque image, il rend une CARTE DE
     PROFONDEUR alignée sur la caméra, plus la pose exacte du téléphone dans
     la pièce. Ces deux informations suffisent — on déplie chaque échantillon
     de profondeur en un point du monde, et la pièce se construit à mesure
     qu'on avance. Rien ne part sur un serveur : tout est calculé sur
     l'appareil, image par image.

     Ce que cela ne couvre pas : iOS. Safari n'expose pas la réalité augmentée
     WebXR, et le LiDAR de l'iPhone n'est lisible que par une application
     native. Pour ces appareils, la filière reste Scaniverse -> .ply ->
     import — que la vue propose juste à côté, et qui donne d'ailleurs un
     meilleur résultat.

     Sources : spécification du module (immersive-web/depth-sensing) et module
     d'accès caméra brut (immersive-web/raw-camera-access). */

  var AR_VOXEL = 0.035;        // 3,5 cm — en dessous, on enregistre du bruit
  var AR_MAX_POINTS = 150000;
  var AR_NEAR = 0.35, AR_FAR = 5.5;   // hors de cette plage, ARCore invente
  var AR_SX = 36, AR_SY = 27;         // grille d'échantillonnage par image

  /* La panoramique sphérique est la voie universelle : elle ne demande que la
     caméra et l'accéléromètre, que tout téléphone expose depuis dix ans. C'est
     la SEULE capture possible sur iPhone, puisque Safari n'ouvre ni la réalité
     augmentée WebXR ni le LiDAR au web. */
  function panoSupport() {
    if (!window.FulmoPanoCapture) return Promise.resolve("absent");
    return window.FulmoPanoCapture.support();
  }

  function arSupport() {
    if (!window.isSecureContext) return Promise.resolve("insecure");
    if (!navigator.xr || !navigator.xr.isSessionSupported) return Promise.resolve("absent");
    return navigator.xr.isSessionSupported("immersive-ar")
      .then(function (ok) { return ok ? "ready" : "absent"; })
      .catch(function () { return "absent"; });
  }

  /* Inversion d'une matrice 4×4 (colonnes), pour remonter de l'écran vers le
     rayon caméra. Écrite à la main : c'est la seule inversion du fichier, et
     elle n'a pas besoin d'une bibliothèque. */
  function invert4(m) {
    var a00=m[0],a01=m[1],a02=m[2],a03=m[3], a10=m[4],a11=m[5],a12=m[6],a13=m[7],
        a20=m[8],a21=m[9],a22=m[10],a23=m[11], a30=m[12],a31=m[13],a32=m[14],a33=m[15];
    var b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10,
        b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12,
        b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30,
        b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
    var det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
    if (!det) return null;
    det = 1 / det;
    return new Float32Array([
      (a11*b11-a12*b10+a13*b09)*det, (a02*b10-a01*b11-a03*b09)*det,
      (a31*b05-a32*b04+a33*b03)*det, (a22*b04-a21*b05-a23*b03)*det,
      (a12*b08-a10*b11-a13*b07)*det, (a00*b11-a02*b08+a03*b07)*det,
      (a32*b02-a30*b05-a33*b01)*det, (a20*b05-a22*b02+a23*b01)*det,
      (a10*b10-a11*b08+a13*b06)*det, (a01*b08-a00*b10-a03*b06)*det,
      (a30*b04-a31*b02+a33*b00)*det, (a21*b02-a20*b04-a23*b00)*det,
      (a11*b07-a10*b09-a12*b06)*det, (a00*b09-a01*b07+a02*b06)*det,
      (a31*b01-a30*b03-a32*b00)*det, (a20*b03-a21*b01+a22*b00)*det
    ]);
  }

  var CAM_W = 96, CAM_H = 72;

  /* Lecture de l'image caméra. Sans elle le nuage n'a pas de couleur et la
     pièce se lit par sa seule géométrie — reconnaissable, mais moins. C'est
     un bonus : tout est sous `try`, et la palette de hauteur prend le relais. */
  function cameraReader(gl) {
    var vs = ["#version 300 es", "in vec2 p;", "out vec2 uv;",
              "void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }"].join("\n");
    var fs = ["#version 300 es", "precision mediump float;", "in vec2 uv;",
              "uniform sampler2D tex;", "out vec4 frag;",
              "void main(){ frag = texture(tex, uv); }"].join("\n");

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    var target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CAM_W, CAM_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    var complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) return null;

    var pixels = new Uint8Array(CAM_W * CAM_H * 4);

    return {
      pixels: pixels,
      grab: function (texture) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, CAM_W, CAM_H);
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(gl.getUniformLocation(prog, "tex"), 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, CAM_W, CAM_H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    };
  }

  /* La capture. Rend une promesse : le nuage relevé, ou null si l'utilisateur
     a renoncé. Toute l'interface de la session vit dans `overlay`, que WebXR
     superpose à l'image de la caméra grâce au module `dom-overlay`. */
  function arCapture(roomName, onProgress) {
    var overlay = el("div", { class: "ar-hud" });
    document.body.appendChild(overlay);

    var glCanvas = document.createElement("canvas");
    var gl = glCanvas.getContext("webgl2", { xrCompatible: true, alpha: true, antialias: false });

    function teardown() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    if (!gl) {
      teardown();
      return Promise.reject(new Error("WebGL2 est nécessaire à la capture."));
    }

    return navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["depth-sensing"],
      optionalFeatures: ["dom-overlay", "camera-access", "local-floor"],
      depthSensing: {
        usagePreference: ["cpu-optimized"],
        dataFormatPreference: ["luminance-alpha", "float32"]
      },
      domOverlay: { root: overlay }
    }).then(function (session) {
      return new Promise(function (resolve, reject) {

        if (session.depthUsage && session.depthUsage !== "cpu-optimized") {
          session.end();
          teardown();
          return reject(new Error("Cet appareil ne rend la profondeur qu'au processeur graphique, que le prototype ne sait pas relire."));
        }

        // ─── Ce que l'on accumule ───────────────────────────────────────
        var posList = new Float32Array(AR_MAX_POINTS * 3);
        var colList = new Uint8Array(AR_MAX_POINTS * 3);
        var total = 0;
        var seen = new Set();          // voxels de 3,5 cm déjà relevés
        var coarse = new Set();        // voxels de 30 cm, pour la couverture
        var cancelled = false, ended = false;
        var reader = null, binding = null, camGrabs = 0;

        try { binding = new XRWebGLBinding(session, gl); } catch (e) { binding = null; }
        try { reader = binding ? cameraReader(gl) : null; } catch (e) { reader = null; }

        // ─── L'interface par-dessus la caméra ───────────────────────────
        var stat = el("b", { text: "0" });
        var hint = el("span", { class: "ar-hint", text: "Avancez lentement. Balayez les murs, puis chaque meuble." });
        var gauge = el("i", { style: "width:0%" });

        var done = el("button", { class: "btn btn-volt ar-done", type: "button" }, [icon("check", 17), "Terminer le scan"]);
        done.addEventListener("click", function () { session.end(); });

        var quit = el("button", { class: "ar-quit", type: "button", "aria-label": "Annuler" }, [icon("x", 18)]);
        quit.addEventListener("click", function () { cancelled = true; session.end(); });

        overlay.replaceChildren(
          el("div", { class: "ar-top" }, [
            el("span", { class: "ar-room" }, [el("span", { class: "ar-dot" }), roomName]),
            quit
          ]),
          el("div", { class: "ar-bottom" }, [
            hint,
            el("div", { class: "ar-gauge" }, [gauge]),
            el("p", { class: "ar-stat" }, [stat, " points relevés"]),
            done
          ])
        );

        // ─── La session ─────────────────────────────────────────────────
        var refSpace = null;
        session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

        session.addEventListener("end", function () {
          ended = true;
          teardown();
          if (cancelled || total < 400) return resolve(null);
          var cloud = makeCloud(posList.slice(0, total * 3), colList.slice(0, total * 3));
          resolve(recentreCloud(cloud));
        });

        function sampleView(frame, view) {
          var depth;
          try { depth = frame.getDepthInformation(view); } catch (e) { return; }
          if (!depth || !depth.getDepthInMeters) return;

          var invProj = invert4(view.projectionMatrix);
          if (!invProj) return;
          var toWorld = view.transform.matrix;

          for (var gy = 0; gy < AR_SY; gy++) {
            // Coordonnées de vue normalisées : origine en HAUT à gauche.
            // C'est la convention du module de profondeur, et elle décide du
            // sens de tout le nuage.
            var v = (gy + 0.5) / AR_SY;
            var ndcY = 1 - v * 2;

            for (var gx = 0; gx < AR_SX; gx++) {
              var u = (gx + 0.5) / AR_SX;
              var metres;
              try { metres = depth.getDepthInMeters(u, v); } catch (e) { continue; }
              if (!(metres > AR_NEAR) || metres > AR_FAR) continue;

              // Rayon caméra passant par ce pixel, puis mise à l'échelle pour
              // que sa profondeur vaille exactement la mesure.
              var ndcX = u * 2 - 1;
              var ox = invProj[0]*ndcX + invProj[4]*ndcY - invProj[8] + invProj[12];
              var oy = invProj[1]*ndcX + invProj[5]*ndcY - invProj[9] + invProj[13];
              var oz = invProj[2]*ndcX + invProj[6]*ndcY - invProj[10] + invProj[14];
              var ow = invProj[3]*ndcX + invProj[7]*ndcY - invProj[11] + invProj[15];
              if (!ow) continue;
              ox /= ow; oy /= ow; oz /= ow;
              if (oz >= 0) continue;

              var k = metres / -oz;
              var vx = ox * k, vy = oy * k, vz = oz * k;

              var wx = toWorld[0]*vx + toWorld[4]*vy + toWorld[8]*vz + toWorld[12];
              var wy = toWorld[1]*vx + toWorld[5]*vy + toWorld[9]*vz + toWorld[13];
              var wz = toWorld[2]*vx + toWorld[6]*vy + toWorld[10]*vz + toWorld[14];

              var ix = Math.round(wx / AR_VOXEL), iy = Math.round(wy / AR_VOXEL), iz = Math.round(wz / AR_VOXEL);
              if (ix < -1000 || ix > 1000 || iy < -1000 || iy > 1000 || iz < -1000 || iz > 1000) continue;
              var key = (ix + 1024) * 4194304 + (iy + 1024) * 2048 + (iz + 1024);
              if (seen.has(key)) continue;
              seen.add(key);

              var r = 205, g = 208, b = 214;
              if (reader) {
                // readPixels lit de bas en haut : on retourne v pour retomber
                // sur la même ligne que l'échantillon de profondeur.
                var cxp = Math.min(CAM_W - 1, (u * CAM_W) | 0);
                var cyp = Math.min(CAM_H - 1, ((1 - v) * CAM_H) | 0);
                var o = (cyp * CAM_W + cxp) * 4;
                r = reader.pixels[o]; g = reader.pixels[o + 1]; b = reader.pixels[o + 2];
              }

              posList[total * 3] = wx; posList[total * 3 + 1] = wy; posList[total * 3 + 2] = wz;
              colList[total * 3] = r; colList[total * 3 + 1] = g; colList[total * 3 + 2] = b;
              total += 1;

              coarse.add(Math.round(wx / 0.3) * 1048576 + Math.round(wy / 0.3) * 1024 + Math.round(wz / 0.3));
              if (total >= AR_MAX_POINTS) return;
            }
          }
        }

        function onFrame(time, frame) {
          if (ended) return;
          try { session.requestAnimationFrame(onFrame); } catch (e) { return; }

          var pose = refSpace ? frame.getViewerPose(refSpace) : null;
          if (!pose) return;

          var layer = session.renderState.baseLayer;
          gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

          for (var i = 0; i < pose.views.length; i++) {
            var view = pose.views[i];

            // Une image caméra toutes les trois passes : la couleur d'une
            // pièce ne change pas d'une image à l'autre, et la relecture de
            // pixels est ce qui coûte le plus cher ici.
            if (reader && binding && view.camera && camGrabs % 3 === 0) {
              try { reader.grab(binding.getCameraImage(view.camera)); }
              catch (e) { reader = null; }
            }
            camGrabs += 1;

            if (total < AR_MAX_POINTS) sampleView(frame, view);
            break;   // un téléphone n'a qu'une vue ; inutile de doubler le relevé
          }

          stat.textContent = total.toLocaleString("fr-FR");
          var fill = Math.min(1, total / 90000);
          gauge.style.width = (fill * 100).toFixed(0) + "%";
          hint.textContent =
            total < 6000 ? "Avancez lentement. Balayez les murs, puis chaque meuble."
            : total < 30000 ? "Bien. Continuez le long des rangements."
            : total < 70000 ? "La pièce prend forme. Complétez les angles."
            : "Relevé complet. Vous pouvez terminer.";
          if (onProgress) onProgress(total, coarse.size);
        }

        session.requestReferenceSpace("local-floor")
          .catch(function () { return session.requestReferenceSpace("local"); })
          .then(function (space) {
            refSpace = space;
            session.requestAnimationFrame(onFrame);
          })
          .catch(function (error) {
            session.end();
            teardown();
            reject(error);
          });
      });
    }).catch(function (error) {
      teardown();
      throw error;
    });
  }

  /* ═══ Lecture d'un fichier .ply ════════════════════════════════════════

     C'est le format de sortie de Scaniverse, Polycam, Luma et de tous les
     solveurs de splatting. On n'en garde que ce dont la vue a besoin — une
     position et une couleur — et on jette le reste : opacité, échelles,
     rotations, harmoniques d'ordre supérieur. Un nuage de points n'a pas
     besoin de savoir briller.

     Deux encodages de couleur cohabitent : `red/green/blue` pour un nuage
     classique, `f_dc_0..2` pour un fichier de splats gaussiens, où la couleur
     est le terme constant des harmoniques sphériques. */

  var SH_C0 = 0.28209479177387814;

  var PLY_SIZES = {
    "char": 1, "int8": 1, "uchar": 1, "uint8": 1,
    "short": 2, "int16": 2, "ushort": 2, "uint16": 2,
    "int": 4, "int32": 4, "uint": 4, "uint32": 4,
    "float": 4, "float32": 4, "double": 8, "float64": 8
  };

  function plyRead(dv, base, prop, little) {
    var at = base + prop.offset;
    switch (prop.type) {
      case "float": case "float32": return dv.getFloat32(at, little);
      case "double": case "float64": return dv.getFloat64(at, little);
      case "uchar": case "uint8": return dv.getUint8(at);
      case "char": case "int8": return dv.getInt8(at);
      case "ushort": case "uint16": return dv.getUint16(at, little);
      case "short": case "int16": return dv.getInt16(at, little);
      case "uint": case "uint32": return dv.getUint32(at, little);
      default: return dv.getInt32(at, little);
    }
  }

  function parsePly(buffer, maxPoints) {
    var bytes = new Uint8Array(buffer);

    // L'en-tête est en texte, le corps souvent binaire : on lit octet par
    // octet jusqu'à « end_header » plutôt que de décoder tout le fichier.
    var header = "", body = -1;
    for (var i = 0; i < bytes.length && i < 1048576; i++) {
      header += String.fromCharCode(bytes[i]);
      if (header.slice(-10) === "end_header") {
        var j = i + 1;
        if (bytes[j] === 13) j += 1;
        if (bytes[j] === 10) j += 1;
        body = j;
        break;
      }
    }
    if (body < 0) throw new Error("Ce fichier n'a pas d'en-tête .ply lisible.");

    var format = "ascii", count = 0, props = [], inVertex = false;
    header.split(/\r?\n/).forEach(function (line) {
      var t = line.trim().split(/\s+/);
      if (t[0] === "format") format = t[1];
      else if (t[0] === "element") {
        inVertex = t[1] === "vertex";
        if (inVertex) count = parseInt(t[2], 10) || 0;
      } else if (t[0] === "property" && inVertex) {
        if (t[1] === "list") throw new Error("Sommets à propriétés variables : non géré.");
        props.push({ type: t[1], name: t[2] });
      }
    });
    if (!count || props.length === 0) throw new Error("Aucun sommet dans ce fichier.");

    var stride = 0;
    props.forEach(function (prop, index) {
      prop.size = PLY_SIZES[prop.type];
      if (!prop.size) throw new Error("Type de propriété inconnu : " + prop.type);
      prop.offset = stride;
      prop.index = index;
      stride += prop.size;
    });

    function find(name) {
      for (var k = 0; k < props.length; k++) if (props[k].name === name) return props[k];
      return null;
    }
    var px = find("x"), py = find("y"), pz = find("z");
    if (!px || !py || !pz) throw new Error("Ce fichier ne porte pas de coordonnées x, y, z.");

    var cr = find("red") || find("r"), cg = find("green") || find("g"), cb = find("blue") || find("b");
    var dc0 = find("f_dc_0"), dc1 = find("f_dc_1"), dc2 = find("f_dc_2");
    var byteColor = cr && (cr.type === "uchar" || cr.type === "uint8");

    // Sous-échantillonnage régulier : un fichier de splats dépasse souvent le
    // million de points, et un téléphone n'en affiche pas tant. Un pas
    // constant préserve la forme de la pièce ; un tirage au hasard, non.
    var cap = maxPoints || 200000;
    var step = Math.max(1, Math.ceil(count / cap));
    var kept = Math.ceil(count / step);

    var pos = new Float32Array(kept * 3);
    var col = new Uint8Array(kept * 3);
    var out = 0;

    function push(x, y, z, r, g, bl) {
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
      pos[out * 3] = x; pos[out * 3 + 1] = y; pos[out * 3 + 2] = z;
      col[out * 3] = r; col[out * 3 + 1] = g; col[out * 3 + 2] = bl;
      out += 1;
    }

    function colourOf(read) {
      if (cr && cg && cb) {
        var k = byteColor ? 1 : 255;
        return [
          Math.max(0, Math.min(255, read(cr) * k)),
          Math.max(0, Math.min(255, read(cg) * k)),
          Math.max(0, Math.min(255, read(cb) * k))
        ];
      }
      if (dc0 && dc1 && dc2) {
        return [
          Math.max(0, Math.min(255, (0.5 + SH_C0 * read(dc0)) * 255)),
          Math.max(0, Math.min(255, (0.5 + SH_C0 * read(dc1)) * 255)),
          Math.max(0, Math.min(255, (0.5 + SH_C0 * read(dc2)) * 255))
        ];
      }
      return [210, 210, 214];
    }

    if (format === "ascii") {
      var text = new TextDecoder().decode(bytes.subarray(body));
      var lines = text.split(/\r?\n/);
      var index = 0;
      for (var li = 0; li < lines.length && index < count && out < kept; li++) {
        var raw = lines[li].trim();
        if (!raw) continue;
        var take = index % step === 0;
        index += 1;
        if (!take) continue;
        var f = raw.split(/\s+/);
        var get = function (prop) { return parseFloat(f[prop.index]); };
        var c = colourOf(get);
        push(get(px), get(py), get(pz), c[0], c[1], c[2]);
      }
    } else {
      var little = format.indexOf("little") !== -1;
      var dv = new DataView(buffer);
      for (var v = 0; v < count && out < kept; v += step) {
        var base = body + v * stride;
        if (base + stride > bytes.length) break;
        var readBin = function (prop) { return plyRead(dv, base, prop, little); };
        var cc = colourOf(readBin);
        push(readBin(px), readBin(py), readBin(pz), cc[0], cc[1], cc[2]);
      }
    }

    if (out === 0) throw new Error("Aucun point exploitable dans ce fichier.");
    // `slice` et non `subarray` : le clonage vers IndexedDB emporte le tampon
    // ENTIER d'une vue, pas seulement la portion utile.
    return makeCloud(pos.slice(0, out * 3), col.slice(0, out * 3));
  }

  /* ═══ Rendu d'un nuage de points ═══════════════════════════════════════

     Un scan réel n'a pas de covariance : le capteur rend des POINTS, pas des
     ellipsoïdes. On les dessine donc tels quels, en pastilles rondes dont la
     taille décroît avec la distance — comme le ferait le petit carré de
     surface que chacune représente.

     Deux différences avec le rendu par splats, et elles comptent : le test de
     profondeur est actif (un point cache ce qui est derrière, sans tri), et
     la caméra orbite LIBREMENT autour de la pièce. Sur un nuage ouvert, voir
     la pièce de l'extérieur est utile ; sur une coquille fermée, non. */

  var CLOUD_VS = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 pos;",
    "in vec3 rgb;",
    "uniform mat4 view;",
    "uniform vec2 focal;",
    "uniform float sizePx;",
    "uniform float tint;",
    "uniform vec2 span;",
    "out vec3 col;",
    "void main() {",
    "  vec4 cam = view * vec4(pos, 1.0);",
    "  float t = -cam.z;",
    "  if (t < 0.06) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }",
    "  float nearP = 0.06, farP = 60.0;",
    "  float zc = (-(farP + nearP) / (farP - nearP)) * cam.z - (2.0 * farP * nearP) / (farP - nearP);",
    "  gl_Position = vec4(focal.x * cam.x, focal.y * cam.y, zc, t);",
    // sizePx vaut le diamètre à l'écran d'une pastille placée à un mètre :
    // la division par la distance donne la décroissance juste.
    "  gl_PointSize = clamp(sizePx / t, 1.4, 40.0);",
    // La palette de hauteur : un repli quand la capture n'a pas pu lire la
    // couleur de la caméra, et une lecture de volume quand elle l'a pu.
    "  float h = clamp((pos.y - span.x) / max(span.y - span.x, 0.001), 0.0, 1.0);",
    "  vec3 ramp = mix(vec3(0.09, 0.40, 0.62), vec3(0.85, 0.96, 0.52), h);",
    "  col = mix(rgb, ramp, tint);",
    // Atténuation avec la distance : sans elle, le fond et le premier plan se
    // confondent et le volume disparaît.
    "  col *= clamp(1.18 - t * 0.055, 0.60, 1.0);",
    "}"
  ].join("\n");

  var CLOUD_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 col;",
    "out vec4 frag;",
    "void main() {",
    "  vec2 d = gl_PointCoord * 2.0 - 1.0;",
    "  float r2 = dot(d, d);",
    "  if (r2 > 1.0) discard;",
    // Un soupçon de relief sur chaque pastille : elle se lit comme un grain de
    // matière, pas comme un pixel mort.
    "  float shade = 0.70 + 0.30 * sqrt(max(0.0, 1.0 - r2));",
    "  frag = vec4(col * shade, 1.0);",
    "}"
  ].join("\n");

  /* Une pastille éteinte reste dans le document. Un « opacity: 0 » la cache
     à l'œil mais ne la retire ni de la tabulation ni de ce qu'annonce un
     lecteur d'écran : au clavier, on tomberait sur un rangement situé
     derrière soi, sans rien voir bouger à l'écran. On la retire donc
     explicitement, et on la rend au moment où elle réapparaît. */
  function hidePin(node) {
    node.style.opacity = "0";
    node.style.pointerEvents = "none";
    if (node.tabIndex !== -1) { node.tabIndex = -1; }
    if (node.getAttribute("aria-hidden") !== "true") { node.setAttribute("aria-hidden", "true"); }
  }

  function showPin(node) {
    if (node.tabIndex !== 0) { node.tabIndex = 0; }
    if (node.hasAttribute("aria-hidden")) { node.removeAttribute("aria-hidden"); }
  }

  function cloudScene(canvas, pinLayer, cloud, options) {
    var opts = options || {};
    var gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) return null;

    var n = cloud.count;
    var box = cloudBounds(cloud);

    var program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, CLOUD_VS));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, CLOUD_FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    var posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cloud.pos, gl.STATIC_DRAW);
    var locPos = gl.getAttribLocation(program, "pos");
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 3, gl.FLOAT, false, 0, 0);

    var colBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cloud.col, gl.STATIC_DRAW);
    var locCol = gl.getAttribLocation(program, "rgb");
    gl.enableVertexAttribArray(locCol);
    gl.vertexAttribPointer(locCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);

    var uView = gl.getUniformLocation(program, "view");
    var uFocal = gl.getUniformLocation(program, "focal");
    var uSize = gl.getUniformLocation(program, "sizePx");
    var uTint = gl.getUniformLocation(program, "tint");
    var uSpan = gl.getUniformLocation(program, "span");

    var tint = opts.tint == null ? 0 : opts.tint;
    var reach = Math.max(1.2, Math.hypot(box.size[0], box.size[2]));

    /* Quelle taille donner à une pastille ?

       Un nuage de pièce échantillonne des SURFACES, pas un volume : l'aire de
       sa boîte englobante divisée par le nombre de points donne un pas moyen
       plausible. C'est lui qui fixe la taille — trop petite, le nuage devient
       une poussière illisible ; trop grande, une pâte. Le même fichier doit
       aussi se lire pareil sur un téléphone et sur un écran de bureau, d'où
       la mise à l'échelle par la hauteur du canevas au moment du rendu. */
    var area = 2 * (box.size[0] * box.size[2] + box.size[0] * box.size[1] + box.size[2] * box.size[1]);
    var spacing = Math.sqrt(Math.max(area, 0.5) / Math.max(1, n));
    var pointSize = Math.max(0.012, Math.min(0.09, spacing * 1.2)) * (opts.grain || 1);
    /* Vue de départ « maison de poupée » : on regarde DANS la pièce, par
       dessus le mur le plus proche. Une orbite basse donnerait le dos de ce
       mur — exact, et sans intérêt. */
    var cam = {
      yaw: 0, pitch: 0.62, dist: reach * 0.95,
      tx: 0, ty: Math.max(0.5, box.size[1] * 0.45), tz: 0
    };
    var start = { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, tx: cam.tx, ty: cam.ty, tz: cam.tz };
    var fovTan = 0.52;

    var view = new Float32Array(16);
    var running = true, raf = 0;
    var focalX = 1, focalY = 1;

    function buildView() {
      var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      var ex = cam.tx + cam.dist * cp * sy;
      var ey = cam.ty + cam.dist * sp;
      var ez = cam.tz + cam.dist * cp * cy;

      var fx = cam.tx - ex, fy = cam.ty - ey, fz = cam.tz - ez;
      var fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      var rx = -fz, ry = 0, rz = fx;
      var rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
      var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
      view.set([
        rx, ux, -fx, 0,
        ry, uy, -fy, 0,
        rz, uz, -fz, 0,
        -(rx * ex + ry * ey + rz * ez), -(ux * ex + uy * ey + uz * ez), (fx * ex + fy * ey + fz * ez), 1
      ]);
    }

    function placePins(w, h) {
      if (!pinLayer) return;
      var nodes = pinLayer.children;
      for (var i = 0; i < pinPoints.length && i < nodes.length; i++) {
        var p = pinPoints[i];
        var cx = view[0] * p.x + view[4] * p.y + view[8] * p.z + view[12];
        var cy = view[1] * p.x + view[5] * p.y + view[9] * p.z + view[13];
        var cz = view[2] * p.x + view[6] * p.y + view[10] * p.z + view[14];
        var t = -cz;
        if (t <= 0.15) { hidePin(nodes[i]); continue; }
        nodes[i].style.transform = "translate(-50%,-50%) translate(" +
          ((focalX * cx / t * 0.5 + 0.5) * w).toFixed(1) + "px," +
          ((0.5 - focalY * cy / t * 0.5) * h).toFixed(1) + "px)";
        nodes[i].style.opacity = "1";
        nodes[i].style.pointerEvents = "auto";
        showPin(nodes[i]);
      }
    }

    var pinPoints = opts.pins || [];
    var glide = null;

    function focusOn(point) {
      glide = {
        t0: (window.performance || Date).now(), dur: 700,
        sx: cam.tx, sy: cam.ty, sz: cam.tz, sd: cam.dist,
        fx: point.x, fy: point.y, fz: point.z, fd: Math.max(1.1, reach * 0.34)
      };
    }

    /* Un rendu complet déplace le canevas d'un arbre à l'autre : il est
       brièvement détaché. Couper la boucle à la première image détachée
       tuerait la scène à chaque passage d'une pièce à l'autre. On saute donc
       les images, et on ne s'arrête qu'après deux secondes hors du document —
       au-delà, l'utilisateur est parti ailleurs, et ombrer pour personne coûte
       cher. */
    var idle = 0;

    function frame() {
      if (!running) return;
      if (!canvas.isConnected) {
        idle += 1;
        if (idle > 120) { running = false; return; }
        raf = requestAnimationFrame(frame);
        return;
      }
      idle = 0;

      if (glide) {
        var k = Math.min(1, ((window.performance || Date).now() - glide.t0) / glide.dur);
        var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        cam.tx = glide.sx + (glide.fx - glide.sx) * e;
        cam.ty = glide.sy + (glide.fy - glide.sy) * e;
        cam.tz = glide.sz + (glide.fz - glide.sz) * e;
        cam.dist = glide.sd + (glide.fd - glide.sd) * e;
        if (k >= 1) glide = null;
      }

      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== (w * dpr | 0) || canvas.height !== (h * dpr | 0)) {
        canvas.width = w * dpr | 0; canvas.height = h * dpr | 0;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.045, 0.045, 0.055, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      buildView();
      var f = 1 / Math.tan(fovTan);
      focalX = f / (canvas.width / canvas.height || 1); focalY = f;

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(uView, false, view);
      gl.uniform2f(uFocal, focalX, focalY);
      gl.uniform1f(uSize, pointSize * focalY * canvas.height * 0.5);
      gl.uniform1f(uTint, tint);
      gl.uniform2f(uSpan, box.lo[1], box.hi[1]);
      gl.drawArrays(gl.POINTS, 0, n);

      placePins(w, h);
      raf = requestAnimationFrame(frame);
    }

    // ─── Orbite ───────────────────────────────────────────────────────────
    var drag = null, pinching = null, picking = false;

    canvas.addEventListener("pointerdown", function (e) {
      glide = null;
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: 0 };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) return;
      cam.yaw -= (e.clientX - drag.x) * 0.006;
      cam.pitch = Math.max(-0.5, Math.min(1.25, cam.pitch + (e.clientY - drag.y) * 0.005));
      drag.x = e.clientX; drag.y = e.clientY;
      drag.moved = Math.max(drag.moved, Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0));
    });
    canvas.addEventListener("pointerup", function (e) {
      if (drag && drag.moved < 6 && picking && opts.onPick) {
        var hit = pick(e.clientX, e.clientY);
        if (hit) opts.onPick(hit);
      }
      drag = null;
    });
    canvas.addEventListener("pointercancel", function () { drag = null; });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      cam.dist = Math.max(0.5, Math.min(reach * 2.4, cam.dist * (1 + e.deltaY * 0.0012)));
    }, { passive: false });

    // Pincer pour zoomer : sur téléphone, c'est le seul geste de zoom qui
    // existe, et l'espace 3D se regarde surtout sur téléphone.
    canvas.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 2) return;
      pinching = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      drag = null;
    }, { passive: true });
    canvas.addEventListener("touchmove", function (e) {
      if (e.touches.length !== 2 || !pinching) return;
      e.preventDefault();
      var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (d > 0) cam.dist = Math.max(0.5, Math.min(reach * 2.4, cam.dist * (pinching / d)));
      pinching = d;
    }, { passive: false });
    canvas.addEventListener("touchend", function () { pinching = null; });

    /* Désigner un point. Même méthode que pour les splats : on projette le
       nuage et on garde le plus proche de la caméra sous le curseur. */
    function pick(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      var ndcX = (clientX - rect.left) / rect.width * 2 - 1;
      var ndcY = 1 - (clientY - rect.top) / rect.height * 2;
      var tolX = 26 / rect.width, tolY = 26 / rect.height;

      var best = -1, bestT = Infinity;
      for (var i = 0; i < n; i++) {
        var x = cloud.pos[i * 3], y = cloud.pos[i * 3 + 1], z = cloud.pos[i * 3 + 2];
        var cz = view[2] * x + view[6] * y + view[10] * z + view[14];
        var t = -cz;
        if (t <= 0.1 || t >= bestT) continue;
        var cx = view[0] * x + view[4] * y + view[8] * z + view[12];
        if (Math.abs(focalX * cx / t - ndcX) > tolX) continue;
        var cy = view[1] * x + view[5] * y + view[9] * z + view[13];
        if (Math.abs(focalY * cy / t - ndcY) > tolY) continue;
        bestT = t; best = i;
      }
      if (best < 0) return null;
      return { x: cloud.pos[best * 3], y: cloud.pos[best * 3 + 1], z: cloud.pos[best * 3 + 2] };
    }

    frame();

    return {
      count: n,
      kind: "cloud",
      reset: function () {
        cam.yaw = start.yaw; cam.pitch = start.pitch; cam.dist = start.dist;
        cam.tx = start.tx; cam.ty = start.ty; cam.tz = start.tz; glide = null;
      },
      orbit: function (dy) { cam.yaw += dy; },
      focusOn: focusOn,
      setPins: function (points) { pinPoints = points || []; },
      setPicking: function (on) { picking = !!on; canvas.style.cursor = on ? "crosshair" : ""; },
      setTint: function (value) { tint = value ? 1 : 0; },
      tinted: function () { return tint > 0.5; },
      pick: pick,
      dispose: function () {
        running = false;
        cancelAnimationFrame(raf);
        // Le contexte WebGL survit au canevas, qu'on réutilise d'une pièce à
        // l'autre : sans ce ménage, dix changements de pièce laissent dix
        // programmes et trente tampons derrière eux.
        try {
          gl.deleteBuffer(posBuf); gl.deleteBuffer(colBuf);
          gl.deleteVertexArray(vao); gl.deleteProgram(program);
        } catch (e) {}
      }
    };
  }

  /* ═══ Espace 3D — rendu par splats gaussiens ═══════════════════════════

     Ce que fait un « 3D Gaussian Splatting » : la pièce n'est pas un maillage
     de triangles, c'est un nuage d'ellipsoïdes translucides. Chacun porte une
     position, une COVARIANCE (trois axes, donc une forme et une orientation),
     une couleur et une opacité. On projette chaque ellipsoïde à l'écran, du
     plus lointain au plus proche, et l'accumulation redonne la photographie.

     La première version de ce moteur dessinait des disques isotropes face
     caméra. C'était faux, et ça se voyait : le rendu ressemblait à du coton.
     Un splat posé sur un mur est une CRÊPE plaquée dans le plan du mur, pas
     une bille ; c'est cette anisotropie qui fait qu'un scan a l'air d'une
     photo. La projection ci-dessous est donc la vraie : covariance 3D,
     jacobienne de la projection perspective, ellipse d'écran par
     décomposition propre.

     Écrit en WebGL2 nu, sans bibliothèque : le prototype doit rester un seul
     fichier qui marche hors ligne. En production on utilisera Spark, qui lit
     directement le .spz sorti d'un téléphone — voir docs/SPLATTING.md. */

  var SPLAT_VS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 corner;",             // coin du quad, en unités d'écart-type
    "in vec3 center;",
    "in vec3 axA;",                // les trois demi-axes de l'ellipsoïde,
    "in vec3 axB;",                // direction ET longueur. Deux grands dans
    "in vec3 axN;",                // la surface, un minuscule selon la normale.
    "in vec4 rgba;",
    "uniform mat4 view;",
    "uniform vec2 focal;",         // proj[0][0] et proj[1][1]
    "uniform vec2 invRes;",
    "out vec2 uv;",
    "out vec4 col;",

    "void main() {",
    "  vec4 cam = view * vec4(center, 1.0);",
    "  float t = -cam.z;",
        // La caméra est DANS la pièce : les splats du mur derrière elle passent à
    // quelques centimètres de l'œil, et leur projection couvre alors tout
    // l'écran. Un vrai scan ne présente jamais ce cas — on le coupe.
    "  if (t < 0.55) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }",

    // Covariance 3D : la somme des produits extérieurs des trois demi-axes.
    // C'est équivalent à R·S·Sᵀ·Rᵀ, sans passer par un quaternion.
    "  mat3 sigma = outerProduct(axA, axA) + outerProduct(axB, axB) + outerProduct(axN, axN);",

    // Passage en repère caméra.
    "  mat3 W = mat3(view);",
    "  mat3 sigmaCam = W * sigma * transpose(W);",

    // Jacobienne de la projection perspective au point considéré. C'est elle
    // qui fait qu'un splat s'allonge quand on le regarde de biais.
    "  float inv = 1.0 / t;",
    "  float inv2 = inv * inv;",
    "  mat3x2 J = mat3x2(",
    "    focal.x * inv, 0.0,",
    "    0.0,           focal.y * inv,",
    "    focal.x * cam.x * inv2, focal.y * cam.y * inv2",
    "  );",

    // Covariance 2D en coordonnées normalisées.
    "  mat2 cov = J * sigmaCam * transpose(J);",

    // Dilatation d'un demi-pixel : sans elle, les splats sous-pixel
    // disparaissent et le nuage scintille au moindre mouvement.
    "  float px = invRes.x * 2.0;",
    "  cov[0][0] += px * px * 0.36;",
    "  cov[1][1] += px * px * 0.36;",

    // Décomposition propre d'une matrice 2×2 symétrique : les deux axes de
    // l'ellipse à l'écran.
    "  float a = cov[0][0], b = cov[0][1], c = cov[1][1];",
    "  float mid = 0.5 * (a + c);",
    "  float rad = sqrt(max(mid * mid - (a * c - b * b), 1e-9));",
    "  float l1 = mid + rad;",
    "  float l2 = max(mid - rad, 1e-9);",
    "  vec2 e1 = (abs(b) > 1e-9) ? normalize(vec2(b, l1 - a)) : vec2(1.0, 0.0);",
    "  vec2 e2 = vec2(-e1.y, e1.x);",

    // Trois écarts-types couvrent 99,7 % de la masse : au-delà, l'alpha est
    // sous le seuil d'affichage et le quad ne sert plus qu'à consommer des
    // fragments.
    // Rayon borné : sans plafond, un seul splat rasant projette une ellipse
    // qui remplit la vue et noie tout le reste.
    "  float r1 = min(sqrt(l1) * 3.0, 0.085);",
    "  float r2 = min(sqrt(l2) * 3.0, 0.085);",
    "  vec2 offset = corner.x * e1 * r1 + corner.y * e2 * r2;",

    "  vec4 clip = vec4(focal.x * cam.x, focal.y * cam.y, cam.z * 1.002 + 0.2002, t);",
    "  gl_Position = vec4(clip.xy + offset * clip.w, -clip.z, clip.w);",
    "  uv = corner * 3.0;",
    "  col = rgba;",
    "}"
  ].join("\n");

  var SPLAT_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 uv;",
    "in vec4 col;",
    "out vec4 frag;",
    "void main() {",
    "  float d = dot(uv, uv);",
    "  if (d > 9.0) discard;",
    "  float alpha = col.a * exp(-0.5 * d);",
    "  if (alpha < 0.0035) discard;",
    "  frag = vec4(col.rgb * alpha, alpha);",
    "}"
  ].join("\n");

  function compile(gl, type, source) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  /* ─── La pièce de démonstration ─────────────────────────────────────────

     Engendrée plutôt que téléchargée : le prototype n'a pas de serveur, et un
     vrai scan pèse plusieurs mégaoctets. Deux choses la rapprochent d'une
     capture réelle :

     · les splats sont PLAQUÉS sur les surfaces (crêpes dans le plan du mur),
       pas dispersés en volume ;
     · l'éclairage est CUIT dans les couleurs — lumière de la fenêtre,
       assombrissement dans les angles, ombres portées sous les objets. Un
       scan ne calcule pas la lumière au rendu : il la photographie. */

  function buildDemoRoom() {
    var pos = [], axA = [], axB = [], axN = [], col = [];

    var rnd = (function (seed) {
      return function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    })(20260920);

    // La fenêtre : c'est elle qui éclaire toute la pièce.
    var LX = -0.3, LY = 1.5, LZ = -2.5;

    var ROOM = { x0: -3, x1: 3, y0: 0, y1: 2.5, z0: -2.6, z1: 2.6 };

    /* Occlusion ambiante approchée : plus on est près d'un angle, moins on
       reçoit de ciel. Deux lignes, mais c'est ce qui donne le relief. */
    function ao(x, y, z) {
      var dx = Math.min(x - ROOM.x0, ROOM.x1 - x);
      var dy = Math.min(y - ROOM.y0, ROOM.y1 - y);
      var dz = Math.min(z - ROOM.z0, ROOM.z1 - z);
      var d = Math.min(dx, Math.min(dy, dz));
      return 0.70 + 0.30 * Math.min(1, d / 0.8);
    }

    function shade(x, y, z, nx, ny, nz, base) {
      // Diffus depuis la fenêtre.
      var lx = LX - x, ly = LY - y, lz = LZ - z;
      var len = Math.hypot(lx, ly, lz) || 1;
      var ndl = Math.max(0, (lx * nx + ly * ny + lz * nz) / len);
      var falloff = 1 / (1 + len * len * 0.045);
      // Une pièce vécue n'est jamais éclairée par une seule source : il y a la
      // fenêtre, et tout ce que les murs clairs lui renvoient.
      var light = 0.86 + 1.25 * ndl * falloff;
      if (ny < -0.5) light += 0.10;          // rebond du sol vers le plafond
      if (ny > 0.5) light += 0.06;           // ciel vers le sol
      return base * light * ao(x, y, z);
    }

    /* Une surface plane : `n` donne la normale, `u` et `v` les deux
       directions du plan. Chaque splat est une crêpe dans ce plan, avec une
       rotation aléatoire autour de la normale — c'est ce que produit un vrai
       solveur, et c'est ce qui casse l'aspect « grille ». */
    function surface(opts) {
      var n = opts.n, u = opts.u, v = opts.v;
      var count = opts.count, size = opts.size || 0.055, thin = opts.thin || 0.004;

      for (var i = 0; i < count; i++) {
        var su = rnd(), sv = rnd();
        var x = opts.o[0] + u[0] * su * opts.su + v[0] * sv * opts.sv;
        var y = opts.o[1] + u[1] * su * opts.su + v[1] * sv * opts.sv;
        var z = opts.o[2] + u[2] * su * opts.su + v[2] * sv * opts.sv;

        // Bruit de surface : un mur réel n'est pas parfaitement plan pour un
        // scanner, et cette irrégularité est une bonne part du réalisme.
        var bump = (rnd() - 0.5) * (opts.rough || 0.006);
        x += n[0] * bump; y += n[1] * bump; z += n[2] * bump;

        var ang = rnd() * Math.PI * 2;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        var s1 = size * (0.72 + rnd() * 0.7);
        var s2 = size * (0.72 + rnd() * 0.7) * (opts.stretch || 1);

        axA.push((u[0] * ca + v[0] * sa) * s1, (u[1] * ca + v[1] * sa) * s1, (u[2] * ca + v[2] * sa) * s1);
        axB.push((-u[0] * sa + v[0] * ca) * s2, (-u[1] * sa + v[1] * ca) * s2, (-u[2] * sa + v[2] * ca) * s2);
        axN.push(n[0] * thin, n[1] * thin, n[2] * thin);

        pos.push(x, y, z);

        var tint = 1 + (rnd() - 0.5) * (opts.grain || 0.14);
        var lit = opts.flat
          ? function (v) { return v; }
          : function (v) { return shade(x, y, z, n[0], n[1], n[2], v); };
        // Rayure régulière : lames de parquet, planches d'étagère. Un scan
        // capte ces lignes, et c'est à elles qu'on reconnaît une matière.
        if (opts.stripe) {
          var coord = opts.stripe.axis === 2 ? z : (opts.stripe.axis === 0 ? x : y);
          var phase = Math.abs(((coord / opts.stripe.period) % 1 + 1) % 1 - 0.5) * 2;
          tint *= 1 - opts.stripe.depth * (1 - phase) * 0.6;
        }
        var c = opts.color;
        col.push(
          Math.min(1, lit(c[0] * tint)),
          Math.min(1, lit(c[1] * tint)),
          Math.min(1, lit(c[2] * tint)),
          opts.alpha == null ? 0.93 : opts.alpha
        );
      }
    }

    /* Une boîte : six faces, chacune une surface. C'est ainsi qu'un scan voit
       un carton — pas comme un volume plein. */
    function box(cx, cy, cz, w, h, d, color, density, grain) {
      var hw = w / 2, hd = d / 2;
      var n = density || 2600;
      var g = grain == null ? 0.1 : grain;
      var size = 0.032;
      // dessus
      surface({ o: [cx - hw, cy + h, cz - hd], u: [1,0,0], v: [0,0,1], su: w, sv: d,
                n: [0,1,0], count: Math.round(n * 0.26), color: color, size: size, grain: g, rough: 0.004 });
      // face avant (vers +z)
      surface({ o: [cx - hw, cy, cz + hd], u: [1,0,0], v: [0,1,0], su: w, sv: h,
                n: [0,0,1], count: Math.round(n * 0.26), color: color, size: size, grain: g, rough: 0.004 });
      // face arrière
      surface({ o: [cx - hw, cy, cz - hd], u: [1,0,0], v: [0,1,0], su: w, sv: h,
                n: [0,0,-1], count: Math.round(n * 0.14), color: color, size: size, grain: g, rough: 0.004 });
      // côtés
      surface({ o: [cx - hw, cy, cz - hd], u: [0,0,1], v: [0,1,0], su: d, sv: h,
                n: [-1,0,0], count: Math.round(n * 0.17), color: color, size: size, grain: g, rough: 0.004 });
      surface({ o: [cx + hw, cy, cz - hd], u: [0,0,1], v: [0,1,0], su: d, sv: h,
                n: [1,0,0], count: Math.round(n * 0.17), color: color, size: size, grain: g, rough: 0.004 });
    }

    // ─── Enveloppe ────────────────────────────────────────────────────────
    surface({ o: [-3, 0, -2.6], u: [1,0,0], v: [0,0,1], su: 6, sv: 5.2, n: [0,1,0],
              count: 24000, color: [0.46, 0.35, 0.25], size: 0.05, grain: 0.26, rough: 0.005,
              stripe: { axis: 2, period: 0.16, depth: 0.3 } });                                          // parquet
    surface({ o: [-3, 2.5, -2.6], u: [1,0,0], v: [0,0,1], su: 6, sv: 5.2, n: [0,-1,0],
              count: 10000, color: [0.88, 0.88, 0.87], size: 0.07, grain: 0.05, rough: 0.004 });        // plafond
    surface({ o: [-3, 0, -2.6], u: [1,0,0], v: [0,1,0], su: 6, sv: 2.5, n: [0,0,1],
              count: 16000, color: [0.80, 0.79, 0.76], size: 0.055, grain: 0.07, rough: 0.006 });       // mur du fond
    surface({ o: [-3, 0, -2.6], u: [0,0,1], v: [0,1,0], su: 5.2, sv: 2.5, n: [1,0,0],
              count: 13000, color: [0.79, 0.78, 0.75], size: 0.055, grain: 0.07, rough: 0.006 });       // mur gauche
    surface({ o: [3, 0, -2.6], u: [0,0,1], v: [0,1,0], su: 5.2, sv: 2.5, n: [-1,0,0],
              count: 13000, color: [0.77, 0.76, 0.73], size: 0.055, grain: 0.07, rough: 0.006 });       // mur droit
    // plinthe
    surface({ o: [-3, 0, -2.58], u: [1,0,0], v: [0,1,0], su: 6, sv: 0.11, n: [0,0,1],
              count: 2600, color: [0.93, 0.93, 0.92], size: 0.026, grain: 0.05 });

    // ─── Fenêtre ──────────────────────────────────────────────────────────
    // Le vitrage : franc, un peu débordant, c'est la source de toute la scène.
    surface({ o: [-1.15, 0.95, -2.56], u: [1,0,0], v: [0,1,0], su: 1.7, sv: 1.15, n: [0,0,1],
              count: 9000, color: [1.9, 1.86, 1.72], size: 0.042, grain: 0.02, alpha: 1.0, flat: true });
    // Le cadre et les petits bois : sans eux, ce n'est qu'une tache claire.
    [[-1.19, 0.91, 1.78, 0.055], [-1.19, 2.06, 1.78, 0.055]].forEach(function (b) {
      surface({ o: [b[0], b[1], -2.545], u: [1,0,0], v: [0,1,0], su: b[2], sv: b[3], n: [0,0,1],
                count: 700, color: [0.97, 0.96, 0.94], size: 0.024, grain: 0.04, flat: true });
    });
    [[-1.19, 0.91, 0.05, 1.2], [0.55, 0.91, 0.05, 1.2], [-0.33, 0.91, 0.035, 1.2]].forEach(function (b) {
      surface({ o: [b[0], b[1], -2.545], u: [1,0,0], v: [0,1,0], su: b[2], sv: b[3], n: [0,0,1],
                count: 620, color: [0.95, 0.94, 0.92], size: 0.024, grain: 0.04, flat: true });
    });

    // ─── Étagère du fond ──────────────────────────────────────────────────
    var WOOD = [0.44, 0.31, 0.21];
    for (var lvl = 0; lvl < 4; lvl++) {
      var y = 0.36 + lvl * 0.5;
      surface({ o: [0.98, y, -2.5], u: [1,0,0], v: [0,0,1], su: 1.84, sv: 0.55, n: [0,1,0],
                count: 2600, color: WOOD, size: 0.03, grain: 0.22, rough: 0.003,
                stripe: { axis: 0, period: 0.22, depth: 0.22 } });
      surface({ o: [0.98, y - 0.045, -1.95], u: [1,0,0], v: [0,1,0], su: 1.84, sv: 0.045, n: [0,0,1],
                count: 900, color: [0.36, 0.25, 0.17], size: 0.022, grain: 0.15 });
    }
    surface({ o: [0.96, 0, -2.5], u: [0,0,1], v: [0,1,0], su: 0.55, sv: 2.2, n: [-1,0,0],
              count: 2000, color: WOOD, size: 0.03, grain: 0.2 });
    surface({ o: [2.82, 0, -2.5], u: [0,0,1], v: [0,1,0], su: 0.55, sv: 2.2, n: [1,0,0],
              count: 2000, color: WOOD, size: 0.03, grain: 0.2 });

    // ─── Ce qui est posé dessus ───────────────────────────────────────────
    box(1.26, 0.41, -2.24, 0.42, 0.31, 0.38, [0.79, 0.57, 0.36], 3000, 0.09);   // carton kraft
    box(1.82, 0.41, -2.24, 0.35, 0.29, 0.34, [0.70, 0.66, 0.47], 2600, 0.09);   // bac olive
    box(2.33, 0.91, -2.24, 0.44, 0.35, 0.36, [0.28, 0.44, 0.66], 3000, 0.08);   // bac bleu
    box(1.31, 0.91, -2.24, 0.38, 0.31, 0.34, [0.84, 0.79, 0.40], 2700, 0.08);   // bac jaune
    box(1.86, 1.41, -2.24, 0.45, 0.37, 0.36, [0.72, 0.46, 0.31], 3100, 0.09);   // carton terracotta
    box(2.36, 1.91, -2.24, 0.39, 0.31, 0.34, [0.34, 0.56, 0.45], 2700, 0.08);   // bac vert

    // ─── Meuble bas à gauche ──────────────────────────────────────────────
    box(-2.25, 0, -2.2, 1.3, 0.88, 0.58, [0.24, 0.24, 0.27], 6500, 0.07);
    surface({ o: [-2.94, 0.9, -2.52], u: [1,0,0], v: [0,0,1], su: 1.38, sv: 0.64, n: [0,1,0],
              count: 2000, color: [0.70, 0.66, 0.58], size: 0.03, grain: 0.1 });

    // ─── Tapis ────────────────────────────────────────────────────────────
    surface({ o: [-1.5, 0.012, -1.3], u: [1,0,0], v: [0,0,1], su: 3.0, sv: 2.0, n: [0,1,0],
              count: 6000, color: [0.62, 0.58, 0.54], size: 0.06, grain: 0.16, rough: 0.008 });

    return {
      pos: new Float32Array(pos),
      axA: new Float32Array(axA),
      axB: new Float32Array(axB),
      axN: new Float32Array(axN),
      col: new Float32Array(col),
      count: pos.length / 3
    };
  }

  function splatScene(canvas, pinLayer, options) {
    var opts = options || {};
    var gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: true });
    if (!gl) return null;

    var cloud = buildDemoRoom();
    var n = cloud.count;

    var program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, SPLAT_VS));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, SPLAT_FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var locCorner = gl.getAttribLocation(program, "corner");
    gl.enableVertexAttribArray(locCorner);
    gl.vertexAttribPointer(locCorner, 2, gl.FLOAT, false, 0, 0);

    // Les attributs par splat, réécrits à chaque tri.
    var centers = new Float32Array(n * 3);
    var bufA = new Float32Array(n * 3);
    var bufB = new Float32Array(n * 3);
    var bufN = new Float32Array(n * 3);
    var colors = new Float32Array(n * 4);

    function instanced(name, size, array) {
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, array, gl.DYNAMIC_DRAW);
      var loc = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
      return buf;
    }
    var glCenter = instanced("center", 3, centers);
    var glA = instanced("axA", 3, bufA);
    var glB = instanced("axB", 3, bufB);
    var glN = instanced("axN", 3, bufN);
    var glCol = instanced("rgba", 4, colors);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    var uView = gl.getUniformLocation(program, "view");
    var uFocal = gl.getUniformLocation(program, "focal");
    var uInvRes = gl.getUniformLocation(program, "invRes");

    var cam = opts.cam || { yaw: 0.06, pitch: 0.03, dist: 3.9, tx: 1.35, ty: 1.2, tz: -1.7 };
    var start = { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, tx: cam.tx, ty: cam.ty, tz: cam.tz || 0 };
    var fovTan = opts.fovTan || 0.56;

    var view = new Float32Array(16);
    var depth = new Float32Array(n);
    var sorted = new Uint32Array(n);
    var needSort = true, running = true, raf = 0;

    function buildView() {
      var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      var tz = cam.tz || 0;
      var ex = cam.tx + cam.dist * cp * sy;
      var ey = cam.ty + cam.dist * sp;
      var ez = tz + cam.dist * cp * cy;
      // Une pièce scannée est une coquille creuse : en orbitant autour d'une
      // cible intérieure, la caméra traverse les murs. On la garde dedans.
      ex = Math.max(-2.3, Math.min(2.3, ex));
      ey = Math.max(0.55, Math.min(2.1, ey));
      ez = Math.max(-1.6, Math.min(2.25, ez));

      var fx = cam.tx - ex, fy = cam.ty - ey, fz = tz - ez;
      var fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      // droite = normalize(cross(avant, haut)). Le signe comptait : inversé,
      // toute la scène s'affichait en miroir — l'étagère de droite passait à
      // gauche, et la fenêtre avec.
      var rx = -fz, ry = 0, rz = fx;
      var rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
      var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
      view.set([
        rx, ux, -fx, 0,
        ry, uy, -fy, 0,
        rz, uz, -fz, 0,
        -(rx * ex + ry * ey + rz * ez), -(ux * ex + uy * ey + uz * ez), (fx * ex + fy * ey + fz * ez), 1
      ]);
      return { ex: ex, ey: ey, ez: ez };
    }

    /* Tri par profondeur. C'est LA contrainte d'un rendu par splats : sans
       ordre, l'accumulation alpha donne une bouillie. Tri par compartiments
       plutôt qu'avec un comparateur — trier 150 000 éléments avec un appel de
       fonction par comparaison coûte dix fois plus cher qu'un balayage de
       compteurs. */
    var BUCKETS = 4096;
    var counts = new Uint32Array(BUCKETS + 1);

    function sortByDepth(eye) {
      var min = Infinity, max = -Infinity, i, d;
      for (i = 0; i < n; i++) {
        var dx = cloud.pos[i * 3] - eye.ex, dy = cloud.pos[i * 3 + 1] - eye.ey, dz = cloud.pos[i * 3 + 2] - eye.ez;
        d = dx * dx + dy * dy + dz * dz;
        depth[i] = d;
        if (d < min) min = d;
        if (d > max) max = d;
      }
      counts.fill(0);
      var scale = (BUCKETS - 1) / ((max - min) || 1);
      for (i = 0; i < n; i++) counts[BUCKETS - 1 - ((depth[i] - min) * scale | 0)]++;
      var run = 0;
      for (i = 0; i < BUCKETS; i++) { var c = counts[i]; counts[i] = run; run += c; }
      for (i = 0; i < n; i++) sorted[counts[BUCKETS - 1 - ((depth[i] - min) * scale | 0)]++] = i;

      for (var k = 0; k < n; k++) {
        var j = sorted[k];
        centers[k * 3] = cloud.pos[j * 3];
        centers[k * 3 + 1] = cloud.pos[j * 3 + 1];
        centers[k * 3 + 2] = cloud.pos[j * 3 + 2];
        bufA[k * 3] = cloud.axA[j * 3]; bufA[k * 3 + 1] = cloud.axA[j * 3 + 1]; bufA[k * 3 + 2] = cloud.axA[j * 3 + 2];
        bufB[k * 3] = cloud.axB[j * 3]; bufB[k * 3 + 1] = cloud.axB[j * 3 + 1]; bufB[k * 3 + 2] = cloud.axB[j * 3 + 2];
        bufN[k * 3] = cloud.axN[j * 3]; bufN[k * 3 + 1] = cloud.axN[j * 3 + 1]; bufN[k * 3 + 2] = cloud.axN[j * 3 + 2];
        colors[k * 4] = cloud.col[j * 4];
        colors[k * 4 + 1] = cloud.col[j * 4 + 1];
        colors[k * 4 + 2] = cloud.col[j * 4 + 2];
        colors[k * 4 + 3] = cloud.col[j * 4 + 3];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, glCenter); gl.bufferSubData(gl.ARRAY_BUFFER, 0, centers);
      gl.bindBuffer(gl.ARRAY_BUFFER, glA); gl.bufferSubData(gl.ARRAY_BUFFER, 0, bufA);
      gl.bindBuffer(gl.ARRAY_BUFFER, glB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, bufB);
      gl.bindBuffer(gl.ARRAY_BUFFER, glN); gl.bufferSubData(gl.ARRAY_BUFFER, 0, bufN);
      gl.bindBuffer(gl.ARRAY_BUFFER, glCol); gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
    }

    var focalX = 1, focalY = 1;

    /* Les points épinglés. La liste appartient à l'appelant : elle change
       quand l'utilisateur place un meuble, sans reconstruire la scène — un
       nuage de 150 000 splats ne se régénère pas à chaque clic. */
    var pinPoints = opts.pins || [];

    function placePins(w, h) {
      if (!pinLayer) return;
      var nodes = pinLayer.children;
      for (var i = 0; i < pinPoints.length && i < nodes.length; i++) {
        var p = pinPoints[i];
        var cx = view[0] * p.x + view[4] * p.y + view[8] * p.z + view[12];
        var cy = view[1] * p.x + view[5] * p.y + view[9] * p.z + view[13];
        var cz = view[2] * p.x + view[6] * p.y + view[10] * p.z + view[14];
        var t = -cz;
        if (t <= 0.15) { hidePin(nodes[i]); continue; }
        var sx = (focalX * cx / t * 0.5 + 0.5) * w;
        var sy = (0.5 - focalY * cy / t * 0.5) * h;
        nodes[i].style.transform = "translate(-50%,-50%) translate(" + sx.toFixed(1) + "px," + sy.toFixed(1) + "px)";
        nodes[i].style.opacity = "1";
        nodes[i].style.pointerEvents = "auto";
        showPin(nodes[i]);
      }
    }

    /* Amener la caméra sur un point. C'est ce qui transforme un résultat de
       recherche en réponse : la pièce tourne vers le rangement au lieu
       d'afficher un chemin. */
    var glide = null;

    function focusOn(point) {
      glide = {
        t0: (window.performance || Date).now(), dur: 700,
        sx: cam.tx, sy: cam.ty, sz: cam.tz || 0, sd: cam.dist,
        fx: point.x, fy: point.y, fz: point.z, fd: 2.3
      };
    }

    var idle = 0;

    function frame() {
      if (!running) return;
      /* Le canevas peut être détaché une image, le temps d'un rendu qui le
         déplace — ou pour de bon, si l'utilisateur a changé d'onglet. On
         distingue les deux par la durée : sans cette sortie, la boucle
         continuait à ombrer 140 000 splats sur un canevas de taille nulle,
         invisible et assez coûteux pour ralentir tout le reste. */
      if (!canvas.isConnected) {
        idle += 1;
        if (idle > 120) { running = false; return; }
        raf = requestAnimationFrame(frame);
        return;
      }
      idle = 0;
      if (glide) {
        var k = Math.min(1, ((window.performance || Date).now() - glide.t0) / glide.dur);
        var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        cam.tx = glide.sx + (glide.fx - glide.sx) * e;
        cam.ty = glide.sy + (glide.fy - glide.sy) * e;
        cam.tz = glide.sz + (glide.fz - glide.sz) * e;
        cam.dist = glide.sd + (glide.fd - glide.sd) * e;
        needSort = true;
        if (k >= 1) glide = null;
      }
      var dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== (w * dpr | 0) || canvas.height !== (h * dpr | 0)) {
        canvas.width = w * dpr | 0; canvas.height = h * dpr | 0;
        needSort = true;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.045, 0.045, 0.055, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      var eye = buildView();
      var aspect = canvas.width / canvas.height || 1;
      var f = 1 / Math.tan(fovTan);
      focalX = f / aspect; focalY = f;

      if (needSort) { sortByDepth(eye); needSort = false; }

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(uView, false, view);
      gl.uniform2f(uFocal, focalX, focalY);
      gl.uniform2f(uInvRes, 1 / canvas.width, 1 / canvas.height);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);

      placePins(w, h);
      raf = requestAnimationFrame(frame);
    }

    // ─── Orbite ───────────────────────────────────────────────────────────
    var drag = null;
    canvas.addEventListener("pointerdown", function (e) {
      glide = null;   // la main reprend toujours la main sur l'animation
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: 0 };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) return;
      cam.yaw -= (e.clientX - drag.x) * 0.005;
      cam.pitch = Math.max(-0.22, Math.min(0.34, cam.pitch + (e.clientY - drag.y) * 0.0035));
      drag.x = e.clientX; drag.y = e.clientY;
      drag.moved = Math.max(drag.moved, Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0));
      needSort = true;
    });
    canvas.addEventListener("pointerup", function (e) {
      // Un clic est une orbite de moins de six pixels : au-delà, l'utilisateur
      // tournait la pièce et n'a pas demandé à poser quoi que ce soit.
      if (drag && drag.moved < 6 && picking && opts.onPick) {
        var hit = pick(e.clientX, e.clientY);
        if (hit) opts.onPick(hit);
      }
      drag = null;
    });
    canvas.addEventListener("pointercancel", function () { drag = null; });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      cam.dist = Math.max(1.5, Math.min(4.9, cam.dist + e.deltaY * 0.0035));
      needSort = true;
    }, { passive: false });

    /* Désigner un point de la pièce.

       Un nuage de splats n'a pas de surface à intersecter : il n'y a ni
       triangle ni maillage à traverser. On fait donc l'inverse du lancer de
       rayon habituel — on projette chaque splat à l'écran et on garde le plus
       proche de la caméra parmi ceux qui tombent sous le curseur. Une seule
       passe sur le nuage, au clic seulement : quelques millisecondes, et le
       point rendu est une position réelle du scan, pas une approximation. */
    var picking = false;

    function pick(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      var ndcX = (clientX - rect.left) / rect.width * 2 - 1;
      var ndcY = 1 - (clientY - rect.top) / rect.height * 2;
      // Une tolérance de douze pixels : moins, et l'on rate la cible au doigt.
      var tolX = 24 / rect.width, tolY = 24 / rect.height;

      var best = -1, bestT = Infinity;
      for (var i = 0; i < n; i++) {
        var x = cloud.pos[i * 3], y = cloud.pos[i * 3 + 1], z = cloud.pos[i * 3 + 2];
        var cz = view[2] * x + view[6] * y + view[10] * z + view[14];
        var t = -cz;
        if (t <= 0.25 || t >= bestT) continue;
        var cx = view[0] * x + view[4] * y + view[8] * z + view[12];
        if (Math.abs(focalX * cx / t - ndcX) > tolX) continue;
        var cy = view[1] * x + view[5] * y + view[9] * z + view[13];
        if (Math.abs(focalY * cy / t - ndcY) > tolY) continue;
        bestT = t; best = i;
      }
      if (best < 0) return null;
      return { x: cloud.pos[best * 3], y: cloud.pos[best * 3 + 1], z: cloud.pos[best * 3 + 2] };
    }

    frame();

    return {
      count: n,
      reset: function () {
        cam.yaw = start.yaw; cam.pitch = start.pitch; cam.dist = start.dist;
        cam.tx = start.tx; cam.ty = start.ty; cam.tz = start.tz; needSort = true;
      },
      orbit: function (dy) { cam.yaw += dy; needSort = true; },
      focusOn: focusOn,
      setPins: function (points) { pinPoints = points || []; },
      setPicking: function (on) { picking = !!on; canvas.style.cursor = on ? "crosshair" : ""; },
      pick: pick,
      dispose: function () { running = false; cancelAnimationFrame(raf); }
    };
  }

  /* ─── Vue : plan ──────────────────────────────────────────────────── */

  var mapFocus = null;
  var mapHover = null;

  var mapMode = "2d";
  var spaceScene = null;

  /* ═══ Espace 3D ════════════════════════════════════════════════════════

     Une pièce, un scan, un nuage de points. On navigue d'une pièce à l'autre
     par le rail du haut, on pose les rangements d'un clic dans la scène, et
     la recherche sait ensuite désigner le point au lieu de l'épeler.

     Trois façons d'obtenir le nuage, dans l'ordre de préférence :

     1. LA CAMÉRA, sur un téléphone Android : WebXR + ARCore rendent une carte
        de profondeur par image. On filme, la pièce se construit.
     2. UN FICHIER .ply, depuis Scaniverse (gratuit, illimité, calculé sur
        l'appareil). C'est la seule voie sur iPhone, et c'est la plus précise
        partout — un solveur qui prend son temps bat une capture en direct.
     3. LE SCAN DE DÉMONSTRATION, engendré dans le navigateur, pour qui veut
        voir le parcours sans rien scanner. */

  /* La pièce affichée. */
  var spaceRoomId = null;
  /* Palette de hauteur plutôt que couleurs relevées. */
  var spaceTint = false;
  /* Un relevé en attente de validation : capture fraîche ou fichier importé. */
  var review = null;
  /* Ce que l'appareil sait faire, résolu une fois au démarrage. */
  var arReady = null;
  var panoReady = null;

  /* Le rangement en attente d'un point, le temps d'un clic dans la scène. */
  var placingId = null;
  /* Le lieu que la vue 3D doit désigner à l'ouverture. */
  var spaceFocus = null;

  /* Le lieu situé le plus proche : un objet rangé dans « Bac 3 » hérite du
     point de l'étagère si le bac lui-même n'a pas été posé. */
  function situatedAncestor(locationId) {
    var node = locById(locationId), guard = 0;
    while (node && guard < 12) {
      if (node.space) return node;
      node = node.parentId ? locById(node.parentId) : null;
      guard += 1;
    }
    return null;
  }

  function itemsIn(locationId) {
    var ids = descendantIds(locationId);
    return state.items.filter(function (item) { return ids.indexOf(item.locationId) !== -1; });
  }

  function spaceRooms() {
    return state.locations.filter(function (l) { return !l.parentId; });
  }

  function currentSpaceRoom() {
    var room = spaceRoomId ? locById(spaceRoomId) : null;
    if (room) return room;
    var scanned = (state.scans || [])
      .map(function (scan) { return locById(scan.locationId); })
      .filter(function (l) { return !!l; });
    return scanned[0] || spaceRooms()[0] || null;
  }

  function dropScene() {
    if (spaceScene) { spaceScene.dispose(); spaceScene = null; }
  }

  function goRoom(id) {
    dropScene();
    spaceRoomId = id;
    spaceFocus = null;
    placingId = null;
    review = null;
    render();
  }

  function viewSpace() {
    var room = currentSpaceRoom();
    spaceRoomId = room ? room.id : null;
    var scan = room ? scanOf(room.id) : null;
    var reviewing = review && room && review.locationId === room.id;

    var inRoom = room ? descendantIds(room.id) : [];
    var storages = state.locations.filter(function (l) {
      return room && l.id !== room.id && inRoom.indexOf(l.id) !== -1;
    });

    var pins = el("div", { class: "splat-pins" });
    var canvas = el("canvas", { "aria-label": room ? "Relevé 3D : " + room.name : "Espace 3D" });
    var hud = el("div", { class: "splat-hud", text: "Préparation…" });
    var frame = el("div", { class: "splat-frame" }, [canvas, pins, hud]);
    var bar = el("div", { class: "place-bar", hidden: true });
    var list = el("ul", { class: "row-list", style: "margin-top:14px" });

    function placed() {
      return storages.filter(function (l) { return l.space; });
    }

    /* Les pastilles et la scène partagent le même ordre : la scène positionne
       les enfants de la couche par index. */
    function paintPins() {
      if (reviewing) { pins.replaceChildren(); return; }
      var visible = placed();
      pins.replaceChildren.apply(pins, visible.map(function (loc) {
        return el("button", {
          class: "splat-pin" + (spaceFocus === loc.id ? " on" : ""), type: "button", style: "opacity:0",
          onclick: function () { storageSheet(loc); }
        }, [
          el("span", { class: "dot" }),
          loc.name,
          el("span", { class: "n", text: String(itemsIn(loc.id).length) })
        ]);
      }));
      if (spaceScene && spaceScene.setPins) spaceScene.setPins(visible.map(function (l) { return l.space; }));
    }

    function paintList() {
      list.replaceChildren.apply(list, storages.map(function (loc) {
        var count = itemsIn(loc.id).length;
        return el("li", { class: "row" }, [
          el("span", { class: "dot-state" + (loc.space ? " on" : "") }),
          el("span", { style: "flex:1;min-width:0" }, [
            el("span", { style: "display:block;font-size:.9375rem", text: loc.name }),
            el("span", { class: "muted", style: "display:block;font-size:.75rem", text: (loc.space ? "Situé dans le scan" : "Pas encore situé") + " · " + plural(count, "objet", "objets") })
          ]),
          el("button", {
            class: "btn btn-sm btn-line", type: "button",
            onclick: function () { arm(loc.id); }
          }, [icon("pin", 14), loc.space ? "Déplacer" : "Situer"])
        ]);
      }));
    }

    function paintBar() {
      if (!placingId || reviewing) {
        bar.hidden = true;
        bar.replaceChildren();
        if (spaceScene && spaceScene.setPicking) spaceScene.setPicking(false);
        frame.classList.remove("picking");
        return;
      }
      var loc = locById(placingId);
      if (!loc) { placingId = null; return paintBar(); }
      bar.hidden = false;
      bar.replaceChildren(
        icon("pin", 16),
        el("span", { text: "Touchez « " + loc.name + " » dans la scène pour l'y poser." }),
        el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: function () { placingId = null; paintBar(); } }, "Annuler")
      );
      if (spaceScene && spaceScene.setPicking) spaceScene.setPicking(true);
      frame.classList.add("picking");
    }

    function arm(id) {
      placingId = id;
      paintBar();
      frame.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    function refresh() { paintPins(); paintList(); paintBar(); }

    function storageSheet(loc) {
      var items = itemsIn(loc.id);
      sheet({
        title: loc.name,
        body: [
          el("p", { class: "muted", style: "font-size:.8125rem", text: pathOf(loc.id).join(" / ") }),
          items.length === 0
            ? el("p", { class: "muted", style: "margin-top:16px;font-size:.875rem", text: "Rien de référencé ici pour l'instant." })
            : el("ul", { class: "row-list", style: "margin-top:16px" }, items.map(function (item) {
                return el("li", { class: "row" }, [
                  el("span", { style: "flex:1;min-width:0", text: item.name }),
                  el("button", {
                    class: "btn btn-sm btn-quiet", type: "button",
                    onclick: function () { closeSheet(); itemSheet(item); }
                  }, "Ouvrir")
                ]);
              }))
        ],
        foot: [
          el("button", {
            class: "btn btn-quiet", type: "button",
            onclick: function () { loc.space = null; save(); closeSheet(); refresh(); toast("Point retiré de la 3D."); }
          }, "Retirer de la 3D"),
          el("button", {
            class: "btn btn-line", type: "button",
            onclick: function () { closeSheet(); arm(loc.id); }
          }, [icon("pin", 15), "Déplacer le point"])
        ]
      });
    }

    function onPick(point) {
      var loc = placingId ? locById(placingId) : null;
      if (!loc) return;
      loc.space = { x: point.x, y: point.y, z: point.z };
      placingId = null;
      save();
      refresh();
      toast("« " + loc.name + " » est posé dans la pièce.");
    }

    function fail(message) {
      frame.replaceChildren(el("div", { class: "splat-nosupport", text: message ||
        "Votre navigateur ne gère pas WebGL2, nécessaire au rendu 3D. Le plan 2D reste disponible." }));
    }

    // ─── Montage de la scène ────────────────────────────────────────────
    setTimeout(function () {
      if (!canvas.isConnected) return;

      if (reviewing) {
        if (review.kind === "pano") {
          if (!window.FulmoPanoView) return fail("La visionneuse panoramique n'a pas pu être chargée.");
          try {
            spaceScene = window.FulmoPanoView(canvas, pins, review.pano.canvas, {});
          } catch (e) { return fail(); }
          if (!spaceScene) return fail();
          hud.textContent = "Panoramique · glissez pour regarder";
          return;
        }
        try {
          spaceScene = cloudScene(canvas, pins, review.cloud, { tint: spaceTint ? 1 : 0 });
        } catch (e) { return fail(); }
        if (!spaceScene) return fail();
        hud.textContent = spaceScene.count.toLocaleString("fr-FR") + " points relevés";
        return;
      }

      if (!scan) { hud.textContent = ""; return; }

      if (scan.source === "demo") {
        try {
          spaceScene = splatScene(canvas, pins, {
            pins: placed().map(function (l) { return l.space; }),
            onPick: onPick
          });
        } catch (e) { return fail(); }
        if (!spaceScene) return fail();
        hud.textContent = spaceScene.count.toLocaleString("fr-FR") + " splats · glissez pour tourner";
        refresh();
        var aimDemo = spaceFocus ? locById(spaceFocus) : null;
        if (aimDemo && aimDemo.space) spaceScene.focusOn(aimDemo.space);
        return;
      }

      if (scanKind(scan) === "pano") {
        hud.textContent = "Chargement de la panoramique…";
        scanStore.get(scan.id).then(function (record) {
          if (!record || !record.pano) throw new Error("absent");
          return createImageBitmap(record.pano);
        }).then(function (bitmap) {
          if (!canvas.isConnected) return;
          if (!window.FulmoPanoView) return fail("La visionneuse panoramique n'a pas pu être chargée.");
          spaceScene = window.FulmoPanoView(canvas, pins, bitmap, {
            pins: placed().map(function (l) { return l.space; }),
            onPick: onPick
          });
          if (!spaceScene) return fail();
          hud.textContent = "Panoramique · glissez pour regarder · pincez pour zoomer";
          refresh();
          var aimed = spaceFocus ? locById(spaceFocus) : null;
          if (aimed && aimed.space) spaceScene.focusOn(aimed.space);
        }).catch(function () {
          if (canvas.isConnected) fail("Cette panoramique n'est plus sur cet appareil. Refaites le tour de la pièce.");
        });
        return;
      }

      hud.textContent = "Chargement du relevé…";
      scanStore.get(scan.id).then(function (record) {
        if (!canvas.isConnected) return;
        if (!record || !record.pos) return fail("Ce relevé n'est plus sur cet appareil. Re-scannez la pièce ou réimportez le fichier.");
        var cloud = makeCloud(record.pos, record.col);
        try {
          spaceScene = cloudScene(canvas, pins, cloud, {
            tint: spaceTint ? 1 : 0,
            pins: placed().map(function (l) { return l.space; }),
            onPick: onPick
          });
        } catch (e) { return fail(); }
        if (!spaceScene) return fail();
        hud.textContent = spaceScene.count.toLocaleString("fr-FR") + " points · glissez pour tourner · pincez pour zoomer";
        refresh();
        var aim = spaceFocus ? locById(spaceFocus) : null;
        if (aim && aim.space) spaceScene.focusOn(aim.space);
      });
    }, 0);

    refresh();

    // ─── Acquisition ────────────────────────────────────────────────────

    function explainNoAr(status) {
      sheet({
        title: "La caméra 3D n'est pas disponible ici",
        body: [
          el("p", { class: "lede", text:
            status === "insecure"
              ? "La capture 3D exige une connexion sécurisée. Ouvrez la page en HTTPS."
              : "Le relevé en direct demande WebXR et un capteur de profondeur : aujourd'hui, c'est Chrome sur Android avec ARCore. Safari n'expose pas la réalité augmentée au web, et le LiDAR de l'iPhone n'est lisible que par une application installée." }),
          el("div", { class: "ai-note", style: "margin-top:4px" }, [
            icon("bolt", 15),
            el("span", { class: "muted", text: "Si vous êtes sur Android et que le message persiste, ouvrez la page dans un onglet plein écran : dans un cadre intégré, le navigateur refuse le suivi spatial." })
          ]),
          el("p", { class: "label", style: "margin-top:10px", text: "La voie qui marche partout" }),
          el("p", { class: "muted", style: "font-size:.875rem;line-height:1.6", text:
            "Scannez la pièce avec Scaniverse — gratuit, illimité, calculé sur le téléphone, sans compte. Exportez en .ply, puis importez le fichier ici. Sur iPhone Pro le LiDAR est utilisé, et le résultat est meilleur qu'une capture en direct." })
        ],
        foot: [
          el("button", { class: "btn btn-lg btn-volt", type: "button", style: "width:100%",
            onclick: function () { closeSheet(); importInput.click(); } }, [icon("upload", 16), "Importer un fichier .ply"])
        ]
      });
    }

    function startCapture() {
      if (!room) return;
      arSupport().then(function (status) {
        arReady = status;
        if (status !== "ready") return explainNoAr(status);
        dropScene();
        arCapture(room.name).then(function (cloud) {
          if (!cloud) { toast("Scan interrompu."); render(); return; }
          review = { kind: "cloud", cloud: cloud, locationId: room.id, source: "camera", up: "y", flip: false };
          render();
        }).catch(function (error) {
          render();
          sheet({
            title: "La capture n'a pas démarré",
            body: [
              el("p", { class: "lede", text: String((error && error.message) || error) }),
              el("p", { class: "muted", style: "font-size:.875rem;line-height:1.6", text:
                "Les causes habituelles : l'autorisation caméra a été refusée, la page est dans un cadre intégré qui interdit le suivi spatial, ou les services de réalité augmentée du téléphone ne sont pas installés." })
            ]
          });
        });
      });
    }

    /* Pourquoi le tour de la pièce est refusé.

       Le cas de loin le plus fréquent n'est pas un refus de l'utilisateur ni
       une limite de son téléphone : c'est que la page tourne DANS UN CADRE.
       Un aperçu intégré n'a pas le droit d'ouvrir la caméra, et le navigateur
       ne se contente pas de refuser — il retire `navigator.mediaDevices` de
       la page, si bien qu'il n'y a même pas de demande d'autorisation à
       afficher. Le dire franchement évite de chercher le défaut du mauvais
       côté. */
    function framed() {
      try { return window.self !== window.top; } catch (e) { return true; }
    }

    function explainNoPano(status) {
      var inFrame = framed();
      var cause =
        status === "insecure"
          ? "La caméra exige une connexion sécurisée. Ouvrez la page en HTTPS."
          : status === "no-orientation"
            ? "Cet appareil n'expose pas son orientation à la page : sans elle, impossible de savoir où pointe la caméra."
            : inFrame
              ? "Cette page est affichée à l'intérieur d'un cadre, et un cadre n'a pas le droit d'ouvrir la caméra. Votre téléphone n'y est pour rien : ce serait identique sur n'importe quel appareil."
              : "Cette vue n'a pas accès à la caméra.";

      var body = [el("p", { class: "lede", text: cause })];

      if (inFrame) {
        body.push(el("div", { class: "ai-note", style: "margin-top:4px" }, [
          icon("bolt", 15),
          el("span", { class: "muted", text:
            "Le navigateur va plus loin qu'un refus : il retire l'accès caméra de la page, il n'y a donc même pas d'autorisation à accorder. Pour faire le tour d'une pièce, la page doit être ouverte seule, en HTTPS, pas dans un aperçu." })
        ]));
      }

      body.push(el("p", { class: "label", style: "margin-top:10px", text: "Ce qui marche dès maintenant" }));
      body.push(el("p", { class: "muted", style: "font-size:.875rem;line-height:1.6", text:
        "Scannez la pièce avec Scaniverse — gratuit, illimité, calculé sur le téléphone, sans compte. Exportez en .ply et importez le fichier ici. Sur un iPhone Pro le LiDAR est utilisé, et le relevé est plus précis qu'une panoramique." }));

      sheet({
        title: inFrame ? "Le tour de la pièce demande une page à lui" : "La panoramique n'est pas possible ici",
        body: body,
        foot: [
          el("button", { class: "btn btn-lg btn-volt", type: "button", style: "width:100%",
            onclick: function () { closeSheet(); importInput.click(); } }, [icon("upload", 16), "Importer un fichier .ply"])
        ]
      });
    }

    /* Le tour de la pièce. C'est la voie universelle — et la seule sur iPhone,
       où Safari n'ouvre au web ni la réalité augmentée ni le LiDAR. */
    function runPano() {
      dropScene();
      window.FulmoPanoCapture.start({ roomName: room.name })
        .then(function (result) {
          if (!result) { toast("Tour de la pièce interrompu."); render(); return; }
          review = {
            kind: "pano", locationId: room.id, source: "pano",
            pano: {
              blob: result.blob, canvas: result.canvas,
              width: result.width, height: result.height,
              coverage: result.coverage, frames: result.frames,
              diag: result.diag || null
            }
          };
          render();
        })
        .catch(function (error) {
          render();
          sheet({
            title: "Le tour de la pièce n'a pas démarré",
            body: [
              el("p", { class: "lede", text: String((error && error.message) || error) }),
              el("p", { class: "muted", style: "font-size:.875rem;line-height:1.6", text:
                (error && error.code) === "motion-denied"
                  ? "Si aucune fenêtre d'autorisation n'est apparue, c'est que le réglage « Mouvement et orientation » est désactivé dans Réglages › Safari. Activez-le, rechargez la page, puis recommencez."
                  : "Les causes habituelles : l'autorisation caméra ou mouvement a été refusée, ou la page est dans un cadre intégré qui les interdit." })
            ]
          });
        });
    }

    /* Le tour de la pièce.

       L'ordre des deux premières lignes n'est pas cosmétique. iOS n'accorde
       les capteurs de mouvement que si la demande part de l'activation
       utilisateur EN COURS : toute promesse attendue entre le doigt et
       `requestPermission()` la consomme, et Safari refuse alors sans rien
       afficher — on récolte un refus qui n'a jamais été soumis à personne.

       D'où : on amorce le mouvement SYNCHRONEMENT, avant le moindre `then`,
       et on ne consulte les capacités de l'appareil qu'ensuite. Elles sont
       d'ailleurs résolues au démarrage, pour que le cas courant n'attende
       rien du tout. */
    function startPano() {
      if (!room) return;
      var api = window.FulmoPanoCapture;
      if (!api) return explainNoPano("absent");

      if (api.primeMotion) api.primeMotion();

      if (panoReady === "ready") return runPano();

      panoSupport().then(function (status) {
        panoReady = status;
        if (status !== "ready") return explainNoPano(status);
        runPano();
      });
    }

    var importInput = el("input", {
      type: "file", accept: ".ply,application/octet-stream", style: "display:none",
      onchange: function (event) {
        var file = event.target.files && event.target.files[0];
        event.target.value = "";
        if (!file || !room) return;
        toast("Lecture du fichier…");
        file.arrayBuffer().then(function (buffer) {
          var cloud;
          try { cloud = parsePly(buffer, 220000); }
          catch (error) {
            sheet({ title: "Fichier illisible", body: [el("p", { class: "lede", text: String(error.message || error) })] });
            return;
          }
          dropScene();
          // L'axe vertical se devine : dans une pièce, c'est celui dont
          // l'étendue est la plus faible. L'utilisateur corrige d'un bouton si
          // la supposition est mauvaise — elle se voit immédiatement.
          var b = cloudBounds(cloud);
          var up = b.size[1] <= b.size[2] ? "y" : "z";
          review = { kind: "cloud", cloud: recentreCloud(orientCloud(cloud, up, false)), locationId: room.id, source: "import", up: up, flip: false };
          render();
        });
      }
    });

    function reorient(up, flip) {
      dropScene();
      // On repart du relevé brut : deux réorientations successives ne doivent
      // pas s'empiler.
      orientCloud(review.cloud, review.up, review.flip);   // retour au repère d'origine
      review.up = up; review.flip = flip;
      review.cloud = recentreCloud(orientCloud(review.cloud, up, flip));
      render();
    }

    function saveReview() {
      var previous = scanOf(review.locationId);
      if (previous && !confirm("Remplacer le relevé de « " + (locById(review.locationId) || {}).name + " » ? Les rangements déjà situés devront être reposés.")) return;

      var id = uid("scan");
      var target = review.locationId;
      var source = review.source;
      var kind = review.kind || "cloud";

      var record = kind === "pano"
        ? { pano: review.pano.blob, width: review.pano.width, height: review.pano.height }
        : { pos: review.cloud.pos, col: review.cloud.col };
      var count = kind === "pano" ? review.pano.width * review.pano.height : review.cloud.count;

      scanStore.put(id, record).then(function () {
        if (previous && previous.source !== "demo") scanStore.del(previous.id);
        state.scans = (state.scans || []).filter(function (sc) { return sc.locationId !== target; });
        state.scans.push({ id: id, kind: kind, locationId: target, source: source, count: count, capturedAt: Date.now() });
        if (previous) {
          // Un nouveau relevé, un nouveau repère : les points posés sur
          // l'ancien ne désignent plus rien.
          descendantIds(target).forEach(function (lid) {
            var node = locById(lid);
            if (node) node.space = null;
          });
        }
        review = null;
        dropScene();
        save();
        render();
        toast("Relevé enregistré. Posez maintenant vos rangements.");
      });
    }

    // ─── Rail des pièces ────────────────────────────────────────────────
    var rail = el("div", { class: "room-rail", role: "tablist", "aria-label": "Pièces" },
      spaceRooms().map(function (r) {
        var sc = scanOf(r.id);
        var on = room && r.id === room.id;
        return el("button", {
          class: "room-chip" + (on ? " on" : "") + (sc ? " done" : ""), type: "button",
          role: "tab", "aria-selected": on ? "true" : "false",
          onclick: function () { goRoom(r.id); }
        }, [
          sym(r.icon || ICON_BY_KIND[r.kind], 21),
          el("span", { class: "nm", text: r.name }),
          sc ? el("span", { class: "tick", title: "Relevé disponible" }, [icon("check", 12)]) : null
        ]);
      }));

    // ─── Assemblage ─────────────────────────────────────────────────────
    var head = [
      el("div", { class: "inline", style: "gap:12px" }, [
        el("h1", { class: "display t-lg", text: "Votre logement" }),
        el("span", { class: "label badge", text: "Éclair" })
      ]),
      modeSwitch(),
      spaceRooms().length > 1 ? rail : null
    ];

    if (!room) {
      return el("div", { class: "page page-wide" }, head.concat([
        el("p", { class: "muted", style: "margin-top:40px;text-align:center", text: "Ajoutez une pièce pour pouvoir la scanner." })
      ]));
    }

    if (reviewing) {
      var isPano = review.kind === "pano";
      var tally = isPano
        ? Math.round(review.pano.coverage * 100) + " % de la sphère · " + plural(review.pano.frames || 0, "image", "images")
        : review.cloud.count.toLocaleString("fr-FR") + " points";

      return el("div", { class: "page page-wide" }, head.concat([
        el("div", { class: "review-tag" }, [
          icon(isPano ? "loop" : "cube", 16),
          el("span", { text: "Relevé de « " + room.name + " » — " + tally })
        ]),
        frame,
        el("div", { class: "inline", style: "margin-top:14px" }, [
          el("button", { class: "btn btn-lg btn-volt", type: "button", onclick: saveReview }, [icon("check", 16), "Enregistrer pour " + room.name]),
          el("button", { class: "btn btn-line", type: "button", onclick: function () { dropScene(); review = null; render(); } }, "Jeter"),
          // Une panoramique EST une photo : la teinter par la hauteur n'aurait
          // aucun sens. Le bouton n'existe que pour un nuage de points.
          isPano ? null : el("button", { class: "btn btn-line", type: "button", onclick: function () { spaceTint = !spaceTint; dropScene(); render(); } },
            [icon("sun", 15), spaceTint ? "Couleurs relevées" : "Relief par hauteur"])
        ]),
        review.source === "import" ? el("div", { class: "inline", style: "margin-top:12px" }, [
          el("span", { class: "label", text: "La pièce est de travers ?" }),
          el("button", { class: "btn btn-sm btn-line", type: "button", onclick: function () { reorient(review.up === "y" ? "z" : "y", review.flip); } }, "Basculer Y / Z"),
          el("button", { class: "btn btn-sm btn-line", type: "button", onclick: function () { reorient(review.up, !review.flip); } }, [icon("loop", 14), "Retourner"])
        ]) : null,
        isPano && review.pano.coverage < 0.72 ? el("p", { class: "err", style: "margin-top:12px", text:
          "Le tour est incomplet : il manque des pans de mur. Refaites-le en balayant plus haut et plus bas." }) : null,
        /* Le relevé technique de la capture.

           Il n'est pas là pour faire savant : sans iPhone sous la main, c'est
           le seul moyen de savoir pourquoi une panoramique sort floue. Le champ
           a-t-il été mesuré ou supposé, sur combien d'avis concordants, et à
           quelle vitesse le téléphone tournait-il pendant les prises — un
           dixième de seconde de pose à trente degrés par seconde suffit à filer
           chaque image. */
        (function () {
          var d = review.kind === "pano" && review.pano ? review.pano.diag : null;
          if (!d) return null;
          function deg(v) { return v === null || v === undefined ? "—" : (v * 180 / Math.PI).toFixed(0) + "°/s"; }
          var lines = [
            ["Caméra", (d.video || "—") + (d.screenAngle ? " · écran à " + d.screenAngle + "°" : "")],
            ["Champ de vision", d.hfovDeg === null ? "non mesuré"
              : d.hfovDeg.toFixed(1) + "° " + (d.hfovMeasured
                  ? "(mesuré sur " + d.hfovSamples + " avis"
                    + (d.hfovSpreadDeg === null ? "" : ", dispersion " + d.hfovSpreadDeg.toFixed(1) + "°") + ")"
                  : "(par défaut — non mesurable ici)")],
            ["Vitesse de rotation", "médiane " + deg(d.speedMedian) + " · pointe " + deg(d.speedMax)],
            ["Images écartées car trop rapides", String(d.skippedFast)]
          ];
          return el("details", { style: "margin-top:14px" }, [
            el("summary", { class: "label", style: "cursor:pointer", text: "Relevé technique de la capture" }),
            el("div", { class: "stack-sm", style: "margin-top:10px;padding:12px 14px;border:1.5px solid var(--line);border-radius:12px" },
              lines.map(function (row) {
                return el("div", { class: "inline", style: "justify-content:space-between;gap:16px;font-size:.8125rem" }, [
                  el("span", { class: "muted", text: row[0] }),
                  el("span", { style: "font-family:var(--mono);font-size:.75rem;text-align:right", text: row[1] })
                ]);
              }))
          ]);
        })(),

        el("p", { class: "muted", style: "font-size:.8125rem;margin-top:14px;max-width:62ch", text: isPano
          ? "Regardez autour de vous pour vérifier que la pièce est reconnaissable avant d'enregistrer. Rien n'est conservé tant que vous n'avez pas validé."
          : "Tournez autour pour vérifier que la pièce est reconnaissable avant d'enregistrer. Rien n'est conservé tant que vous n'avez pas validé." })
      ]));
    }

    if (!scan) {
      return el("div", { class: "page page-wide" }, head.concat([
        /* Trois voies, et c'est l'appareil qui décide laquelle passe devant.
           Proposer « volume » en premier à un iPhone, qui ne peut pas, serait
           lui offrir une porte fermée. */
        (function () {
          var volume = el("button", { class: "btn btn-lg btn-volt", type: "button", onclick: startCapture },
            [icon("scan", 17), "Relever en volume"]);
          var tour = el("button", { class: "btn btn-lg btn-volt", type: "button", onclick: startPano },
            [icon("loop", 17), "Faire le tour de la pièce"]);
          var ply = el("span", { class: "inline" }, [importInput,
            el("button", { class: "btn btn-line", type: "button", onclick: function () { importInput.click(); } },
              [icon("upload", 15), "Importer un .ply"])]);

          var volumeReady = arReady === "ready";
          if (volumeReady) tour.className = "btn btn-line";
          var order = volumeReady ? [volume, tour, ply] : [tour, ply];

          return el("div", { class: "scan-cta" }, [
            el("span", { class: "fig" }, [sym(room.icon || ICON_BY_KIND[room.kind], 38)]),
            el("h2", { class: "display t-md", text: room.name + " n'est pas encore relevée" }),
            el("p", { class: "lede", style: "text-align:center", text: volumeReady
              ? "Deux façons de faire. En volume, vous circulez et l'application relève murs et meubles en 3D. En panoramique, vous tournez sur vous-même et la pièce devient photographique."
              : "Tournez sur vous-même, appareil à la main : la pièce s'assemble en une panoramique photographique. Vous pourrez ensuite y poser vos rangements d'un doigt." }),
            el("div", { class: "inline", style: "justify-content:center;margin-top:8px" }, order),
            el("p", { class: "muted", style: "font-size:.75rem;text-align:center;max-width:56ch;line-height:1.6", text:
              arReady === null || panoReady === null
                ? "Vérification des capacités de l'appareil…"
                : volumeReady
                  ? "Relevé en volume disponible sur cet appareil."
                  : panoReady === "ready"
                    ? "Le relevé en volume demande ARCore, absent ici : le tour panoramique le remplace, et il marche sur tous les téléphones. Un .ply de Scaniverse reste la voie la plus précise."
                    : "Ni la caméra 3D ni la caméra simple ne sont accessibles dans cette vue. Ouvrez la page dans un onglet plein écran, ou importez un .ply." }),
            el("p", { class: "muted", style: "font-size:.75rem;text-align:center", text: "Tout est calculé sur l'appareil. Rien n'est envoyé." })
          ]);
        })()
      ]));
    }

    return el("div", { class: "page page-wide" }, head.concat([
      frame,
      bar,
      el("div", { class: "inline", style: "margin-top:14px" }, [
        el("button", { class: "btn btn-sm btn-line", type: "button", onclick: function () { if (spaceScene) spaceScene.reset(); } }, [icon("loop", 14), "Recadrer"]),
        scanKind(scan) === "cloud" ? el("button", {
          class: "btn btn-sm btn-line", type: "button",
          onclick: function () { spaceTint = !spaceTint; dropScene(); render(); }
        }, [icon("sun", 14), spaceTint ? "Couleurs relevées" : "Relief par hauteur"]) : null,
        arReady === "ready" ? el("button", { class: "btn btn-sm btn-line", type: "button", onclick: startCapture }, [icon("scan", 14), "Relever en volume"]) : null,
        el("button", { class: "btn btn-sm btn-line", type: "button", onclick: startPano }, [icon("loop", 14), "Refaire le tour"]),
        el("span", { class: "inline" }, [importInput,
          el("button", { class: "btn btn-sm btn-line", type: "button", onclick: function () { importInput.click(); } }, [icon("upload", 14), "Importer un .ply"])]),
        scan.source !== "demo" ? el("button", {
          class: "btn btn-sm btn-quiet", type: "button",
          onclick: function () {
            if (!confirm("Supprimer le relevé de « " + room.name + " » ? Les rangements situés perdront leur point.")) return;
            scanStore.del(scan.id);
            state.scans = state.scans.filter(function (sc) { return sc.id !== scan.id; });
            descendantIds(room.id).forEach(function (lid) {
              var node = locById(lid);
              if (node) node.space = null;
            });
            dropScene(); save(); render();
            toast("Relevé supprimé.");
          }
        }, [icon("trash", 14), "Supprimer"]) : null
      ]),

      el("section", { style: "margin-top:26px" }, [
        el("h2", { class: "label", style: "color:var(--accent)", text: "Rangements de « " + room.name + " »" }),
        el("p", { class: "muted", style: "font-size:.8125rem;margin-top:8px;max-width:60ch", text: "Posez chaque meuble à l'endroit où il se trouve vraiment : la recherche pourra alors désigner le point, et plus seulement le nommer." }),
        storages.length === 0
          ? el("p", { class: "muted", style: "font-size:.875rem;margin-top:14px", text: "Aucun rangement déclaré dans cette pièce. Ajoutez-en depuis « Mes lieux »." })
          : list
      ]),

      el("p", {
        class: "label",
        style: "text-transform:none;letter-spacing:.04em;font-size:.75rem;line-height:1.7;margin-top:18px;color:var(--faint)",
        text: scan.source === "demo"
          ? "Scan de démonstration engendré dans le navigateur. Scannez une vraie pièce, ou importez un .ply, pour voir la vôtre."
          : "Relevé " + (scan.source === "camera" ? "en volume" : scan.source === "pano" ? "en panoramique" : "importé") + " le " +
            new Date(scan.capturedAt).toLocaleDateString("fr-FR") + ", conservé sur cet appareil. Il ne quitte jamais le navigateur."
      })
    ]));
  }

  function modeSwitch() {
    return el("div", { style: "margin-top:16px" }, [
      el("div", { class: "view-switch" }, [
        el("button", {
          type: "button", "aria-pressed": mapMode === "2d" ? "true" : "false",
          onclick: function () { mapMode = "2d"; render(); }
        }, [icon("map", 15), "Plan"]),
        el("button", {
          type: "button", "aria-pressed": mapMode === "3d" ? "true" : "false",
          onclick: function () { mapMode = "3d"; render(); }
        }, [icon("cube", 15), "Espace 3D"])
      ])
    ]);
  }

  /* ═══ Plan — le logement en coupe ══════════════════════════════════════

     Le treemap était juste : la surface d'une pièce y valait son contenu. Il
     était aussi illisible — des rectangles de proportions arbitraires, sans
     rapport avec la forme d'un logement, qu'il fallait décoder au lieu de
     reconnaître.

     Cette version dessine ce que les gens ont en tête : des étages empilés,
     du grenier à la cave, et dans chaque étage les pièces côte à côte. La
     largeur d'une pièce suit toujours son contenu — l'information du treemap
     est conservée — mais la lecture est immédiate, et un logement se relit
     d'un coup d'œil six mois plus tard. */

  var FLOOR_NAMES = {
    "2": "Combles", "1": "Étage", "0": "Rez-de-chaussée", "-1": "Sous-sol"
  };

  function floorLabel(floor) {
    if (FLOOR_NAMES[String(floor)]) return FLOOR_NAMES[String(floor)];
    return floor > 0 ? floor + "ᵉ étage" : "Niveau " + floor;
  }

  function viewMap() {
    if (state.plan !== "premium") return paywall("Plan du logement", "Votre logement en coupe, ou scanné en 3D. La recherche ne renvoie plus une ligne de texte : elle désigne le bon rangement.");
    dropScene();
    if (mapMode === "3d") return viewSpace();

    function total(id) {
      var ids = descendantIds(id);
      return state.items.filter(function (item) { return ids.indexOf(item.locationId) !== -1; }).length;
    }

    var roots = state.locations.filter(function (l) { return !l.parentId; });
    var max = roots.reduce(function (m, r) { return Math.max(m, total(r.id)); }, 1);

    // Les étages, du plus haut au plus bas. Un logement se lit comme une
    // coupe : c'est la représentation que tout le monde a déjà en tête.
    var byFloor = {};
    roots.forEach(function (room) {
      var key = String(room.floor == null ? 0 : room.floor);
      (byFloor[key] = byFloor[key] || []).push(room);
    });
    var floors = Object.keys(byFloor).map(Number).sort(function (a, b) { return b - a; });

    function roomCard(room) {
      var count = total(room.id);
      var kids = childrenOf(room.id);
      // La part de la largeur suit le contenu, bornée : une pièce vide reste
      // cliquable, une pièce pleine ne mange pas toute la rangée.
      var weight = 0.55 + (count / max) * 1.6;

      return el("button", {
        class: "room-card" + (mapHover === room.id ? " hot" : ""),
        type: "button",
        style: "flex:" + weight.toFixed(2) + " 1 190px",
        "aria-label": room.name + ", " + plural(count, "objet", "objets"),
        onmouseenter: function () { mapHover = room.id; },
        onclick: function () { mapFocus = mapFocus === room.id ? null : room.id; render(); }
      }, [
        el("span", { class: "rc-head" }, [
          el("span", { class: "rc-icon" }, [sym(room.icon || ICON_BY_KIND[room.kind], 19)]),
          el("span", { class: "rc-name", text: room.name }),
          el("span", { class: "rc-n", text: String(count) })
        ]),

        /* La jauge : elle dit d'un trait ce que le treemap disait par la
           surface, sans déformer la pièce. */
        el("span", { class: "rc-bar" }, [
          el("i", { style: "width:" + Math.round((count / max) * 100) + "%" })
        ]),

        kids.length > 0
          ? el("span", { class: "rc-kids" }, kids.slice(0, 5).map(function (kid) {
              var n = total(kid.id);
              return el("span", { class: "rc-kid" }, [
                sym(kid.icon || ICON_BY_KIND[kid.kind], 13),
                kid.name,
                n > 0 ? el("b", { text: String(n) }) : null
              ]);
            }).concat(kids.length > 5 ? [el("span", { class: "rc-more", text: "+" + (kids.length - 5) })] : []))
          : el("span", { class: "rc-empty", text: "Aucun rangement" })
      ]);
    }

    var focus = mapFocus ? locById(mapFocus) : null;

    return el("div", { class: "page page-wide" }, [
      el("div", { class: "inline", style: "gap:12px" }, [
        el("h1", { class: "display t-lg", text: "Votre logement" }),
        el("span", { class: "label badge", text: "Éclair" })
      ]),
      modeSwitch(),

      state.locations.length === 0
        ? el("p", { class: "muted", style: "margin-top:40px;text-align:center", text: "Ajoutez des pièces pour construire votre plan." })
        : el("div", { class: "floors" }, floors.map(function (floor) {
            return el("section", { class: "floor" }, [
              el("div", { class: "floor-tag" }, [
                el("span", { class: "label", text: floorLabel(floor) }),
                el("span", { class: "label", style: "color:var(--faint)",
                             text: plural(byFloor[String(floor)].reduce(function (n, r) { return n + total(r.id); }, 0), "objet", "objets") })
              ]),
              el("div", { class: "floor-rooms" }, byFloor[String(floor)].map(roomCard))
            ]);
          })),

      focus ? el("div", { class: "focus-panel" }, [
        el("div", { class: "inline", style: "justify-content:space-between" }, [
          el("h2", { class: "inline", style: "font-family:var(--display);font-size:1.125rem;margin:0;gap:10px" }, [
            sym(focus.icon || ICON_BY_KIND[focus.kind], 20), focus.name
          ]),
          el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer",
                         onclick: function () { mapFocus = null; render(); } }, [icon("x", 17)])
        ]),
        el("ul", { class: "results", style: "margin-top:14px" },
          (function () {
            var ids = descendantIds(focus.id);
            var inside = state.items.filter(function (item) { return ids.indexOf(item.locationId) !== -1; }).slice(0, 12);
            if (inside.length === 0) return [el("p", { class: "muted", style: "font-size:.875rem", text: "Rien de référencé ici pour l'instant." })];
            return inside.map(function (item) {
              return el("li", { class: "result" }, [
                el("span", { class: "thumb" }, [sym(rootIconOf(item.locationId), 19)]),
                el("button", { class: "body", type: "button", onclick: function () { itemSheet(item); } }, [
                  el("div", { class: "name", text: item.name }),
                  el("div", { class: "path where", text: pathOf(item.locationId).slice(1).join(" / ") || "—" })
                ])
              ]);
            });
          })())
      ]) : null,

      el("p", {
        class: "label",
        style: "text-transform:none;letter-spacing:.04em;font-size:.75rem;line-height:1.7;margin-top:22px;color:var(--faint)",
        text: "Chaque étage montre ses pièces côte à côte ; la largeur et la jauge suivent ce qu'elles contiennent. Touchez une pièce pour voir ce qu'il y a dedans."
      })
    ]);
  }


  /* ─── Vue : alertes ───────────────────────────────────────────────── */

  function viewAlerts() {
    var rows = alerts();

    return el("div", { class: "page" }, [
      el("h1", { class: "display t-lg", text: "Alertes" }),
      el("p", { class: "lede", style: "margin-top:10px", text: "Ce qui demande votre attention." }),

      // Les alertes sont calculées pour tout le monde ; seule leur remontée par
      // email est réservée à l'Éclair. On ne cache pas derrière un paiement une
      // information qui concerne la santé ou les garanties.
      state.plan !== "premium" && rows.length > 0 ? el("div", { class: "ai-note" }, [
        icon("bolt", 15),
        el("span", { class: "muted", text: "Avec l'Éclair, ces alertes vous parviennent par email avant que la date ne passe." })
      ]) : null,

      rows.length === 0
        ? el("p", { class: "muted", style: "text-align:center;margin-top:56px", text: "Rien à signaler. Tout est à jour." })
        : el("ul", { class: "row-list", style: "margin-top:20px" }, rows.map(function (row) {
            var overdue = row.days < 0;
            var text = row.kind === "expiry"
              ? (overdue ? "Périmé depuis " + Math.abs(row.days) + " j" : "Périme dans " + row.days + " j")
              : row.kind === "warranty"
                ? "Garantie expire dans " + row.days + " j"
                : "Prêté à " + row.lentTo + " depuis " + row.days + " j";
            if (row.kind === "lent") text = "Prêté à " + row.item.lentTo + " depuis " + row.days + " j";

            return el("li", { class: "alert-row" }, [
              (function () {
                var i = icon(row.kind === "expiry" ? "warn" : row.kind === "warranty" ? "shield" : "loop", 19);
                i.style.color = overdue ? "var(--danger)" : "var(--warn)";
                return i;
              })(),
              el("button", {
                class: "body", type: "button", style: "flex:1;min-width:0;text-align:left;border:0;background:transparent;cursor:pointer;padding:0",
                onclick: function () { itemSheet(row.item); }
              }, [
                el("div", { style: "font-size:.9375rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", text: row.item.name }),
                el("div", { class: "path", style: "color:var(--faint);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", text: pathOf(row.item.locationId).join(" / ") })
              ]),
              el("span", { class: "label", style: "flex-shrink:0;color:" + (overdue ? "var(--danger)" : "var(--warn)"), text: text })
            ]);
          }))
    ]);
  }

  /* ─── Vue : réglages ──────────────────────────────────────────────── */

  function viewSettings() {
    var premium = state.plan === "premium";

    function switchRow(label, hint, checked, onChange) {
      return el("div", { class: "stack-sm" }, [
        el("div", { class: "switch" }, [
          el("button", {
            type: "button", role: "switch", "aria-checked": checked ? "true" : "false",
            "aria-label": label, onclick: onChange
          }, [el("i")]),
          el("span", { style: "font-size:.9375rem", text: label })
        ]),
        hint ? el("p", { class: "muted", style: "font-size:.75rem;padding-left:58px", text: hint }) : null
      ]);
    }

    return el("div", { class: "page" }, [
      el("h1", { class: "display t-lg", text: "Réglages" }),

      el("div", { class: "section", style: "margin-top:20px" }, [
        el("h2", { text: "Compte" }),
        el("div", { class: "row", style: "margin-top:12px" }, [
          el("div", { style: "flex:1;min-width:0" }, [
            el("div", { style: "font-weight:500;font-size:.9375rem", text: state.account ? state.account.name : "—" }),
            el("div", { class: "muted", style: "font-size:.8125rem", text: state.account ? state.account.email : "" })
          ])
        ])
      ]),

      el("div", { class: "section" }, [
        el("h2", { text: "Abonnement" }),
        el("p", { class: "muted", style: "font-size:.875rem", text: premium ? "Éclair — 9 €/mois (activé gratuitement en prototype)" : "Libre — gratuit" }),
        el("div", { style: "margin-top:14px" }, [
          switchRow(
            premium ? "Éclair activé" : "Activer l'Éclair",
            "Dans la vraie application, cette bascule ouvre un paiement Stripe. Ici elle est libre : basculez autant que vous voulez pour comparer les deux formules.",
            premium,
            function () {
              state.plan = premium ? "free" : "premium";
              if (!premium && (state.tab === "scan" || state.tab === "map")) { /* on reste sur la page */ }
              save(); render();
              toast(state.plan === "premium" ? "Éclair activé." : "Retour au plan Libre.");
            }
          )
        ])
      ]),

      el("div", { class: "section" }, [
        el("h2", { text: "Apparence" }),
        el("div", { class: "seg", style: "margin-top:12px" }, [
          ["light", "Clair"], ["dark", "Sombre"]
        ].map(function (option) {
          return el("button", {
            type: "button", "aria-pressed": state.theme === option[0] ? "true" : "false",
            onclick: function () { state.theme = option[0]; applyTheme(); save(); render(); },
            text: option[1]
          });
        }))
      ]),

      el("div", { class: "section" }, [
        el("h2", { text: "Vos données" }),
        el("p", { class: "muted", style: "font-size:.875rem", text: "Tout est stocké dans ce navigateur. Rien n'est envoyé à un serveur." }),
        el("div", { class: "inline", style: "margin-top:14px" }, [
          downloadsApi ? el("button", {
            class: "btn btn-line", type: "button",
            onclick: function () {
              var payload = {
                exported_at: new Date().toISOString(), format: "fulmo.export.v1",
                household: state.household, locations: state.locations, items: state.items
              };
              downloadsApi.save({
                filename: "fulmo-export-" + new Date().toISOString().slice(0, 10) + ".json",
                data: JSON.stringify(payload, null, 2)
              }).then(function () {
                toast("Export enregistré.");
              }).catch(function () {
                // Le visiteur peut refuser : ce n'est pas une erreur.
                toast("Export annulé.");
              });
            }
          }, [icon("download", 15), "Exporter en JSON"]) : null,

          el("button", {
            class: "btn btn-line", type: "button",
            onclick: function () {
              if (state.items.length > 0 && !confirm("Remplacer le contenu actuel par le logement d'exemple ?")) return;
              seedHousehold(); save(); state.tab = "search"; render();
              toast("Logement d'exemple chargé : 40 objets.");
            }
          }, "Charger le logement d'exemple"),

          el("button", {
            class: "btn btn-danger", type: "button",
            onclick: function () {
              if (!confirm("Effacer ce prototype et repartir de l'inscription ?")) return;
              state = blank(); save(); render();
            }
          }, [icon("trash", 15), "Tout effacer"])
        ])
      ]),

      el("div", { class: "section" }, [
        el("h2", { text: "Ce qui diffère de la vraie application" }),
        el("ul", { class: "stack-sm", style: "list-style:none;padding:0;margin:12px 0 0" }, [
          "L'inscription n'envoie pas d'email de confirmation et n'appelle pas Supabase Auth.",
          "L'abonnement ne passe pas par Stripe : la bascule Éclair est libre.",
          "Le foyer partagé et les invitations par email ne sont pas rejouables sans serveur.",
          "Les données vivent dans ce navigateur, pas dans PostgreSQL avec sa Row Level Security.",
          "Le moteur de recherche, lui, est le portage fidèle de la logique SQL : accents, casse, préfixes et fautes de frappe."
        ].map(function (line) {
          return el("li", { class: "inline", style: "gap:10px;align-items:flex-start" }, [
            el("span", { "aria-hidden": "true", style: "color:var(--accent);margin-top:7px;width:12px;height:1px;background:currentColor;flex-shrink:0" }),
            el("span", { class: "muted", style: "font-size:.875rem;line-height:1.6", text: line })
          ]);
        }))
      ])
    ]);
  }

  function paywall(title, body) {
    return el("div", { class: "page" }, [
      el("div", { class: "empty" }, [
        el("div", { class: "blob", style: "background:color-mix(in oklab, var(--volt) 14%, transparent);color:var(--accent)" }, [icon("bolt", 26)]),
        el("span", { class: "label badge", text: "Fonction Éclair" }),
        el("h1", { class: "display t-md", style: "margin-top:6px", text: title }),
        el("p", { class: "lede", style: "max-width:44ch", text: body }),
        el("button", {
          class: "btn btn-lg btn-volt", type: "button", style: "margin-top:10px",
          onclick: function () { state.plan = "premium"; save(); render(); toast("Éclair activé — gratuitement, en mode prototype."); }
        }, [icon("bolt", 16), "Activer l'Éclair (gratuit en démo)"]),
        el("p", { class: "muted", style: "font-size:.75rem;max-width:40ch", text: "Dans la vraie application, ce bouton ouvre un paiement Stripe à 9 €/mois, résiliable en un clic." })
      ])
    ]);
  }

  /* ─── Feuille d'objet ─────────────────────────────────────────────── */

  function itemSheet(item, defaultName) {
    var draft = item
      ? {
          name: item.name, locationId: item.locationId, spot: item.spot || "",
          tags: (item.tags || []).join(", "), description: item.description || "",
          quantity: item.quantity || 1, expiresAt: item.expiresAt || "",
          lentTo: item.lentTo || ""
        }
      : {
          name: defaultName || "", locationId: null, spot: "", tags: "",
          description: "", quantity: 1, expiresAt: "", lentTo: ""
        };

    function commit() {
      var name = draft.name.trim();
      if (!name) return;

      var tags = draft.tags.split(/[,;\n]/).map(function (t) { return t.trim(); })
        .filter(function (t) { return t.length > 0 && t.length <= 40; }).slice(0, 25);

      var payload = {
        name: name.slice(0, 120),
        locationId: draft.locationId || null,
        spot: draft.spot.trim() || null,
        tags: tags,
        description: draft.description.trim() || null,
        quantity: Math.max(0, Math.min(100000, parseInt(draft.quantity, 10) || 1)),
        expiresAt: draft.expiresAt || null,
        lentTo: draft.lentTo.trim() || null,
        lastSeenAt: Date.now()
      };
      if (payload.lentTo && (!item || !item.lentTo)) payload.lentAt = Date.now();
      if (!payload.lentTo) payload.lentAt = null;

      if (item) Object.keys(payload).forEach(function (key) { item[key] = payload[key]; });
      else {
        payload.id = uid("it");
        payload.warrantyUntil = null;
        payload.createdAt = Date.now();
        if (payload.lentAt === undefined) payload.lentAt = null;
        state.items.push(payload);
      }

      save();
      closeSheet();
      render();
      toast(item ? "Objet enregistré." : "Objet référencé.");
    }

    function textField(label, key, placeholder, hint, type) {
      return el("label", { class: "field" }, [
        el("span", { text: label }),
        el("input", {
          class: "input", type: type || "text", value: draft[key], placeholder: placeholder,
          maxlength: 200,
          oninput: function (event) { draft[key] = event.target.value; }
        }),
        hint ? el("span", { style: "font-size:.75rem;color:var(--faint)", text: hint }) : null
      ]);
    }

    var card = sheet({
      title: item ? "Modifier l'objet" : "Nouvel objet",
      body: [
        el("label", { class: "field" }, [
          el("span", { text: "Nom de l'objet" }),
          el("input", {
            class: "input", style: "font-size:1.0625rem", value: draft.name, maxlength: 120,
            placeholder: "Perceuse, passeport, guirlande…", autofocus: true,
            oninput: function (event) { draft.name = event.target.value; },
            onkeydown: function (event) { if (event.key === "Enter") { event.preventDefault(); commit(); } }
          }),
          el("span", { style: "font-size:.75rem;color:var(--faint)", text: "Nommez-le comme vous le chercherez plus tard." })
        ]),

        locationField({
          label: "Où est-il rangé ?",
          value: draft.locationId,
          onChange: function (id) { draft.locationId = id; }
        }),

        /* Le rangement a été posé dans un scan : on peut donc montrer l'endroit
           au lieu de l'épeler. C'est tout l'intérêt d'avoir situé les meubles. */
        (function () {
          var host = item ? situatedAncestor(item.locationId) : null;
          if (!host || state.plan !== "premium") return null;
          return el("button", {
            class: "btn btn-line", type: "button", style: "align-self:flex-start",
            onclick: function () {
              spaceFocus = host.id;
              // La vue 3D montre UNE pièce : il faut d'abord aller dans la
              // bonne, sinon le point désigné n'est pas dans le nuage affiché.
              var root = host, guard = 0;
              while (root && root.parentId && guard < 12) { root = locById(root.parentId) || root; guard += 1; }
              dropScene();
              spaceRoomId = root ? root.id : null;
              mapMode = "3d";
              closeSheet();
              goTab("map");
            }
          }, [icon("cube", 15), "Voir « " + host.name + " » dans la pièce"]);
        })(),

        textField("Endroit précis", "spot", "Tiroir du haut, bac 3, étagère B…"),
        textField("Mots-clés", "tags", "noël, déco, fragile", "Séparez par des virgules. Sert à retrouver plusieurs objets d'un coup."),
        textField("Notes", "description", "Modèle, couleur, à qui c'est…"),

        el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:12px" }, [
          textField("Quantité", "quantity", "1", null, "number"),
          textField("Péremption", "expiresAt", "", null, "date")
        ]),

        textField("Prêté à", "lentTo", "Prénom, si l'objet est sorti"),

        item ? el("button", {
          class: "btn btn-line", type: "button", style: "align-self:flex-start;color:var(--danger);border-color:color-mix(in oklab, var(--danger) 40%, transparent)",
          onclick: function () {
            if (!confirm("Supprimer « " + item.name + " » ? Cette action est définitive.")) return;
            state.items = state.items.filter(function (i) { return i.id !== item.id; });
            save(); closeSheet(); render(); toast("Objet supprimé.");
          }
        }, [icon("trash", 15), "Supprimer cet objet"]) : null
      ],
      foot: [
        el("button", { class: "btn btn-lg btn-volt", type: "button", style: "width:100%", onclick: commit, text: "Enregistrer" })
      ]
    });

    return card;
  }

  /* ─── Thème ───────────────────────────────────────────────────────── */

  /* Le blanc est le défaut du produit, pas une conséquence du système : on
     cherche un objet en plein jour. Le sombre reste à un clic. */
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme === "dark" ? "dark" : "light");
  }

  /* ─── Rendu ───────────────────────────────────────────────────────── */

  function render() {
    var previousScroll = window.scrollY;

    var screen;
    if (!state.account) screen = screenSignup();
    else if (!state.household) screen = screenOnboarding();
    else screen = screenApp();

    root.replaceChildren(demoBar(), screen);

    // Le contenu est reconstruit à chaque rendu ; sans cela, le moindre clic
    // renverrait l'utilisateur en haut de page.
    if (state.account && state.household) window.scrollTo(0, previousScroll);
  }

  applyTheme();
  render();

  /* Ce que l'appareil sait faire en matière de relevé 3D. Résolu une fois,
     après le premier rendu : la page ne doit jamais attendre ces réponses. */
  arSupport().then(function (status) {
    arReady = status;
    if (state.tab === "map" && mapMode === "3d") render();
  });

  /* Idem pour la panoramique, et pour une raison qui n'est pas que
     cosmétique : si cette réponse n'arrive qu'au moment du clic, l'attente
     consomme l'activation utilisateur et iOS refuse les capteurs de mouvement
     sans rien demander. Résolue ici, le geste n'attend plus rien. */
  panoSupport().then(function (status) {
    panoReady = status;
    if (state.tab === "map" && mapMode === "3d") render();
  });
  panoSupport().then(function (status) {
    panoReady = status;
    if (state.tab === "map" && mapMode === "3d") render();
  });

  /* ─── Capacité `sample` ───────────────────────────────────────────────
     Résolue après le premier rendu : la page doit s'afficher immédiatement et
     fonctionner entièrement sans elle. Les deux fonctions qui s'en servent
     s'allument quand elle arrive. */

  if (window.claude && typeof window.claude.use === "function") {
    window.claude.use("sample").then(function (api) {
      if (!api) return;
      sampleApi = api;
      return api.limits().then(function (limits) {
        sampleImages = limits && limits.images ? limits.images : null;
        sampleChecked = true;
      }).catch(function () { sampleImages = null; sampleChecked = true; });
    }).then(function () {
      sampleChecked = true;
      if (state.tab === "scan" || state.tab === "search") render();
    }).catch(function () { sampleChecked = true; });

    window.claude.use("downloads").then(function (api) {
      if (!api) return;
      downloadsApi = api;
      if (state.tab === "settings") render();
    }).catch(function () {});
  } else {
    // Aucune passerelle vers l'assistant — aperçu local, navigateur nu. Rien à
    // attendre : le Scan Éclair passe directement par sa démonstration plutôt
    // que d'offrir un bouton photo qui ne mène nulle part.
    sampleChecked = true;
  }
})();
