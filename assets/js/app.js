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

  /* Application en ligne (app.getfulmo.com) : la même interface, mais le
     compte, le foyer et l'inventaire vivent sur le serveur, en Europe. La page
     hôte définit window.FulmoCloud avant de charger ce fichier. Sur
     getfulmo.com il n'existe pas : la démonstration garde tout dans le
     navigateur et rien, ici, ne parle au réseau. */
  var cloud = window.FulmoCloud || null;
  /* Les pages du site (conditions, confidentialité…) vivent sur getfulmo.com. */
  function siteUrl(path) { return cloud ? cloud.site + path : path; }

  /* ─── Persistance ─────────────────────────────────────────────────── */

  function blank() {
    return {
      account: null,
      session: false,   // connecté ou non ; se déconnecter garde le compte et le logement
      plan: "free",
      planSeen: false,
      household: null,
      history: [],
      scans: [],
      locations: [],
      items: [],
      screen: "signup",
      tab: "search",
      theme: "light",
      consents: {},     // { ai: { granted, at, version } } : preuve des accords (art. 7.1 RGPD)
      tourSeen: false   // visite guidée vue ou terminée : elle ne s'impose qu'une fois
    };
  }

  /* Un compte enregistré avant la visite guidée est déjà entré dans
     l'application : on ne la lui impose pas après coup. */
  function tourMigrate(saved, base) {
    if (saved.tourSeen === undefined) base.tourSeen = !!saved.household;
  }

  var state = load();

  function load() {
    if (cloud) return cloud.initial(blank());
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
      // Avant la déconnexion, un compte enregistré voulait dire « connecté » :
      // on ne renvoie pas ces visiteurs vers l'écran de connexion.
      if (parsed.session === undefined) base.session = !!base.account;
      tourMigrate(parsed, base);
      return base;
    } catch (e) {
      // Navigation privée, stockage bloqué, données corrompues : on repart
      // d'un état propre plutôt que de planter au chargement.
      return blank();
    }
  }

  function save() {
    if (cloud) { cloud.persist(state); return; }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
    stash();
  }

  /* ─── Comptes de cet appareil ─────────────────────────────────────────

     Pas de serveur dans le prototype : chaque compte créé ici garde son
     propre logement dans un registre local, indexé par email. `state` est le
     compte ouvert ; le registre les garde tous, démonstration comprise. Créer
     un compte n'écrase donc plus jamais celui d'avant : on bascule de l'un à
     l'autre par la connexion. */

  var ACCOUNTS_KEY = "fulmo.accounts.v1";
  var DEMO_ACCOUNT = { name: "Camille Dupont", email: "camille@exemple.fr" };

  function accountKey(email) { return String(email || "").trim().toLowerCase(); }
  function accountsRead() {
    if (cloud) return {};   // en ligne : un compte, celui de la session
    try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || {}; } catch (e) { return {}; }
  }
  function accountsWrite(map) {
    if (cloud) return;
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(map)); } catch (e) {}
  }
  function accountFind(email) {
    var saved = accountsRead()[accountKey(email)];
    return saved && saved.account ? saved : null;
  }
  /* Les comptes de l'appareil, le plus récemment utilisé d'abord. */
  function accountsList() {
    var map = accountsRead();
    return Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (saved) { return saved && saved.account; })
      .sort(function (a, b) { return (b.lastUsed || 0) - (a.lastUsed || 0); });
  }
  /* Range le compte ouvert dans le registre. Appelé par save(). */
  function stash() {
    if (!state.account || !state.account.email) return;
    var map = accountsRead();
    var copy = JSON.parse(JSON.stringify(state));
    copy.session = false;
    copy.lastUsed = Date.now();
    map[accountKey(state.account.email)] = copy;
    accountsWrite(map);
  }
  /* Ouvre un compte du registre à la place du compte courant. Le thème est
     une préférence de l'appareil : il ne change pas avec le compte. */
  function accountOpen(email) {
    var saved = accountFind(email);
    if (!saved) return false;
    var base = blank();
    Object.keys(base).forEach(function (key) {
      if (saved[key] !== undefined) base[key] = saved[key];
    });
    tourMigrate(saved, base);
    base.theme = state.theme;
    state = base;
    return true;
  }

  // Un compte enregistré par une version précédente entre dans le registre.
  if (state.account && !accountFind(state.account.email)) stash();

  var seq = 0;
  function uid(prefix) {
    // En ligne, pièces et objets portent l'identifiant de la base (UUID).
    if (cloud && (prefix === "loc" || prefix === "it")) return cloud.uuid();
    seq += 1;
    return prefix + "-" + Date.now().toString(36) + "-" + seq;
  }

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
    /* `suggests` : des clés du catalogue FURNITURE, dans l'ordre où on les
       rencontre dans la pièce. Rien n'est ajouté d'office : ce sont des
       propositions qu'on touche pour les ajouter. */
    { key: "cuisine",   label: "Cuisine",          icon: "r-cuisine", kind: "room", common: true,  suggests: ["placardhaut", "placardbas", "sousevier", "colonne", "frigo", "etageremurale"] },
    { key: "salon",     label: "Salon",            icon: "r-salon", kind: "room", common: true,  suggests: ["tv", "biblio", "buffet", "niche", "etageresmurales"] },
    { key: "chambre",   label: "Chambre",          icon: "r-chambre", kind: "room", common: true,  suggests: ["armoire", "commode", "chevet", "souslit", "penderie"] },
    { key: "sdb",       label: "Salle de bain",    icon: "r-sdb", kind: "room", common: true,  suggests: ["sousvasque", "pharmacie", "colonne", "etageremurale", "panier"] },
    { key: "entree",    label: "Entrée",           icon: "r-entree", kind: "room", common: true,  suggests: ["chaussures", "placard", "pateres", "coffre"] },
    { key: "bureau",    label: "Bureau",           icon: "r-bureau", kind: "room", common: true,  suggests: ["bureau", "tiroirs", "biblio", "etageresmurales", "caisse"] },
    { key: "enfant",    label: "Chambre d'enfant", icon: "r-enfant", kind: "room", suggests: ["commode", "niche", "coffre", "armoire", "panier"] },
    { key: "sam",       label: "Salle à manger",   icon: "r-sam", kind: "room", suggests: ["buffet", "vitrine", "etageremurale"] },
    { key: "wc",        label: "WC",               icon: "r-wc", kind: "room", suggests: ["etageremurale", "panier", "colonne"] },
    { key: "buanderie", label: "Buanderie",        icon: "r-buanderie", kind: "room", suggests: ["etagere", "placard", "panier", "caisse"] },
    { key: "dressing",  label: "Dressing",         icon: "r-dressing", kind: "room", suggests: ["penderie", "commode", "etagere", "chaussures"] },
    { key: "cellier",   label: "Cellier",          icon: "r-cellier", kind: "room", suggests: ["etagere", "caisse", "congel", "frigo"] },
    { key: "garage",    label: "Garage",           icon: "r-garage", kind: "zone", suggests: ["rack", "servante", "etagere", "caisse"] },
    { key: "cave",      label: "Cave",             icon: "r-cave", kind: "zone", suggests: ["etagere", "caisse", "carton"] },
    { key: "grenier",   label: "Grenier",          icon: "r-grenier", kind: "zone", suggests: ["carton", "valise", "caisse", "etagere"] },
    { key: "cabanon",   label: "Cabanon",          icon: "r-cabanon", kind: "zone", suggests: ["servante", "rack", "etagere"] },
    { key: "atelier",   label: "Atelier",          icon: "r-atelier", kind: "zone", suggests: ["servante", "rack", "etageresmurales"] },
    { key: "jardin",    label: "Jardin",           icon: "r-jardin", kind: "zone", suggests: ["coffre", "caisse"] },
    { key: "terrasse",  label: "Terrasse",         icon: "r-terrasse", kind: "zone", suggests: ["coffre"] },
    { key: "balcon",    label: "Balcon",           icon: "r-balcon", kind: "zone", suggests: ["coffre", "etagere"] },
    { key: "couloir",   label: "Couloir",          icon: "r-couloir", kind: "room", suggests: ["placard", "colonne", "pateres"] },
    { key: "veranda",   label: "Véranda",          icon: "r-veranda", kind: "room", suggests: ["coffre", "panier"] },
    { key: "debarras",  label: "Débarras",         icon: "r-debarras", kind: "room", suggests: ["etagere", "caisse", "carton", "sousescalier"] },
    { key: "soussol",   label: "Sous-sol",         icon: "r-soussol", kind: "zone", suggests: ["etagere", "caisse", "congel"] }
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
    { key: "souslit",    label: "Sous le lit",         pic: "f-souslit",   hint: "L'espace sous le lit, avec ou sans bacs." },
    { key: "tv",         label: "Meuble TV",           pic: "f-tv",        hint: "Bas et long, sous la télévision. Niches, tiroirs, câbles.", kw: "télé télévision tv audio hifi" },
    { key: "chaussures", label: "Meuble à chaussures", pic: "f-chaussures", hint: "Abattants inclinés, près de la porte d'entrée.", kw: "range-chaussures range chaussures souliers baskets" },
    { key: "etageremurale", label: "Étagère murale",   pic: "f-etagere-murale", hint: "Une planche fixée au mur sur des équerres.", kw: "planche équerre tablette murale" },
    { key: "etageresmurales", label: "Étagères murales", pic: "f-etageres-murales", hint: "Plusieurs planches décalées sur un même mur.", kw: "planches tablettes" },
    { key: "colonne",    label: "Placard colonne",     pic: "f-colonne",   hint: "Étroit et toute hauteur, du sol au plafond.", kw: "colonne haute placard mural" },
    { key: "placardhaut", label: "Placard haut",       pic: "f-placard-haut", hint: "Fixé au mur, au-dessus du plan de travail.", kw: "meuble haut cuisine élément haut" },
    { key: "placardbas", label: "Placard bas",         pic: "f-placard-bas", hint: "Sous le plan de travail, portes battantes.", kw: "meuble bas cuisine élément bas" },
    { key: "sousevier",  label: "Meuble sous évier",   pic: "f-sous-vasque", hint: "Sous l'évier, autour des tuyaux. Produits ménagers.", kw: "évier sous-évier" },
    { key: "sousvasque", label: "Meuble sous vasque",  pic: "f-sous-vasque", hint: "Sous le lavabo de la salle de bain.", kw: "lavabo vasque" },
    { key: "sousescalier", label: "Placard sous l'escalier", pic: "f-sous-escalier", hint: "Le volume en pente sous les marches.", kw: "escalier soupente" },
    { key: "niche",      label: "Meuble à cases",      pic: "f-niche",     hint: "Cases carrées ouvertes, avec ou sans paniers.", kw: "cube niche cases kallax" },
    { key: "panier",     label: "Panier",              pic: "f-panier",    hint: "En osier ou en tissu, posé ou glissé dans une case.", kw: "boîte corbeille osier" },
    { key: "caisse",     label: "Caisse à couvercle",  pic: "f-caisse",    hint: "Plastique, empilable, fermée par un couvercle à clips.", kw: "boîte box bac couvercle" },
    { key: "penderie",   label: "Penderie",            pic: "f-penderie",  hint: "Une barre et des cintres, sur pieds ou dans un placard.", kw: "portant cintres vêtements" },
    { key: "casier",     label: "Casier",              pic: "f-casier",    hint: "Petites portes individuelles, une par personne ou par usage.", kw: "vestiaire consigne" },
    { key: "vitrine",    label: "Vitrine",             pic: "f-vitrine",   hint: "Portes vitrées : on voit sans ouvrir.", kw: "vaisselier verre" },
    { key: "pateres",    label: "Patères",             pic: "f-pateres",   hint: "Crochets muraux pour sacs, manteaux et clés.", kw: "crochets portemanteau porte-manteau" }
  ];

  function furnitureByLabel(label) {
    for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].label === label) return FURNITURE[i];
    return null;
  }

  function furnitureByKey(key) {
    for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].key === key) return FURNITURE[i];
    return null;
  }

  /* L'icône d'un rangement saisi à la main, devinée d'après son nom :
     « Étagère du cellier » → étagère, « Placard de l'entrée » → placard.
     Les libellés longs d'abord, pour que « étagère murale » gagne sur
     « étagère ». Sans correspondance : l'icône générique. */
  function furnitureGuessPic(label) {
    var text = " " + norm(label) + " ";
    var entries = FURNITURE.slice().sort(function (a, b) { return b.label.length - a.label.length; });
    for (var i = 0; i < entries.length; i++) {
      var words = [entries[i].label].concat(entries[i].kw ? entries[i].kw.split(" ") : []);
      for (var j = 0; j < words.length; j++) {
        var w = norm(words[j]);
        if (w.length > 2 && text.indexOf(w) !== -1) return entries[i].pic;
      }
    }
    return "f-autre";
  }

  /* Le nom lisible d'une icône du jeu, pour les lecteurs d'écran. */
  function iconName(id) {
    var i;
    for (i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].pic === id) return FURNITURE[i].label;
    for (i = 0; i < ROOMS.length; i++) if (ROOMS[i].icon === id) return ROOMS[i].label;
    return id;
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
    ["Meubles", ["f-armoire", "f-placard", "f-commode", "f-tiroirs", "f-buffet", "f-tv", "f-chaussures",
                 "f-biblio", "f-vitrine", "f-niche", "f-bureau", "f-chevet", "f-coffre", "f-servante", "f-frigo", "f-congel"]],
    ["Rangements muraux et placards", ["f-etagere", "f-etagere-murale", "f-etageres-murales", "f-colonne",
                 "f-placard-haut", "f-placard-bas", "f-sous-vasque", "f-sous-escalier", "f-pharmacie",
                 "f-penderie", "f-casier", "f-pateres", "f-rack", "f-souslit"]],
    ["Boîtes et contenants", ["f-bac", "f-caisse", "f-panier", "f-carton", "f-valise", "f-autre"]],
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
        else if (key === "html") node.innerHTML = value; // html-sûr : n'accepte que des chaînes SVG écrites dans ce fichier, jamais une saisie
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
        wrap.innerHTML = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:block">' + // html-sûr : SVG constant
          '<circle cx="24" cy="24" r="19.8" stroke="currentColor" stroke-width="4.2"/>' +
          '<path d="M28.5 4.5 L13.5 27 h8.4 L19 43.5 L34.5 20 h-8.5 Z" fill="#d9ff3d" stroke="#050506" stroke-width="1.7" stroke-linejoin="round"/></svg>';
        wrap.style.display = "inline-flex";
        wrap.style.width = "0.92em";
        wrap.style.height = "0.92em";
        return wrap;
      })(),
      el("span", { class: "beta-badge", title: "Version bêta", text: "Bêta" })
    ]);
  }

  var toastTimer = null;
  function toast(message) {
    var existing = document.querySelector(".toast");
    if (existing) existing.remove();
    var node = el("div", { class: "toast", role: "status", "aria-live": "polite" }, [icon("bolt", 15), el("span", { text: message })]);
    document.body.appendChild(node);
    clearTimeout(toastTimer);
    // Une sortie, pas une disparition : le message s'efface au lieu de
    // s'évanouir d'une image à l'autre.
    toastTimer = setTimeout(function () {
      node.classList.add("is-leaving");
      setTimeout(function () { node.remove(); }, 260);
    }, 2800);
  }

  function plural(count, one, many) { return count + " " + (Math.abs(count) < 2 ? one : many); }

  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* Confirmation dans le style de l'application. `confirm()` bloquait la page,
     ignorait le thème et ne disait pas ce que le bouton allait faire. */
  function confirmSheet(options) {
    var done = false;
    function cancel() {
      if (done) return;
      done = true;
      closeSheet();
      if (options.onCancel) options.onCancel();
    }
    var cancelButton = el("button", { class: "btn btn-line", type: "button", onclick: cancel }, options.cancelLabel || "Annuler");
    var okButton = el("button", {
      class: "btn " + (options.danger ? "btn-danger" : "btn-volt"), type: "button",
      onclick: function () {
        if (done) return;
        done = true;
        closeSheet();
        options.onConfirm();
      }
    }, options.danger ? [icon("trash", 15), options.confirmLabel] : options.confirmLabel);
    sheet({
      title: options.title,
      role: "alertdialog",
      body: [el("p", { class: "confirm-body" }, options.body)],
      foot: [cancelButton, okButton],
      initialFocus: cancelButton,
      onClose: function () {
        if (done) return;
        done = true;
        if (options.onCancel) options.onCancel();
      }
    });
  }

  /* ─── Consentements (RGPD) ───────────────────────────────────────────

     Les fonctions d'IA envoient une phrase ou une photo à un fournisseur
     établi aux États-Unis : on le dit, et on attend un accord explicite
     avant le premier envoi. L'accord est daté et versionné (la preuve exigée
     par l'article 7.1 du RGPD) et se retire dans les Réglages. Changer
     LEGAL_VERSION réinterroge tout le monde. */

  var LEGAL_VERSION = 2;  // 2 : CGU v2 du 4 octobre 2026 (foyer partagé, inventaire en ligne)

  function aiConsented() {
    var c = state.consents && state.consents.ai;
    // En ligne, la version de la politique est vérifiée par le serveur.
    if (cloud) return !!(c && c.granted);
    return !!(c && c.granted && c.version === LEGAL_VERSION);
  }
  function aiConsentSet(granted) {
    if (!state.consents) state.consents = {};
    state.consents.ai = { granted: granted, at: new Date().toISOString(), version: LEGAL_VERSION };
    // En ligne, la preuve de l'accord est journalisée sur le serveur.
    if (cloud) cloud.consent(granted);
    save();
  }
  /* Lance `run` tout de suite si l'accord est déjà donné, sinon après lui.
     `run` part dans le clic de confirmation : un sélecteur de fichier peut
     encore s'y ouvrir. */
  function aiConsentThen(run) {
    if (aiConsented()) { run(); return; }
    var body = el("span", {}, [
      "Pour vous répondre, Fulmo envoie à son fournisseur d'IA, Anthropic, établi aux États-Unis, uniquement la phrase que vous tapez ou la photo que vous prenez. Votre inventaire, lui, n'est pas transmis. Évitez de photographier des personnes ou des documents. Vous pourrez retirer cet accord dans les Réglages. ",
      el("a", { href: siteUrl("confidentialite.html#ia"), target: "_blank", rel: "noopener", text: "En savoir plus" })
    ]);
    confirmSheet({
      title: "Utiliser l'IA ?",
      body: body,
      cancelLabel: "Pas maintenant",
      confirmLabel: "J'accepte",
      onConfirm: function () { aiConsentSet(true); run(); }
    });
  }

  /* Droit à l'effacement : seul le compte ouvert disparaît, avec ses relevés
     3D. Les autres comptes de l'appareil ne sont pas touchés. */
  function deleteAccount() {
    if (cloud) { cloudDeleteSheet(); return; }
    var who = state.account ? state.account.email : null;
    confirmSheet({
      title: "Supprimer votre compte ?",
      body: "Votre compte" + (who ? " (" + who + ")" : "") + ", votre logement, vos objets, vos photos et vos relevés 3D seront effacés de cet appareil, définitivement. Pensez à exporter vos données avant.",
      confirmLabel: "Supprimer mon compte",
      danger: true,
      onConfirm: function () {
        (state.scans || []).forEach(function (scan) { if (scan && scan.id) scanStore.del(scan.id); });
        if (who) {
          var map = accountsRead();
          delete map[accountKey(who)];
          accountsWrite(map);
        }
        var theme = state.theme;
        state = blank();
        state.theme = theme;
        // save() rangerait de nouveau le compte : on écrit l'état vide à la main.
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
        resetViews();
        obAuthView = "signup";
        closeSheet();
        render();
        window.scrollTo(0, 0);
        toast("Compte supprimé. Ses données ont été effacées de cet appareil.");
      }
    });
  }

  /* En ligne : l'effacement se fait sur le serveur, après le mot de passe
     (ré-authentification avant une action sensible). */
  function cloudDeleteSheet() {
    var password = "";
    var busy = false;
    var box, err;
    function fail(message) {
      busy = false;
      err.hidden = false;
      err.textContent = message;
      box.setAttribute("aria-invalid", "true");
      box.focus();
    }
    function commit() {
      if (busy) return;
      if (!password) { fail("Indiquez votre mot de passe."); return; }
      busy = true;
      cloud.deleteAccount(password).then(function (res) {
        if (res.ok) return;   // la page repart de l'inscription
        fail(res.error === "password" ? "Mot de passe incorrect." : res.error === "limite" ? "Trop de tentatives. Réessayez dans une minute." : "La suppression a échoué. Réessayez dans un instant.");
      });
    }
    sheet({
      title: "Supprimer votre compte ?",
      role: "alertdialog",
      body: [
        el("p", { class: "confirm-body", text: "Votre compte (" + (state.account ? state.account.email : "") + ") sera effacé de nos serveurs, définitivement. Un foyer que vous partagez passe à un autre membre ; un foyer dont vous êtes seul membre disparaît avec ses objets. Pensez à exporter vos données avant." }),
        el("label", { class: "field" }, [
          el("span", { text: "Votre mot de passe, pour confirmer" }),
          box = el("input", {
            class: "input", type: "password", autocomplete: "current-password", maxlength: 200,
            "aria-describedby": "del-pw-err",
            oninput: function (event) { password = event.target.value; err.hidden = true; box.removeAttribute("aria-invalid"); },
            onkeydown: function (event) { if (event.key === "Enter") { event.preventDefault(); commit(); } }
          }),
          err = el("span", { class: "err", id: "del-pw-err", role: "alert", hidden: true })
        ])
      ],
      foot: [
        el("button", { class: "btn btn-line", type: "button", onclick: function () { closeSheet(); } }, "Annuler"),
        el("button", { class: "btn btn-danger", type: "button", onclick: commit }, [icon("trash", 15), "Supprimer mon compte"])
      ],
      initialFocus: box
    });
  }

  /* Le reflet du bouton principal suit le pointeur. Un seul écouteur délégué,
     posé une fois : les boutons sont recréés à chaque rendu. */
  if (window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    document.addEventListener("pointermove", function (event) {
      var target = event.target && event.target.closest ? event.target.closest(".btn-volt") : null;
      if (!target) return;
      var box = target.getBoundingClientRect();
      target.style.setProperty("--mx", Math.round(event.clientX - box.left) + "px");
      target.style.setProperty("--my", Math.round(event.clientY - box.top) + "px");
    }, { passive: true });
  }

  /* Le chemin de rangement en fil d'Ariane : pièce › meuble › contenant, et
     l'endroit précis en volt. Les séparateurs sont dessinés, et redits en
     texte pour un lecteur d'écran. */
  function crumbs(locationId, spot) {
    var path = pathOf(locationId);
    if (!path.length) return el("div", { class: "crumbs" }, [el("span", { class: "unsorted", text: "À ranger" })]);
    function sep() {
      var svg = icon("chev");
      return el("span", { class: "sep" }, [svg, el("span", { class: "sr-only", text: " › " })]);
    }
    var parts = [];
    path.forEach(function (name, index) {
      if (index) parts.push(sep());
      parts.push(el("span", { class: index === path.length - 1 ? "leaf" : null, text: name }));
    });
    if (spot) { parts.push(sep()); parts.push(el("span", { class: "spot", text: spot })); }
    return el("div", { class: "crumbs", title: path.concat(spot ? [spot] : []).join(" › ") }, parts);
  }

  /* Illustration des états vides : la maison et la loupe, au trait du jeu
     d'icônes. */
  function emptyArt() {
    var wrap = el("span", { "aria-hidden": "true" });
    wrap.innerHTML = // html-sûr : SVG constant
      '<svg class="empty-art" viewBox="0 0 148 112" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path class="ground" d="M8 100h132"/>' +
      '<path stroke="currentColor" d="M24 100V54L58 26l34 28v46"/>' +
      '<path stroke="currentColor" d="M16 61 58 25l42 36"/>' +
      '<path stroke="currentColor" d="M50 100V82a8 8 0 0 1 16 0v18"/>' +
      '<rect stroke="currentColor" x="33" y="59" width="12" height="11" rx="2"/>' +
      '<circle class="lens" cx="100" cy="70" r="19"/>' +
      '<path stroke="currentColor" stroke-width="5" d="m114 84 13 13"/>' +
      '<path class="spark" d="M123 44l6-6M127 57h8M113 38v-8"/>' +
      '</svg>';
    return wrap;
  }

  /* ─── Modale générique ────────────────────────────────────────────── */

  var openSheet = null;

  function sheet(options) {
    // Le focus à rendre est celui d'AVANT la feuille précédente, s'il y en a
    // une : une feuille qui en remplace une autre ne doit pas rendre la main
    // à un bouton de la feuille disparue.
    var previous = openSheet ? openSheet.previous : document.activeElement;
    closeSheet(true);

    function dismiss() { closeSheet(); if (options.onClose) options.onClose(); }

    var grip = el("div", { class: "sheet-grip", "aria-hidden": "true" }, [el("i")]);
    var head = el("div", { class: "sheet-head" }, [
      el("h2", { class: "display t-md", text: options.title }),
      el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", onclick: dismiss }, [icon("x", 18)])
    ]);
    var body = el("div", { class: "sheet-body" }, options.body || []);
    var card = el("div", {
      class: "sheet" + (options.wide ? " sheet-wide" : ""),
      role: options.role || "dialog", "aria-modal": "true", "aria-label": options.title, tabindex: "-1"
    }, [
      grip,
      head,
      body,
      options.foot ? el("div", { class: "sheet-foot" }, options.foot) : null
    ]);

    var backdrop = el("div", {
      class: "sheet-backdrop",
      onclick: function (event) { if (event.target === backdrop) dismiss(); }
    }, [card]);

    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";
    openSheet = { backdrop: backdrop, onClose: options.onClose, previous: previous };

    /* Tirer vers le bas pour fermer (mobile). La poignée et l'en-tête
       servent de prise ; un geste court ou lent ramène la feuille en place. */
    (function () {
      var start = null;
      function down(event) {
        if (window.innerWidth >= 640 || event.button > 0) return;
        if (event.target.closest("button, input, a")) return;
        start = { y: event.clientY, t: Date.now(), dy: 0 };
        card.classList.add("is-dragging");
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
      }
      function move(event) {
        if (!start) return;
        start.dy = Math.max(0, event.clientY - start.y);
        card.style.transform = "translateY(" + start.dy + "px)";
      }
      function up() {
        if (!start) return;
        var dy = start.dy, speed = dy / Math.max(1, Date.now() - start.t);
        start = null;
        card.classList.remove("is-dragging");
        if (dy > 110 || (dy > 30 && speed > 0.6)) { dismiss(); return; }
        card.style.transition = "transform var(--dur-2) var(--ease-out)";
        card.style.transform = "";
        setTimeout(function () { card.style.transition = ""; }, 260);
      }
      [grip, head].forEach(function (zone) {
        zone.addEventListener("pointerdown", down);
        zone.addEventListener("pointermove", move);
        zone.addEventListener("pointerup", up);
        zone.addEventListener("pointercancel", up);
      });
    })();

    // Premier focus : ce que l'appelant désigne, sinon un champ marqué
    // `autofocus`, sinon la feuille elle-même — on n'ouvre pas le clavier d'un
    // téléphone sans raison.
    var first = options.initialFocus || card.querySelector("[autofocus]") || card;
    try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }

    // Échappement et piège de focus. La liste est relue à chaque tabulation :
    // le contenu d'une feuille change (filtre d'emplacements, erreurs).
    openSheet.onKey = function (event) {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
      if (event.key !== "Tab") return;
      var focusables = Array.prototype.filter.call(
        card.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])'),
        function (node) { return node.offsetParent !== null; }
      );
      if (focusables.length === 0) { event.preventDefault(); return; }
      var firstNode = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && (document.activeElement === firstNode || document.activeElement === card)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); firstNode.focus(); }
    };
    document.addEventListener("keydown", openSheet.onKey);
    return card;
  }

  /* `replacing` : une autre feuille prend la place, on ne rend ni le
     défilement ni le focus à la page. */
  function closeSheet(replacing) {
    if (!openSheet) return;
    var closing = openSheet;
    openSheet = null;
    document.removeEventListener("keydown", closing.onKey);
    var node = closing.backdrop;
    node.classList.add("is-closing");
    setTimeout(function () { node.remove(); }, 230);
    if (replacing === true) return;
    if (!cmdk) document.body.style.overflow = "";
    if (closing.previous && closing.previous.isConnected && closing.previous.focus) {
      try { closing.previous.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  /* ─── Sélecteur de meubles ────────────────────────────────────────────
     Une poignée d'exemples ne couvre pas un logement réel, et une liste de
     mots ne dit pas ce qui sépare une armoire d'un placard. Le catalogue
     entier est donc consultable, chaque entrée porte son dessin et sa
     phrase, et tout ce qui manque s'ajoute à la main. */

  /* Les rangements d'une pièce sont des ENTRÉES { id, key, base, label, icon }
     et non plus de simples noms : le même meuble peut revenir plusieurs fois
     (deux tables de chevet), chaque exemplaire est numéroté comme les pièces,
     et la croix retire CELUI-LÀ. `taken` : les noms déjà présents dans la
     pièce (côté application), pour continuer la numérotation. */
  function furnLabel(f) { return typeof f === "string" ? f : f.label; }

  function furnTaken(base, taken) {
    var pattern = new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "( \\d+)?$");
    return (taken || []).filter(function (name) { return pattern.test(name); }).length;
  }

  function furnAdd(room, entry, taken) {
    var base = entry.label;
    var count = room.furniture.filter(function (f) { return f && f.base === base; }).length + furnTaken(base, taken);
    var item = { id: uid("f"), key: entry.key || null, base: base, label: count ? base + " " + (count + 1) : base, icon: entry.pic || "f-autre" };
    room.furniture.push(item);
    return item;
  }

  function furnRemove(room, id, taken) {
    var gone = null;
    room.furniture = room.furniture.filter(function (f) {
      if (f && f.id === id) { gone = f; return false; }
      return true;
    });
    if (!gone || !gone.base) return gone;
    var offset = furnTaken(gone.base, taken);
    var same = room.furniture.filter(function (f) { return f && f.base === gone.base; });
    if (same.every(function (f) { return f.label.indexOf(gone.base) === 0; })) {
      same.forEach(function (f, i) { f.label = i === 0 && !offset ? gone.base : gone.base + " " + (i + 1 + offset); });
    }
    return gone;
  }

  /* Les icônes proposées pour un rangement saisi à la main. */
  var FURN_CUSTOM_PICS = ["f-autre", "f-etagere", "f-etagere-murale", "f-etageres-murales", "f-placard", "f-colonne",
    "f-placard-haut", "f-placard-bas", "f-armoire", "f-commode", "f-tiroirs", "f-niche", "f-caisse", "f-bac",
    "f-panier", "f-carton", "f-coffre", "f-penderie", "f-pateres", "f-casier"];

  function furniturePicker(room, onDone, locked) {
    var taken = locked || [];
    var query = "";
    var grid = el("div", { class: "fpick-grid" });
    var counter = el("p", { class: "label ob-fp-count", style: "color:var(--accent)" });

    function countKey(key) { return room.furniture.filter(function (f) { return f && f.key === key; }).length; }

    /* Toucher une carte AJOUTE un exemplaire ; le « − » en retire le dernier. */
    function cell(entry) {
      var n = countKey(entry.key);
      var here = furnTaken(entry.label, taken);
      var add = el("button", {
        class: "fpick-card" + (n ? " on" : ""), type: "button", "data-key": entry.key,
        "aria-label": "Ajouter : " + entry.label + (n ? " (" + n + " déjà)" : ""),
        onclick: function () {
          var item = furnAdd(room, entry, taken);
          paint(entry.key);
          obAnnounce(item.label + " ajouté.");
        }
      }, [
        el("span", { class: "box" }, [pic(entry.pic)]),
        el("span", { class: "nm", text: entry.label }),
        el("span", { class: "hint", text: here ? "Déjà " + here + " dans " + room.label + ". " + entry.hint : entry.hint }),
        n ? el("span", { class: "ob-fp-n tnum", "aria-hidden": "true", text: "×" + n }) : null
      ]);
      var less = n ? el("button", {
        class: "ob-fp-less", type: "button", "data-less": entry.key,
        "aria-label": "Retirer un exemplaire : " + entry.label, title: "Retirer un exemplaire",
        onclick: function () {
          var mine = room.furniture.filter(function (f) { return f && f.key === entry.key; });
          if (mine.length) furnRemove(room, mine[mine.length - 1].id, taken);
          paint(null, entry.key);
        }
      }, [icon("minus", 14)]) : null;
      return el("div", { class: "ob-fp-cell" }, [add, less]);
    }

    function paint(popKey, focusKey) {
      var q = norm(query);
      var matches = function (text) { return !!text && (!q || norm(text).indexOf(q) !== -1); };
      var cells = FURNITURE
        .filter(function (entry) { return !q || matches(entry.label) || matches(entry.hint) || matches(entry.kw); })
        .map(cell);
      grid.replaceChildren.apply(grid, cells.length ? cells : [
        el("p", { class: "loc-empty", text: "Aucun meuble ne correspond. Ajoutez-le ci-dessous." })
      ]);
      var names = room.furniture.map(furnLabel);
      counter.textContent = names.length === 0
        ? "Aucun meuble pour l'instant"
        : plural(names.length, "meuble ajouté", "meubles ajoutés") + " · " + names.join(", ");
      var key = popKey || focusKey;
      if (key) {
        var card = grid.querySelector('[data-key="' + key + '"]');
        if (card) {
          card.focus({ preventScroll: true });
          if (popKey) obPop(card.querySelector(".ob-fp-n"));
        }
      }
    }

    /* Un rangement saisi à la main : son icône est devinée d'après le nom
       pendant la frappe, et reste modifiable dans la rangée d'icônes avant
       l'ajout. Un choix explicite n'est plus écrasé par la devinette. */
    var custom = "";
    var customPic = "f-autre", picked = false;
    var addButton;
    var strip = el("div", {
      class: "ob-fp-icons", role: "radiogroup", "aria-label": "Icône du rangement à ajouter",
      onkeydown: function (event) {
        var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        var i = FURN_CUSTOM_PICS.indexOf(customPic);
        customPic = FURN_CUSTOM_PICS[(i + step + FURN_CUSTOM_PICS.length) % FURN_CUSTOM_PICS.length];
        picked = true;
        syncStrip(true);
      }
    });
    function syncStrip(focus) {
      Array.prototype.forEach.call(strip.children, function (b) {
        var on = b.getAttribute("data-pic") === customPic;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
    }
    FURN_CUSTOM_PICS.forEach(function (id) {
      strip.appendChild(el("button", {
        type: "button", role: "radio", "data-pic": id, "aria-label": id === "f-autre" ? "Générique" : iconName(id), title: id === "f-autre" ? "Générique" : iconName(id),
        onclick: function () { customPic = id; picked = true; syncStrip(false); }
      }, [pic(id)]));
    });
    syncStrip(false);

    function addCustom() {
      var label = custom.trim().slice(0, 80);
      if (!label) return;
      furnAdd(room, { key: null, label: label, pic: customPic }, taken);
      custom = ""; customPic = "f-autre"; picked = false;
      customInput.value = "";
      addButton.disabled = true;
      syncStrip(false);
      paint();
      obAnnounce(label + " ajouté.");
      customInput.focus();
    }

    var customInput = el("input", {
      class: "input", style: "flex:1;min-width:180px", maxlength: 80,
      placeholder: "Autre meuble : « Malle du grenier », « Bac à jouets »…",
      "aria-label": "Ajouter un meuble qui n'est pas dans la liste",
      oninput: function (event) {
        custom = event.target.value;
        addButton.disabled = !custom.trim();
        if (!picked) { customPic = furnitureGuessPic(custom); syncStrip(false); }
      },
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
            class: "input", type: "search", placeholder: "Rechercher un meuble… (télé, chaussures, étagère)",
            "aria-label": "Rechercher un meuble",
            oninput: function (event) { query = event.target.value; paint(); }
          })
        ]),
        el("p", { class: "ob-fp-tip", text: "Touchez une carte pour l'ajouter, plusieurs fois pour plusieurs exemplaires." }),
        grid,
        el("div", { class: "stack-sm" }, [
          el("p", { class: "label", text: "Il manque quelque chose ?" }),
          el("div", { class: "inline" }, [customInput, addButton]),
          el("p", { class: "ob-fp-tip", text: "Icône : devinée d'après le nom, modifiable." }),
          strip
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
            class: on ? "on" : null, type: "button", "aria-label": iconName(name), title: iconName(name),
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
      keys: "reglages parametres foyer membres abonnement export", run: function () { goTab("settings"); } },
    { label: "Visite guidée", hint: "Les menus pas à pas, puis un premier objet", ic: "spark",
      keys: "visite guidee didacticiel tutoriel aide decouvrir prise en main", run: function () { tourStart(); } },
    { label: "Basculer le thème clair / sombre", hint: "Le clair pour le plein jour, le sombre pour le soir", ic: "moon",
      keys: "theme sombre clair nuit jour apparence", run: function () { toggleTheme(); } }
  ];

  function goTab(id) { closePalette(); state.tab = id; save(); render(); }

  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme(); save(); render();
    toast(state.theme === "dark" ? "Thème sombre." : "Thème clair.");
  }

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
    // Une action dont le NOM commence par la frappe passe devant : « visite »
    // doit ouvrir la visite guidée, pas la boîte de vis trouvée par approximation.
    if (acts.length) {
      var named = acts.some(function (a) { return norm(a.label).indexOf(norm(q)) === 0; });
      groups[named ? "unshift" : "push"]({ title: "Actions", rows: acts.map(actionRow) });
    }

    return groups;

    function itemRow(row) {
      var item = row.item || row;
      var path = pathOf(item.locationId);
      return {
        art: rootIconOf(item.locationId),
        name: item.name + (item.quantity > 1 ? "  ×" + item.quantity : ""),
        sub: path.length ? path.join(" / ") : "À ranger",
        crumbsOf: item.locationId || "",
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

    cmdk = { backdrop: backdrop, input: input, list: list, filters: filters, index: 0, rows: [], tag: null, panel: panel, previous: document.activeElement };

    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";
    cmdk.onKey = paletteKey;
    document.addEventListener("keydown", cmdk.onKey);

    paint();
    input.focus();
  }

  function closePalette() {
    if (!cmdk) return;
    var closing = cmdk;
    cmdk = null;
    document.removeEventListener("keydown", closing.onKey);
    closing.backdrop.remove();
    if (!openSheet) document.body.style.overflow = "";
    if (closing.previous && closing.previous.isConnected && closing.previous.focus) {
      try { closing.previous.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  /* Une ligne ferme la palette AVANT d'agir : sinon la feuille d'objet ou
     l'onglet demandé s'ouvraient sous la palette, qui restait au-dessus. */
  function runRow(row) {
    closePalette();
    row.run();
  }

  function paletteKey(event) {
    if (!cmdk) return;
    if (event.key === "Escape") { event.preventDefault(); closePalette(); return; }
    // Piège de focus : la palette est modale.
    if (event.key === "Tab") {
      var focusables = cmdk.panel.querySelectorAll("input, button");
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    // Entrée sur un bouton (puce, fermer) appartient à ce bouton.
    if (event.key === "Enter" && document.activeElement !== cmdk.input) return;
    if (cmdk.rows.length === 0) return;
    event.preventDefault();
    if (event.key === "Enter") { runRow(cmdk.rows[cmdk.index]); return; }
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
          onclick: function () { runRow(row); }
        }, [
          el("span", { class: "fig" }, [row.icon ? icon(row.icon, 17) : sym(row.art, 19)]),
          el("span", { class: "txt" }, [
            el("span", { class: "nm" }, [markMatch(row.name, cmdk.tag ? "" : query)]),
            row.crumbsOf !== undefined
              ? crumbs(row.crumbsOf || null, row.spot)
              : el("span", { class: "sub" + (row.icon ? " hint" : " path") }, [row.sub])
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

  /* Une ligne, discrète : c'est la démo, et le vrai compte est ailleurs. Que les données
     restent dans ce navigateur est dit là où cela compte (connexion,
     inscription, Réglages), et l'effacement complet vit dans les Réglages :
     un bouton « tout effacer » n'a pas sa place en haut de chaque écran. Sur
     les écrans de nuit (inscription, onboarding), elle prend la nuit elle
     aussi. */
  function demoBar() {
    if (cloud) return null;   // le vrai compte n'est pas une démonstration
    var night = !state.account || !state.household || !state.session;
    return el("div", { class: "demo-bar" + (night ? " night" : "") }, [
      el("span", { class: "demo-dot", "aria-hidden": "true" }),
      el("span", { class: "demo-text" }, [
        el("strong", { text: "Démo" }),
        el("span", { class: "demo-long", text: " · données gardées dans ce navigateur · " }),
        el("span", { class: "demo-short", text: " · " }),
        // Le vrai compte : inventaire en ligne, sur tous les appareils et partagé avec le foyer.
        el("a", { class: "demo-link", href: "https://app.getfulmo.com/inscription", text: "Compte synchronisé et partagé" })
      ])
    ]);
  }

  /* Ce que l'application garde en mémoire vive pour le compte ouvert :
     à oublier dès qu'on change de compte. */
  function resetViews() {
    // Une visite en cours ne survit pas à un changement de compte.
    if (tour) tourEnd(true);
    clearTimeout(tourPending);
    tourPending = null;
    closePalette();
    dropScene();
    searchState = { query: "", ai: null, aiBusy: false, aiTried: null, filter: null };
    aiResults = null;
    review = null; placingId = null; spaceFocus = null; spaceRoomId = null; mapFocus = null;
  }

  function confirmReset() {
    confirmSheet({
      title: "Tout effacer sur ce navigateur ?",
      body: "Tous les comptes de ce navigateur, avec leurs logements, objets, relevés et historiques, seront effacés, et vous repartirez de l'inscription.",
      confirmLabel: "Tout effacer",
      danger: true,
      onConfirm: function () {
        state = blank();
        try { localStorage.removeItem(ACCOUNTS_KEY); } catch (e) {}
        resetViews();
        applyTheme(); save(); render();
        toast("Tout a été effacé de ce navigateur.");
      }
    });
  }

  /* ═══ Inscription et onboarding — outillage partagé ═════════════════

     Tout ce qui suit est préfixé `ob` et ne sert qu'aux écrans de nuit :
     création de compte, choix de formule, configuration du logement.

     Une contrainte gouverne tout le reste : render() reconstruit le DOM
     entier, ce qui coupe net une animation en cours. Les interactions de
     sélection (tuiles, compteurs, panier) mettent donc la page à jour EN
     PLACE ; seuls les changements d'étape repassent par render(), sous une
     View Transition quand le navigateur la connaît. */

  var OB_CALM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var OB_FINE = window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)") : null;
  function obCalm() { return !!(OB_CALM && OB_CALM.matches); }
  function obFine() { return !!(OB_FINE && OB_FINE.matches); }

  function obSvg(tag, attrs, children) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      if (attrs[key] != null) node.setAttribute(key, String(attrs[key]));
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  /* Les couleurs du canvas viennent des jetons : le canvas ne lit pas le CSS,
     on les résout donc une fois, avec une valeur de secours. */
  function obColor(name, fallback) {
    var value = "";
    try { value = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) {}
    var match = /^#([0-9a-f]{6})$/i.exec(value) || /^#([0-9a-f]{6})$/i.exec(fallback);
    var n = parseInt(match[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function obRgba(c, a) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }

  function obFirstName(full) { return String(full || "").trim().split(/\s+/)[0] || ""; }

  /* Annonces pour les lecteurs d'écran. Le nœud vit hors de #root : recréé à
     chaque rendu, il ne serait jamais lu. */
  var obLive = null;
  function obAnnounce(text) {
    if (!obLive) {
      obLive = el("div", { class: "ob-sr", role: "status", "aria-live": "polite" });
      document.body.appendChild(obLive);
    }
    obLive.textContent = "";
    setTimeout(function () { obLive.textContent = text; }, 60);
  }

  /* ─── Le pointeur ─────────────────────────────────────────────────── */

  var obPointer = { x: -9999, y: -9999, on: false };
  window.addEventListener("pointermove", function (event) {
    if (event.pointerType !== "mouse") return;
    obPointer.x = event.clientX; obPointer.y = event.clientY; obPointer.on = true;
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", function () { obPointer.on = false; });

  /* ─── Fond vivant : une constellation volt et arc ─────────────────────
     Un seul canvas, créé une fois et réinséré à chaque rendu : il garde son
     état et sa boucle. La boucle s'arrête d'elle-même dès que le canvas
     quitte la page (entrée dans l'application) ou que l'onglet est caché. */

  var obBg = { node: null, ctx: null, pts: [], raf: 0, w: 0, h: 0, dpr: 1, mx: -9999, my: -9999, volt: null, arc: null };

  function obBackdrop() {
    if (!obBg.node) {
      obBg.node = el("canvas", { class: "ob-bg", "aria-hidden": "true" });
      obBg.ctx = obBg.node.getContext("2d");
      obBg.volt = obColor("--volt", "#d9ff3d");
      obBg.arc = obColor("--arc-hi", "#a79dff");
    }
    requestAnimationFrame(obBgStart);
    return obBg.node;
  }

  function obBgResize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth, h = window.innerHeight;
    if (w === obBg.w && h === obBg.h && dpr === obBg.dpr) return;
    var grew = !obBg.pts.length || w * h > obBg.w * obBg.h * 1.3;
    obBg.w = w; obBg.h = h; obBg.dpr = dpr;
    obBg.node.width = Math.round(w * dpr);
    obBg.node.height = Math.round(h * dpr);
    if (!grew) return;
    var count = Math.max(26, Math.min(96, Math.round(w * h / 15000)));
    obBg.pts = [];
    for (var i = 0; i < count; i++) {
      obBg.pts.push({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.14, vy: (Math.random() - 0.5) * 0.14,
        r: Math.random() * 1.2 + 0.5, arc: Math.random() < 0.24, tw: Math.random() * 6.3
      });
    }
  }

  function obBgStart() {
    if (!obBg.node || !obBg.node.isConnected) return;
    obBgResize();
    if (obCalm()) { obBgDraw(0, true); return; }
    if (!obBg.raf && !document.hidden) obBg.raf = requestAnimationFrame(obBgTick);
  }

  function obBgTick(time) {
    obBg.raf = 0;
    if (!obBg.node || !obBg.node.isConnected || document.hidden || obCalm()) return;
    obBgDraw(time, false);
    obParallax();
    obBg.raf = requestAnimationFrame(obBgTick);
  }

  function obBgDraw(time, still) {
    var ctx = obBg.ctx, w = obBg.w, h = obBg.h, pts = obBg.pts;
    var volt = obBg.volt, arc = obBg.arc, reach = 150, link = 128;
    ctx.setTransform(obBg.dpr, 0, 0, obBg.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var live = obPointer.on && obFine() && !still;
    if (live) {
      obBg.mx += (obPointer.x - obBg.mx) * (obBg.mx < -9000 ? 1 : 0.12);
      obBg.my += (obPointer.y - obBg.my) * (obBg.my < -9000 ? 1 : 0.12);
      // Le halo qui suit la souris : une lampe de poche, pas un projecteur.
      var glow = ctx.createRadialGradient(obBg.mx, obBg.my, 0, obBg.mx, obBg.my, 360);
      glow.addColorStop(0, obRgba(volt, 0.07));
      glow.addColorStop(0.5, obRgba(arc, 0.03));
      glow.addColorStop(1, obRgba(arc, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(obBg.mx - 360, obBg.my - 360, 720, 720);
    }

    var i, j, p, q, dx, dy, d;
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (!still) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -10) p.x = w + 10; else if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10; else if (p.y > h + 10) p.y = -10;
        if (live) {
          dx = p.x - obBg.mx; dy = p.y - obBg.my; d = Math.sqrt(dx * dx + dy * dy);
          if (d < reach && d > 0.5) { var push = (1 - d / reach) * 0.55; p.x += dx / d * push; p.y += dy / d * push; }
        }
      }
    }

    ctx.lineWidth = 1;
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      for (j = i + 1; j < pts.length; j++) {
        q = pts[j];
        dx = p.x - q.x; dy = p.y - q.y;
        if (dx > link || dx < -link || dy > link || dy < -link) continue;
        d = Math.sqrt(dx * dx + dy * dy);
        if (d >= link) continue;
        ctx.strokeStyle = obRgba(p.arc && q.arc ? arc : volt, (1 - d / link) * 0.1);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      if (live) {
        dx = p.x - obBg.mx; dy = p.y - obBg.my; d = Math.sqrt(dx * dx + dy * dy);
        if (d < reach * 1.25) {
          ctx.strokeStyle = obRgba(volt, (1 - d / (reach * 1.25)) * 0.28);
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(obBg.mx, obBg.my); ctx.stroke();
        }
      }
    }

    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      var a = still ? 0.45 : 0.36 + Math.sin(time * 0.0012 + p.tw) * 0.2;
      ctx.fillStyle = obRgba(p.arc ? arc : volt, a);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
    }
  }

  document.addEventListener("visibilitychange", function () { if (!document.hidden) obBgStart(); });
  window.addEventListener("resize", function () { if (obBg.node && obBg.node.isConnected) { obBgResize(); if (obCalm()) obBgDraw(0, true); } });
  if (OB_CALM && OB_CALM.addEventListener) OB_CALM.addEventListener("change", obBgStart);

  /* La maquette du logement pivote très légèrement avec la souris : on la
     regarde de là où l'on est. Lissé, borné à quelques degrés. */
  var obPar = { x: 0, y: 0 };
  function obParallax() {
    var models = document.querySelectorAll(".ob-side .ob-model");
    if (!models.length) return;
    var tx = 0, ty = 0;
    if (obPointer.on && obFine()) {
      tx = (obPointer.x / window.innerWidth - 0.5) * 2;
      ty = (obPointer.y / window.innerHeight - 0.5) * 2;
    }
    obPar.x += (tx - obPar.x) * 0.06;
    obPar.y += (ty - obPar.y) * 0.06;
    for (var i = 0; i < models.length; i++) {
      models[i].style.transform = "rotateX(" + (-obPar.y * 5).toFixed(2) + "deg) rotateY(" + (obPar.x * 7).toFixed(2) + "deg)";
    }
  }

  /* ─── Étincelles ──────────────────────────────────────────────────────
     Un calque fixe au-dessus de tout, hors de #root : la gerbe continue
     pendant le changement d'étape au lieu d'être coupée par le rendu. */

  var obFx = { node: null, ctx: null, parts: [], raf: 0, last: 0, dpr: 1 };

  function obFxEnsure() {
    if (!obFx.node) {
      obFx.node = el("canvas", { class: "ob-fx", "aria-hidden": "true" });
      obFx.ctx = obFx.node.getContext("2d");
      obFx.volt = obColor("--volt", "#d9ff3d");
      obFx.hi = obColor("--volt-hi", "#eaff8a");
      obFx.arc = obColor("--arc-hi", "#a79dff");
      obFx.linen = obColor("--linen", "#ece4d6");
    }
    if (!obFx.node.isConnected) document.body.appendChild(obFx.node);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (obFx.node.width !== Math.round(window.innerWidth * dpr) || obFx.node.height !== Math.round(window.innerHeight * dpr)) {
      obFx.dpr = dpr;
      obFx.node.width = Math.round(window.innerWidth * dpr);
      obFx.node.height = Math.round(window.innerHeight * dpr);
    }
  }

  /* opts : count, power, up (biais vers le haut), confetti. */
  function obSpark(x, y, opts) {
    if (obCalm()) return;
    opts = opts || {};
    obFxEnsure();
    var count = opts.count || 18, power = opts.power || 5;
    for (var i = 0; i < count; i++) {
      var angle = opts.up ? -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1 : Math.random() * Math.PI * 2;
      var speed = power * (0.35 + Math.random() * 0.85);
      var confetti = opts.confetti && Math.random() < 0.55;
      obFx.parts.push({
        x: x, y: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: 0, max: confetti ? 1300 + Math.random() * 900 : 380 + Math.random() * 460,
        confetti: confetti, rot: Math.random() * 6.3, spin: (Math.random() - 0.5) * 0.3,
        size: confetti ? 3 + Math.random() * 3.5 : 1 + Math.random() * 1.2,
        tone: Math.random()
      });
    }
    if (!obFx.raf) { obFx.last = 0; obFx.raf = requestAnimationFrame(obFxTick); }
  }

  function obBurstFrom(node, event, opts) {
    var rect = node.getBoundingClientRect();
    var x = event && event.clientX ? event.clientX : rect.left + rect.width / 2;
    var y = event && event.clientY ? event.clientY : rect.top + rect.height / 2;
    obSpark(x, y, opts);
  }

  function obFxTick(time) {
    var dt = obFx.last ? Math.min(40, time - obFx.last) : 16;
    obFx.last = time;
    var ctx = obFx.ctx;
    ctx.setTransform(obFx.dpr, 0, 0, obFx.dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    var k = dt / 16;
    obFx.parts = obFx.parts.filter(function (p) { p.life += dt; return p.life < p.max; });
    obFx.parts.forEach(function (p) {
      var t = p.life / p.max, fade = 1 - t * t;
      if (p.confetti) {
        p.vx *= Math.pow(0.97, k); p.vy = p.vy * Math.pow(0.97, k) + 0.09 * k; p.rot += p.spin * k;
        p.x += p.vx * k; p.y += p.vy * k;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = fade;
        ctx.fillStyle = obRgba(p.tone < 0.55 ? obFx.volt : p.tone < 0.8 ? obFx.linen : obFx.arc, 1);
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      } else {
        p.vx *= Math.pow(0.9, k); p.vy = p.vy * Math.pow(0.9, k) + 0.05 * k;
        p.x += p.vx * k; p.y += p.vy * k;
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = obRgba(p.tone < 0.7 ? obFx.volt : p.tone < 0.9 ? obFx.hi : obFx.arc, fade);
        ctx.lineWidth = p.size; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2.6, p.y - p.vy * 2.6); ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
      }
    });
    ctx.globalAlpha = 1;
    if (obFx.parts.length) obFx.raf = requestAnimationFrame(obFxTick);
    else { obFx.raf = 0; ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
  }

  /* ─── Tilt 3D et reflet ───────────────────────────────────────────────
     Réservés au pointeur fin : au doigt, une carte qui penche sous le pouce
     ne fait que gêner la lecture. */

  function obTilt(node, max) {
    if (!obFine() || obCalm()) return node;
    node.classList.add("ob-tilt");
    node.addEventListener("pointermove", function (event) {
      var rect = node.getBoundingClientRect();
      var px = (event.clientX - rect.left) / rect.width, py = (event.clientY - rect.top) / rect.height;
      node.style.setProperty("--rx", ((0.5 - py) * max).toFixed(2) + "deg");
      node.style.setProperty("--ry", ((px - 0.5) * max).toFixed(2) + "deg");
      node.style.setProperty("--gx", (px * 100).toFixed(1) + "%");
      node.style.setProperty("--gy", (py * 100).toFixed(1) + "%");
    });
    node.addEventListener("pointerleave", function () {
      node.style.setProperty("--rx", "0deg");
      node.style.setProperty("--ry", "0deg");
    });
    return node;
  }

  /* Le reflet qui suit le pointeur sur le bouton principal. */
  function obGloss(node) {
    if (!obFine()) return node;
    node.addEventListener("pointermove", function (event) {
      var rect = node.getBoundingClientRect();
      node.style.setProperty("--gx", ((event.clientX - rect.left) / rect.width * 100).toFixed(1) + "%");
      node.style.setProperty("--gy", ((event.clientY - rect.top) / rect.height * 100).toFixed(1) + "%");
    });
    return node;
  }

  /* La coche qui se dessine : un tracé normalisé (pathLength = 1) dont le
     CSS anime le stroke-dashoffset quand la sélection change EN PLACE. */
  function obCheck(size) {
    return obSvg("svg", { class: "ob-check", viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", focusable: "false" }, [
      obSvg("path", { d: "M5 12.6l4.4 4.3L19 7.4", pathLength: "1" })
    ]);
  }

  /* Bouton principal : pilule volt, reflet, état de chargement. */
  function obCta(label, attrs, iconName) {
    var node = el("button", Object.assign({ class: "ob-cta", type: "button" }, attrs || {}), [
      el("span", { class: "ob-cta-label", text: label }),
      iconName === null ? null : icon(iconName || "arrow-right", 17),
      el("span", { class: "ob-spin", "aria-hidden": "true" })
    ]);
    return obGloss(node);
  }

  /* Vol d'un élément vers sa destination (FLIP) : la pièce touchée rejoint
     le panier. Un fantôme en position fixe, un arc, puis il se dissout. */
  function obFly(from, to) {
    if (obCalm() || !from || !to) return;
    var a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    if (!a.width || !b.width) return;
    var ghost = from.cloneNode(true);
    ghost.classList.add("ob-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.left = a.left + "px"; ghost.style.top = a.top + "px";
    ghost.style.width = a.width + "px"; ghost.style.height = a.height + "px";
    document.body.appendChild(ghost);
    var dx = b.left + b.width / 2 - (a.left + a.width / 2);
    var dy = b.top + b.height / 2 - (a.top + a.height / 2);
    var lift = Math.min(120, Math.abs(dx) * 0.25 + 40);
    if (!ghost.animate) { ghost.remove(); return; }
    var run = ghost.animate([
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: "translate(" + (dx * 0.5) + "px," + (dy * 0.5 - lift) + "px) scale(1.15)", opacity: 1, offset: 0.45 },
      { transform: "translate(" + dx + "px," + dy + "px) scale(.5)", opacity: 0 }
    ], { duration: 560, easing: "cubic-bezier(.45,0,.25,1)" });
    run.onfinish = function () { ghost.remove(); };
  }

  function obInView(node) {
    if (!node) return false;
    var r = node.getBoundingClientRect();
    return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
  }

  function obPop(node) {
    if (!node) return;
    node.classList.remove("ob-bump");
    void node.offsetWidth;
    node.classList.add("ob-bump");
  }

  /* ─── Transitions d'étape ─────────────────────────────────────────────
     View Transitions quand elles existent : l'ancienne étape glisse et
     s'efface pendant que la nouvelle arrive, dans le sens du parcours.
     Sinon, la nouvelle étape joue seule son entrée. */

  var obEnter = null;       // sens d'entrée à jouer au prochain rendu (repli)
  var obKeys = null;        // actions clavier de l'étape affichée

  function obTransition(mutate, dir) {
    document.documentElement.setAttribute("data-ob-dir", dir || "fwd");
    function run() {
      mutate();
      render();
      window.scrollTo(0, 0);
      obSettle();
    }
    if (document.startViewTransition && !obCalm()) {
      try { document.startViewTransition(run); return; } catch (e) {}
    }
    obEnter = obCalm() ? null : (dir || "fwd");
    run();
  }

  /* Après un changement d'étape : le focus va au champ désigné ou au titre,
     et l'étape est annoncée. */
  function obSettle() {
    var target = document.querySelector(".ob [data-ob-focus]") || document.getElementById("ob-step-title");
    if (target) {
      var isField = target.tagName === "INPUT";
      if (!isField || obFine()) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } }
      else { var title = document.getElementById("ob-step-title"); if (title) title.focus({ preventScroll: true }); }
    }
    var count = document.querySelector(".ob-count");
    var heading = document.getElementById("ob-step-title");
    if (heading) obAnnounce((count ? count.textContent + " : " : "") + heading.textContent);
  }

  /* Échap revient en arrière, Entrée continue. Branché une fois ; chaque
     étape déclare ses actions dans obKeys. */
  document.addEventListener("keydown", function (event) {
    if (!obKeys || openSheet || event.defaultPrevented || event.isComposing) return;
    if (!document.querySelector(".ob") || document.querySelector(".cmdk-backdrop, .ob-celebrate")) return;
    var target = event.target || {};
    var tag = target.tagName;
    if (event.key === "Escape") {
      // Dans un champ rempli, Échap sort du champ ; il ne jette pas l'étape.
      if ((tag === "INPUT" || tag === "TEXTAREA") && target.value) { target.blur(); return; }
      if (obKeys.back) { event.preventDefault(); obKeys.back(); }
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (target.getAttribute && target.getAttribute("data-ob-own-enter")) return;
    if (obKeys.primary) { event.preventDefault(); obKeys.primary(); }
  });

  /* ─── La maquette du logement ─────────────────────────────────────────
     Une axonométrie en SVG : chaque niveau est une dalle, chaque pièce un
     sol de matière avec deux murs bas, en coupe comme une maison de poupée.
     Les niveaux sont éclatés vers le haut — c'est le langage du plan par
     niveaux de l'application. Les pièces ajoutées tombent à leur place ;
     celles déjà vues restent immobiles d'un rendu à l'autre (obSeen). */

  var obSeen = Object.create(null);
  function obFresh(key) { var fresh = !obSeen[key]; obSeen[key] = true; return fresh; }

  var OB_U = 30, OB_K = 0.8660254;
  var OB_MAT = {
    cuisine: "clay", salon: "oak", chambre: "linen", sdb: "sage", entree: "dusk", bureau: "oak",
    enfant: "dusk", sam: "oak", wc: "sage", buanderie: "linen", dressing: "linen", cellier: "clay",
    garage: "clay", cave: "clay", grenier: "oak", cabanon: "oak", atelier: "clay", jardin: "sage",
    terrasse: "sage", balcon: "sage", couloir: "linen", veranda: "sage", debarras: "clay", soussol: "clay"
  };
  var OB_TYPE_LABEL = { apartment: "Appartement", house: "Maison", studio: "Studio", other: "Logement" };

  /* Cellules remplies par « coquilles » carrées : la position d'une pièce ne
     dépend que de son rang, jamais de la taille de la grille. Ajouter une
     pièce agrandit la dalle sans déplacer celles qui y sont déjà. */
  function obCell(k) {
    var s = Math.floor(Math.sqrt(k)), r = k - s * s;
    return r <= s ? [s, r] : [r - s - 1, s];
  }

  function obPt(x, y, z) {
    return ((x - y) * OB_U * OB_K).toFixed(1) + "," + ((x + y) * OB_U * 0.5 - z * OB_U).toFixed(1);
  }
  function obFace(points, cls) {
    return obSvg("polygon", { class: cls, points: points.map(function (p) { return obPt(p[0], p[1], p[2]); }).join(" ") });
  }

  /* Les niveaux affichés, du plus bas au plus haut : -1 (sous-sol), 0 (RDC),
     1, 2… `data.levels` quand l'onboarding les connaît ; sinon le nombre de
     niveaux, complété par ceux qu'occupent réellement les pièces. */
  function obFloorList(data) {
    if (data.levels && data.levels.length) return data.levels.slice();
    var list = [];
    for (var i = 0; i < Math.max(1, Math.min(8, data.floors || 1)); i++) list.push(i);
    (data.rooms || []).forEach(function (r) {
      if (typeof r.floor === "number" && list.indexOf(r.floor) === -1) list.push(r.floor);
    });
    return list.sort(function (a, b) { return a - b; });
  }

  /* Chaque pièce sur SON niveau (`room.floor`), dans l'ordre d'ajout : rien
     d'aléatoire, et une pièce ne change de niveau que si on l'y déplace. */
  function obLevels(rooms, list) {
    var levels = list.map(function () { return []; });
    var ground = Math.max(0, list.indexOf(0));
    rooms.forEach(function (room) {
      var i = list.indexOf(typeof room.floor === "number" ? room.floor : 0);
      levels[i < 0 ? ground : i].push(room);
    });
    return levels;
  }

  function obFloorTag(f) { return f < 0 ? "−" + Math.abs(f) : f === 0 ? "RDC" : "N" + f; }

  function obModel(data, opts) {
    opts = opts || {};
    var rooms = data.rooms || [];
    var floorList = obFloorList(data);
    var levels = obLevels(rooms, floorList);
    var most = 0;
    levels.forEach(function (level) { most = Math.max(most, level.length); });
    var G = Math.max(2, Math.ceil(Math.sqrt(most)));
    var F = levels.length;
    var LH = G * 0.64 + 0.62, FT = 0.07, WH = 0.44, SLAB = 0.14, GAP = 0.08, PAD = 0.1;

    var svg = obSvg("svg", {
      class: "ob-model-svg", role: "img", focusable: "false",
      "aria-label": "Aperçu de " + (data.name || "votre logement") + " : " + plural(rooms.length, "pièce", "pièces") + (F > 1 ? " sur " + F + " niveaux" : "")
    });

    var shadowId = uid("ob-shadow");
    svg.appendChild(obSvg("defs", {}, [
      obSvg("radialGradient", { id: shadowId }, [
        obSvg("stop", { offset: "0", "stop-color": "#000", "stop-opacity": ".55" }),
        obSvg("stop", { offset: "1", "stop-color": "#000", "stop-opacity": "0" })
      ])
    ]));
    var ground = (G + PAD) * OB_U;
    svg.appendChild(obSvg("ellipse", { cx: 0, cy: ground * 0.5 + SLAB * OB_U + 8, rx: ground * OB_K * 1.35, ry: ground * 0.42, fill: "url(#" + shadowId + ")" }));

    var freshIndex = 0;
    levels.forEach(function (list, L) {
      var z0 = L * LH;
      var zs = z0 - FT;
      var level = obSvg("g", {
        class: "ob-m-level" + (opts.levelNew === floorList[L] ? " is-new" : "") + (floorList[L] < 0 ? " is-under" : "") +
          (F > 1 && opts.activeFloor === floorList[L] ? " is-active" : ""),
        style: "--i:" + L, "data-floor": floorList[L]
      });
      var a = -PAD, b = G + PAD;
      level.appendChild(obFace([[a, a, zs], [b, a, zs], [b, b, zs], [a, b, zs]], "ob-m-slab"));
      level.appendChild(obFace([[a, b, zs], [b, b, zs], [b, b, zs - SLAB], [a, b, zs - SLAB]], "ob-m-slab-a"));
      level.appendChild(obFace([[b, a, zs], [b, b, zs], [b, b, zs - SLAB], [b, a, zs - SLAB]], "ob-m-slab-b"));

      for (var k = list.length; k < G * G; k++) {
        var c = obCell(k);
        level.appendChild(obFace([
          [c[0] + GAP, c[1] + GAP, zs], [c[0] + 1 - GAP, c[1] + GAP, zs],
          [c[0] + 1 - GAP, c[1] + 1 - GAP, zs], [c[0] + GAP, c[1] + 1 - GAP, zs]
        ], "ob-m-ghost"));
      }

      var placed = list.map(function (room, index) { return { room: room, cell: obCell(index) }; });
      placed.sort(function (p, q) { return (p.cell[0] + p.cell[1]) - (q.cell[0] + q.cell[1]) || p.cell[0] - q.cell[0]; });

      var labels = [];
      placed.forEach(function (entry) {
        var room = entry.room, cx = entry.cell[0], cy = entry.cell[1];
        var x0 = cx + GAP, x1 = cx + 1 - GAP, y0 = cy + GAP, y1 = cy + 1 - GAP;
        var fresh = obFresh("pm:" + room.id) && !opts.noDrop;
        var mat = OB_MAT[room.key] || ["linen", "oak", "sage", "clay", "dusk"][(room.label || "").length % 5];
        var group = obSvg("g", {
          class: "ob-m-room" + (fresh ? " is-new" : "") + (opts.focus === room.id ? " is-focus" : ""),
          "data-room": room.id,
          style: "--m:var(--" + mat + ");--d:" + (fresh ? Math.min(600, (freshIndex++) * 90) : 0) + "ms;--i:" + (L * 9 + cx + cy)
        });
        var title = obSvg("title");
        title.textContent = room.label;
        group.appendChild(title);
        group.appendChild(obFace([[x0, y0, z0], [x0, y1, z0], [x0, y1, z0 + WH], [x0, y0, z0 + WH]], "ob-m-wl"));
        group.appendChild(obFace([[x0, y0, z0], [x1, y0, z0], [x1, y0, z0 + WH], [x0, y0, z0 + WH]], "ob-m-wr"));
        group.appendChild(obFace([[x0, y1, z0], [x1, y1, z0], [x1, y1, z0 - FT], [x0, y1, z0 - FT]], "ob-m-sa"));
        group.appendChild(obFace([[x1, y0, z0], [x1, y1, z0], [x1, y1, z0 - FT], [x1, y0, z0 - FT]], "ob-m-sb"));
        group.appendChild(obFace([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], "ob-m-top"));
        group.appendChild(obFace([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], "ob-m-hl"));

        // Les rangements : de petits volumes posés contre les murs.
        (room.furniture || []).slice(0, 5).forEach(function (f, n) {
          var name = furnLabel(f);
          var s = 0.17, h = 0.16 + ((name.length * 7) % 5) * 0.045;
          var fx = n < 3 ? x0 + 0.07 + n * 0.24 : x0 + 0.05;
          var fy = n < 3 ? y0 + 0.05 : y0 + 0.31 + (n - 3) * 0.24;
          var box = obSvg("g", { class: "ob-m-box" + (obFresh("pf:" + room.id + ":" + name) && !fresh && !opts.noDrop ? " is-new" : "") });
          box.appendChild(obFace([[fx, fy + s, z0], [fx + s, fy + s, z0], [fx + s, fy + s, z0 + h], [fx, fy + s, z0 + h]], "ob-m-box-a"));
          box.appendChild(obFace([[fx + s, fy, z0], [fx + s, fy + s, z0], [fx + s, fy + s, z0 + h], [fx + s, fy, z0 + h]], "ob-m-box-b"));
          box.appendChild(obFace([[fx, fy, z0 + h], [fx + s, fy, z0 + h], [fx + s, fy + s, z0 + h], [fx, fy + s, z0 + h]], "ob-m-box-t"));
          group.appendChild(box);
        });
        level.appendChild(group);

        if (opts.labels !== false) {
          var at = obPt(cx + 0.5, cy + 0.56, z0).split(",");
          // Le cadrage grossit une petite grille : l'étiquette suit, à taille lue constante.
          var text = obSvg("text", { class: "ob-m-label", x: at[0], y: at[1], "text-anchor": "middle", "data-label": room.id, style: "font-size:" + (2.6 + G) + "px" });
          text.textContent = obShort(room.label);
          labels.push(text);
        }
      });
      labels.forEach(function (text) { level.appendChild(text); });

      if (F > 1) {
        var tag = obPt(-PAD, b, zs - SLAB * 0.5).split(",");
        level.appendChild(obSvg("text", { class: "ob-m-tag", x: (+tag[0] - 7).toFixed(1), y: tag[1], "text-anchor": "end" }, [
          document.createTextNode(obFloorTag(floorList[L]))
        ]));
      }
      svg.appendChild(level);
    });

    // Cadrage : calculé une fois pour toutes les dalles et murs.
    var half = (G + 2 * PAD) * OB_U * OB_K;
    var top = -(PAD * 2) * OB_U * 0.5 - ((F - 1) * LH + WH) * OB_U;
    var bottom = (G + PAD) * OB_U + SLAB * OB_U + 14;
    var left = -half - (F > 1 ? 34 : 10), width = half * 2 + (F > 1 ? 44 : 20);
    svg.setAttribute("viewBox", left.toFixed(1) + " " + (top - 10).toFixed(1) + " " + width.toFixed(1) + " " + (bottom - top + 14).toFixed(1));

    return el("div", { class: "ob-model" + (opts.materialize ? " ob-materialize" : "") }, [svg]);
  }

  function obShort(label) {
    var text = String(label || "").trim() || "Sans nom";
    return text.length > 15 ? text.slice(0, 14) + "…" : text;
  }

  function obMeta(type, rooms, floors) {
    var parts = [OB_TYPE_LABEL[type] || "Logement"];
    if (floors > 1) parts.push(plural(floors, "niveau", "niveaux"));
    if (rooms.length) parts.push(plural(rooms.length, "pièce", "pièces"));
    var furn = 0;
    rooms.forEach(function (room) { furn += (room.furniture || []).length; });
    if (furn) parts.push(plural(furn, "rangement", "rangements"));
    return parts.join(" · ");
  }

  /* Le panneau d'aperçu : la maquette et l'enseigne du logement. */
  function obSidePanel(data, opts) {
    opts = opts || {};
    var name = el("p", { class: "ob-sign-name", text: data.name || "Votre logement" });
    var meta = el("p", { class: "ob-sign-meta", text: data.rooms.length ? obMeta(data.type, data.rooms, data.floors) : (opts.empty || "Vos pièces apparaîtront ici, une à une.") });
    return el("aside", { class: "ob-side" + (opts.band ? " ob-side--band" : "") + (opts.hideMobile ? " ob-side--desk" : ""), "aria-label": "Aperçu du logement" }, [
      obModel(data, opts),
      el("div", { class: "ob-sign" }, [name, meta, opts.caption ? el("p", { class: "ob-sign-cap", text: opts.caption }) : null])
    ]);
  }

  /* L'ossature commune des écrans de nuit. */
  function obShell(kind, head, stageChildren, side, extra) {
    var stage = el("section", {
      class: "ob-stage" + (obEnter ? " ob-in-" + obEnter : ""),
      "aria-labelledby": "ob-step-title"
    }, stageChildren);
    obEnter = null;
    return el("div", { class: "ob ob-" + kind + " night" }, [
      obBackdrop(),
      head,
      extra || null,
      el("main", { class: "ob-main" + (side ? "" : " ob-main--solo") }, [stage, side || null])
    ]);
  }

  /* ═══ Écran 1 — Création de compte ══════════════════════════════════ */

  /* L'état du formulaire vit HORS de la fonction de rendu : un render()
     venu d'ailleurs ne vide pas les champs et ne perd pas les erreurs. */
  function obBlankSignup() { return { fullName: "", email: "", password: "", errors: {}, busy: false }; }
  var signup = obBlankSignup();

  var OB_DOMAINS = ["gmail.com", "hotmail.com", "hotmail.fr", "outlook.com", "outlook.fr", "yahoo.com", "yahoo.fr",
    "orange.fr", "free.fr", "laposte.net", "sfr.fr", "icloud.com", "wanadoo.fr", "live.fr", "proton.me", "protonmail.com", "gmx.fr", "bbox.fr", "neuf.fr"];

  function obDistance(a, b) {
    var row = [], i, j, prev, tmp;
    for (j = 0; j <= b.length; j++) row.push(j);
    for (i = 1; i <= a.length; i++) {
      prev = row[0]; row[0] = i;
      for (j = 1; j <= b.length; j++) {
        tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  }

  /* « gmial.com » est presque toujours « gmail.com ». On propose, on ne
     corrige jamais d'office. */
  function obEmailHint(value) {
    var match = /^([^@\s]+)@([^@\s]+)$/.exec(String(value).trim().toLowerCase());
    if (!match || OB_DOMAINS.indexOf(match[2]) !== -1) return null;
    var best = null, score = 3;
    OB_DOMAINS.forEach(function (domain) {
      var d = obDistance(match[2], domain);
      if (d < score) { score = d; best = domain; }
    });
    return best ? match[1] + "@" + best : null;
  }

  function obFieldError(key, value) {
    value = value || "";
    if (key === "fullName") return value.trim() ? null : "Indiquez au moins un prénom.";
    if (key === "email") {
      if (!value.trim()) return "Indiquez votre adresse email.";
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) ? null : "Cette adresse email n'est pas valide : vérifiez le @ et le domaine.";
    }
    // Mêmes règles que le serveur : 12 caractères et une variété minimale.
    if (value.length < 12) {
      var missing = 12 - value.length;
      return "Encore " + missing + (missing > 1 ? " caractères" : " caractère") + " : le mot de passe doit en faire 12 au minimum.";
    }
    if (new Set(value).size < 5) return "Ce mot de passe est trop répétitif. Utilisez au moins cinq caractères différents.";
    return null;
  }

  /* La jauge : informative pendant la frappe, jamais un reproche. */
  function obStrength(pw) {
    if (!pw) return { level: 0, value: 0, text: "12 caractères minimum, dont 5 différents." };
    if (pw.length < 12) return { level: 1, value: pw.length / 12 * 0.45, text: pw.length + " sur 12 caractères" };
    if (new Set(pw).size < 5) return { level: 1, value: 0.45, text: "Trop répétitif : variez les caractères." };
    var kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (re) { return re.test(pw); }).length;
    var score = 2 + (pw.length >= 16 ? 1 : 0) + (kinds >= 3 ? 1 : 0);
    if (score === 2) return { level: 2, value: 0.62, text: "Correct. Plus long, il serait plus solide." };
    if (score === 3) return { level: 3, value: 0.82, text: "Solide." };
    return { level: 4, value: 1, text: "Excellent." };
  }

  /* Le logement d'exemple de l'aperçu d'inscription : il porte déjà votre
     prénom pendant que vous le tapez. */
  var OB_TEASER = [
    { id: "ob-t1", key: "salon", label: "Salon", icon: "r-salon", kind: "room", furniture: ["Buffet", "Bibliothèque"] },
    { id: "ob-t2", key: "cuisine", label: "Cuisine", icon: "r-cuisine", kind: "room", furniture: ["Placard haut", "Tiroir à couverts", "Sous l'évier"] },
    { id: "ob-t3", key: "chambre", label: "Chambre", icon: "r-chambre", kind: "room", furniture: ["Armoire", "Table de chevet"] },
    { id: "ob-t4", key: "sdb", label: "Salle de bain", icon: "r-sdb", kind: "room", furniture: ["Armoire à pharmacie"] },
    { id: "ob-t5", key: "entree", label: "Entrée", icon: "r-entree", kind: "room", furniture: ["Placard"] }
  ];

  function obTeaserName() {
    var first = obFirstName(signup.fullName);
    return first ? "Chez " + first : "Chez vous";
  }

  function screenSignup() {
    obKeys = null;
    var fields = {};
    var cta, ctaLabel, signName;

    function setStatus(key, message, markOk) {
      var f = fields[key];
      signup.errors[key] = message || null;
      f.wrap.classList.toggle("is-err", !!message);
      f.wrap.classList.toggle("is-ok", !message && !!markOk && !!signup[key]);
      if (message) f.input.setAttribute("aria-invalid", "true");
      else f.input.removeAttribute("aria-invalid");
      f.msg.replaceChildren();
      if (message) f.msg.appendChild(el("span", { class: "ob-msg-err" }, [icon("warn", 13), el("span", { text: message })]));
    }

    function offerEmail() {
      var better = obEmailHint(signup.email);
      if (!better) return;
      var f = fields.email;
      f.msg.replaceChildren(el("button", {
        class: "ob-suggest", type: "button",
        onclick: function () {
          signup.email = better; f.input.value = better;
          setStatus("email", null, true); f.input.focus();
        }
      }, ["Vouliez-vous dire ", el("strong", { text: better }), " ?"]));
    }

    /* Validation douce : au départ du champ, jamais pendant la première
       saisie. Une fois une erreur affichée, elle se met à jour à la frappe
       pour disparaître dès que c'est corrigé. */
    function check(key, soft) {
      var value = signup[key];
      if (soft && !value) { setStatus(key, null, false); return true; }
      var message = obFieldError(key, value);
      setStatus(key, message, true);
      if (!message && key === "email") offerEmail();
      return !message;
    }

    function field(key, label, type, autocomplete, extras) {
      var id = "ob-f-" + key;
      var input = el("input", {
        class: "ob-input", id: id, name: key, type: type, placeholder: " ",
        autocomplete: autocomplete, value: signup[key], required: true,
        maxlength: key === "fullName" ? 80 : 254,
        autocapitalize: key === "fullName" ? "words" : "none",
        spellcheck: key === "fullName" ? null : "false",
        inputmode: key === "email" ? "email" : null,
        "aria-describedby": id + "-msg" + (key === "password" ? " ob-meter-txt" : ""),
        oninput: function (event) {
          signup[key] = event.target.value;
          if (signup.errors[key]) check(key, false);
          else if (fields[key].wrap.classList.contains("is-ok") && obFieldError(key, signup[key])) fields[key].wrap.classList.remove("is-ok");
          if (key === "password") paintMeter();
          if (key === "fullName" && signName) signName.textContent = obTeaserName();
        },
        onblur: function () { check(key, true); }
      });
      var msg = el("div", { class: "ob-msg", id: id + "-msg", "aria-live": "polite" });
      var wrap = el("div", { class: "ob-field ob-field--" + key }, [
        input,
        el("label", { class: "ob-flabel", for: id, text: label }),
        key === "password" ? null : el("span", { class: "ob-field-ok", "aria-hidden": "true" }, [obCheck(16)])
      ].concat(extras || []).concat([msg]));
      fields[key] = { input: input, msg: msg, wrap: wrap };
      if (signup.errors[key]) setTimeout(function () { setStatus(key, signup.errors[key], false); }, 0);
      return wrap;
    }

    /* Afficher le mot de passe : on garde la position du curseur. */
    var eye = el("button", {
      class: "ob-eye", type: "button", "aria-pressed": "false", "aria-controls": "ob-f-password",
      "aria-label": "Afficher le mot de passe",
      onclick: function () {
        var input = fields.password.input;
        var start = input.selectionStart, end = input.selectionEnd;
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        eye.setAttribute("aria-pressed", show ? "true" : "false");
        eye.setAttribute("aria-label", show ? "Masquer le mot de passe" : "Afficher le mot de passe");
        eye.replaceChildren(icon(show ? "eye-off" : "eye", 19));
        input.focus();
        try { input.setSelectionRange(start, end); } catch (e) {}
      }
    }, [icon("eye", 19)]);

    var meterFill = el("i", { class: "ob-meter-fill" });
    var meterTxt = el("span", { class: "ob-meter-txt", id: "ob-meter-txt" });
    var meter = el("div", { class: "ob-meter" }, [
      el("span", { class: "ob-meter-track", "aria-hidden": "true" }, [meterFill, el("i", { class: "ob-meter-ticks" })]),
      meterTxt
    ]);
    function paintMeter() {
      var s = obStrength(signup.password);
      meter.setAttribute("data-level", s.level);
      meterFill.style.setProperty("--v", s.value.toFixed(3));
      meterTxt.textContent = s.text;
    }

    function submit(event) {
      event.preventDefault();
      if (signup.busy) return;
      var firstBad = null;
      ["fullName", "email", "password"].forEach(function (key) {
        if (!check(key, false) && !firstBad) firstBad = key;
      });
      if (firstBad) {
        var f = fields[firstBad];
        f.input.focus();
        f.wrap.classList.remove("ob-shake");
        void f.wrap.offsetWidth;
        f.wrap.classList.add("ob-shake");
        obAnnounce(signup.errors[firstBad]);
        return;
      }
      if (cloud) { cloudSignup(); return; }
      // Une adresse = un compte : si elle est déjà prise ici, on propose de
      // s'y connecter plutôt que d'écraser le logement qui va avec.
      if (accountFind(signup.email)) {
        setStatus("email", "Un compte existe déjà avec cette adresse sur cet appareil. Connectez-vous, ou choisissez une autre adresse.", false);
        fields.email.input.focus();
        fields.email.wrap.classList.remove("ob-shake");
        void fields.email.wrap.offsetWidth;
        fields.email.wrap.classList.add("ob-shake");
        obLogin.email = accountKey(signup.email);
        obAnnounce(signup.errors.email);
        return;
      }
      signup.busy = true;
      cta.classList.add("is-busy");
      cta.setAttribute("aria-busy", "true");
      ctaLabel.textContent = "Création du compte…";
      obBurstFrom(cta, null, { count: 22, power: 5, up: true });
      var account = { name: signup.fullName.trim(), email: signup.email.trim().toLowerCase() };
      var started = Date.now();
      // Seule l'empreinte salée du mot de passe est gardée, jamais le texte.
      obSeal(signup.password).then(function (secret) {
        account.secret = secret;
        setTimeout(function () { enter(account, false); }, Math.max(0, (obCalm() ? 150 : 700) - (Date.now() - started)));
      });
    }

    /* En ligne : le serveur crée le compte et envoie l'email de confirmation.
       On n'entre dans l'application qu'après avoir ouvert ce lien. */
    function cloudSignup() {
      signup.busy = true;
      cta.classList.add("is-busy");
      cta.setAttribute("aria-busy", "true");
      ctaLabel.textContent = "Création du compte…";
      obBurstFrom(cta, null, { count: 22, power: 5, up: true });
      var mail = signup.email.trim().toLowerCase();
      cloud.signup({ name: signup.fullName.trim(), email: mail, password: signup.password }).then(function (res) {
        signup.busy = false;
        if (res.ok) {
          obCheckMail = { email: mail };
          signup = obBlankSignup();
          obTransition(function () {}, "fwd");
          return;
        }
        cta.classList.remove("is-busy");
        cta.removeAttribute("aria-busy");
        ctaLabel.textContent = "Créer mon compte gratuit";
        var key = res.error === "password" ? "password" : "email";
        var message = res.error === "limite" ? "Trop de tentatives. Réessayez dans une minute."
          : res.error === "password" ? "Ce mot de passe est trop facile à deviner : choisissez-en un autre."
          : res.error === "exists" ? "Un compte existe déjà avec cette adresse. Connectez-vous."
          : res.error === "email" ? "Cette adresse n'est pas acceptée. Vérifiez-la, ou essayez-en une autre."
          : "La création du compte a échoué. Réessayez dans un instant.";
        setStatus(key, message, false);
        fields[key].input.focus();
        obAnnounce(message);
      });
    }

    cta = obCta("Créer mon compte gratuit", { type: "submit" });
    ctaLabel = cta.querySelector(".ob-cta-label");
    if (signup.busy) signup.busy = false;

    var form = el("form", { class: "ob-form", onsubmit: submit, novalidate: true, "aria-label": "Création de compte" }, [
      field("fullName", "Prénom et nom", "text", "name"),
      field("email", "Adresse email", "email", "email"),
      field("password", "Mot de passe", "password", "new-password", [eye, meter]),
      cta,
      el("p", { class: "ob-trust" }, [icon("shield", 14), el("span", { text: cloud
        ? "Votre inventaire est enregistré en Europe et vous suit sur tous vos appareils."
        : "Votre inventaire reste sur votre appareil. Aucun email n'est envoyé." })]),
      el("p", { class: "ob-legal" }, [
        "En créant votre compte, vous acceptez les ",
        el("a", { href: siteUrl("conditions.html"), target: "_blank", rel: "noopener", text: "conditions d'utilisation" }),
        ". Vos données sont traitées selon notre ",
        el("a", { href: siteUrl("confidentialite.html"), target: "_blank", rel: "noopener", text: "politique de confidentialité" }),
        "."
      ]),
      // Prototype public : rien n'est transmis, mais on ne doit pas habituer les
      // visiteurs à confier un mot de passe qui leur sert ailleurs.
      el("p", { class: "ob-fine", text: cloud
        ? "Un email de confirmation part à cette adresse : votre compte s'active quand vous ouvrez son lien."
        : "Bêta : choisissez un mot de passe inventé, que vous n'utilisez nulle part ailleurs." })
    ]);
    paintMeter();

    var side = obSidePanel({ name: obTeaserName(), type: "apartment", floors: 1, rooms: OB_TEASER }, {
      hideMobile: true,
      caption: "Aperçu. Votre logement prendra forme ici, pièce par pièce, pendant la configuration."
    });
    signName = side.querySelector(".ob-sign-name");

    var head = el("header", { class: "ob-head" }, [
      logo(22),
      el("p", { class: "ob-head-link" }, [
        el("span", { class: "ob-head-q", text: "Déjà un compte ? " }),
        el("button", { class: "ob-linkbtn", type: "button", onclick: function () { obGoAuth("login"); } }, "Se connecter")
      ])
    ]);

    /* D'autres comptes vivent déjà sur cet appareil : on le signale, sans
       alarme — en créer un nouveau ne touche à aucun d'eux. */
    var others = accountsList();
    var existing = others.length ? el("div", { class: "ob-panel" }, [
      el("p", { class: "ob-panel-title", text: others.length === 1 ? "Un compte existe déjà sur cet appareil." : others.length + " comptes existent déjà sur cet appareil." }),
      el("p", { text: others.slice(0, 3).map(function (o) { return o.account.email; }).join(", ") + (others.length > 3 ? "…" : "") + ". Le nouveau compte s'ajoute à côté, avec son propre logement." }),
      el("div", { class: "ob-panel-actions" }, [
        el("button", { class: "ob-line-btn", type: "button", onclick: function () { obGoAuth("login"); } }, [icon("arrow-right", 15), others.length === 1 ? "Me connecter à ce compte" : "Me connecter à l'un d'eux"])
      ])
    ]) : null;

    var stage = [
      el("h1", { class: "ob-title ob-title--hero", id: "ob-step-title", tabindex: "-1" }, [
        "Retrouvez tout en un ", el("em", { class: "ob-serif", text: "éclair" }), "."
      ]),
      el("p", { class: "ob-lede", text: "Créez votre compte gratuit. Deux minutes pour décrire votre logement, puis chaque objet se retrouve en deux secondes." }),
      existing,
      form,
      /* Pas de « Continuer avec Google ou Apple » ici : sans serveur, ces
         boutons ne pourraient que créer un compte fictif. Ils viendront avec
         l'application en ligne (app.getfulmo.com), via Supabase Auth. */
      el("div", { class: "ob-or", role: "separator" }, [el("span", { text: "ou" })]),
      /* Entrée directe : un prototype qu'on n'atteint qu'après avoir passé
         une validation de mot de passe n'est pas un prototype utile. */
      el("button", {
        class: "ob-demo", type: "button",
        onclick: function (event) {
          obBurstFrom(event.currentTarget, event, { count: 16 });
          openDemo();
        }
      }, [
        el("span", { class: "ob-demo-ic", "aria-hidden": "true" }, [icon("bolt", 18)]),
        el("span", { class: "ob-demo-txt" }, [
          el("strong", { text: "Essayer avec un logement déjà rempli" }),
          el("span", { text: "40 objets, Éclair activé, sans inscription." })
        ]),
        icon("arrow-right", 16)
      ])
    ];

    var screen = obShell("signup", head, stage, side);
    if (obFine()) setTimeout(function () { var f = fields.fullName && fields.fullName.input; if (f && f.isConnected && !document.activeElement.matches("input")) f.focus({ preventScroll: true }); }, 30);
    return screen;
  }

  /* Ouvre la session du prototype. `seeded` saute la configuration du logement
     et charge l'exemple, pour atterrir directement dans l'application. */
  function enter(account, seeded) {
    // Le compte ouvert est rangé dans le registre avant tout : en créer un
    // autre ne l'efface pas, on pourra s'y reconnecter.
    stash();
    resetViews();

    // La démonstration repart toujours du même logement : ce qu'un visiteur
    // y a changé la dernière fois ne se voit pas à la suivante. Ses relevés
    // importés partent avec elle.
    if (seeded && accountFind(account.email)) {
      var stale = accountFind(account.email);
      (stale.scans || []).forEach(function (scan) { if (scan && scan.id && scan.source !== "demo") scanStore.del(scan.id); });
      var registry = accountsRead();
      delete registry[accountKey(account.email)];
      accountsWrite(registry);
    }

    // Un nouveau compte part d'un état propre : il ne doit pas hériter du
    // logement d'un compte précédent sur cet appareil. Seul le thème reste.
    var theme = state.theme;
    state = blank();
    state.theme = theme;
    state.account = {
      name: account.name, email: account.email, createdAt: Date.now(), secret: account.secret || null,
      terms: { version: LEGAL_VERSION, acceptedAt: new Date().toISOString() }
    };
    state.session = true;
    obAuthView = null;
    signup = obBlankSignup();
    wiz = null;
    screenOnboarding.last = 0;

    if (seeded) {
      seedHousehold();
      state.plan = "premium";
      state.planSeen = true;
      state.screen = "app";
      state.tab = "search";
      save();
      render();
      window.scrollTo(0, 0);
      toast("Bienvenue. Éclair activé, 40 objets chargés.");
      return;
    }

    // D'abord le « compte créé », puis le choix de formule — une étape du
    // parcours, pas une modale.
    state.screen = "onboarding";
    obWelcome = { name: obFirstName(account.name) };
    save();
    obTransition(function () {}, "fwd");
  }

  /* ═══ Connexion, déconnexion, compte créé ═══════════════════════════ */

  var obAuthView = null;   // "signup" | "login" : écran d'accès demandé
  var obWelcome = null;    // { name } : à saluer juste après l'inscription
  var obWelcomeToken = null;
  var obLogin = { email: "", password: "" };
  var obCheckMail = null;  // { email } : en ligne, compte créé, adresse à confirmer

  /* La démonstration vit sur getfulmo.com : en ligne, on y emmène. */
  function openDemo() {
    if (cloud) { window.location.assign(siteUrl("app#demo")); return; }
    enter(DEMO_ACCOUNT, true);
  }

  function resendButton(mail) {
    var sent = false;
    return el("button", {
      class: "ob-line-btn", type: "button",
      onclick: function () {
        if (sent) return;
        sent = true;
        cloud.resend(mail).then(function (res) {
          toast(res.ok ? "Email renvoyé à " + mail + "." : res.error === "limite" ? "Patientez une minute avant un nouvel envoi." : "L'email n'a pas pu partir. Réessayez dans un instant.");
          if (!res.ok) sent = false;
        });
      }
    }, [icon("arrow-right", 15), "Renvoyer l'email"]);
  }

  /* En ligne, après l'inscription : on attend la confirmation de l'adresse. */
  function obCheckMailScreen() {
    obKeys = null;
    var mail = obCheckMail.email;
    var stage = [
      el("div", { class: "ob-welcome-check", "aria-hidden": "true" }, [obCheck(44)]),
      el("h1", { class: "ob-title ob-welcome-title", id: "ob-step-title", tabindex: "-1" }, [
        el("span", { text: "Compte créé." }),
        el("span", { class: "ob-welcome-name", text: "Confirmez votre adresse." })
      ]),
      el("p", { class: "ob-lede", text: "Nous venons d'envoyer un lien à " + mail + ". Ouvrez-le pour activer votre compte : vous arriverez directement à la configuration de votre logement." }),
      el("div", { class: "ob-panel-actions" }, [
        resendButton(mail),
        el("button", { class: "ob-line-btn", type: "button", onclick: function () { obCheckMail = null; obLogin.email = mail; obGoAuth("login"); } }, [icon("arrow-right", 15), "J'ai confirmé, me connecter"])
      ]),
      el("p", { class: "ob-fine", text: "Rien reçu ? Regardez dans les courriers indésirables, ou renvoyez l'email." })
    ];
    return obShell("welcome", el("header", { class: "ob-head" }, [logo(22)]), stage, null);
  }

  /* Sans session : l'écran demandé, sinon la connexion si un compte existe
     sur cet appareil, l'inscription sinon. */
  function obAuthScreen() {
    if (obCheckMail) return obCheckMailScreen();
    var view = obAuthView || (state.account ? "login" : "signup");
    return view === "login" ? screenLogin() : screenSignup();
  }

  function obGoAuth(view) {
    obAuthView = view;
    obTransition(function () {}, view === "login" ? "back" : "fwd");
  }

  /* Le mot de passe ne s'écrit jamais en clair dans le stockage : on garde un
     sel aléatoire et l'empreinte SHA-256 de « sel:mot de passe ». Précaution
     de prototype — la vraie application délègue à Supabase Auth. Sans
     crypto.subtle (file://, contexte non sécurisé), rien n'est enregistré et
     la connexion ne vérifie que l'email. */
  function obCanHash() {
    return !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues && window.TextEncoder);
  }
  function obHex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function obDigest(password, salt) {
    return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + password)).then(obHex);
  }
  function obSeal(password) {
    if (!obCanHash()) return Promise.resolve(null);
    try {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      var salt = obHex(bytes.buffer);
      return obDigest(password, salt).then(function (hash) { return { algo: "sha256", salt: salt, hash: hash }; }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  /* → Promise<booléen>. Un compte sans empreinte (créé avant cette version, ou
     par un bouton de démonstration) est accepté : l'appelant la pose alors. */
  function obVerify(secret, password) {
    if (!secret || !secret.hash || !obCanHash()) return Promise.resolve(true);
    return obDigest(password, secret.salt).then(function (hash) { return hash === secret.hash; }, function () { return false; });
  }

  /* Le logement enregistré, sous la forme qu'attend la maquette. */
  function obHouseRooms() {
    return state.locations.filter(function (l) { return !l.parentId; }).slice(0, 16).map(function (l) {
      var ic = String(l.icon || "");
      return {
        id: "h-" + l.id, key: ic.indexOf("r-") === 0 ? ic.slice(2) : null, label: l.name, icon: l.icon, kind: l.kind,
        floor: typeof l.floor === "number" ? l.floor : 0,
        furniture: state.locations.filter(function (c) { return c.parentId === l.id; }).map(function (c) { return c.name; })
      };
    });
  }

  /* Ouvre un compte du registre, session comprise, et y entre. */
  function obOpenAccount(email, secret) {
    stash();
    resetViews();
    accountOpen(email);
    if (secret) state.account.secret = secret;
    state.session = true;
    obAuthView = null;
    obLogin = { email: "", password: "" };
    signup = obBlankSignup();
    wiz = null;
    save();
    obTransition(function () {}, "fwd");
  }

  function obLogout() {
    if (cloud) { closeSheet(); cloud.logout(); return; }
    state.session = false;
    save();
    resetViews();
    obAuthView = "login";
    obLogin = { email: "", password: "" };
    closeSheet();
    obTransition(function () {}, "back");
    toast("Vous êtes déconnecté. Votre logement reste sur cet appareil.");
  }

  function screenLogin() {
    obKeys = null;
    var acct = state.account;
    var home = acct && state.household ? state.household : null;
    var fields = {};
    var busy = false;
    if (!obLogin.email && acct) obLogin.email = acct.email;

    var panel = el("div", { class: "ob-login-panel", "aria-live": "polite" });

    function setErr(key, message) {
      var f = fields[key];
      f.wrap.classList.toggle("is-err", !!message);
      if (message) f.input.setAttribute("aria-invalid", "true");
      else f.input.removeAttribute("aria-invalid");
      f.msg.replaceChildren();
      if (message) f.msg.appendChild(el("span", { class: "ob-msg-err" }, [icon("warn", 13), el("span", { text: message })]));
    }

    function shake(key) {
      var w = fields[key].wrap;
      w.classList.remove("ob-shake");
      void w.offsetWidth;
      w.classList.add("ob-shake");
    }

    function field(key, label, type, autocomplete, extras) {
      var id = "ob-l-" + key;
      var input = el("input", {
        class: "ob-input", id: id, name: key, type: type, placeholder: " ",
        autocomplete: autocomplete, value: obLogin[key], required: true,
        maxlength: 254, autocapitalize: "none", spellcheck: "false",
        inputmode: key === "email" ? "email" : null,
        "aria-describedby": id + "-msg",
        oninput: function (event) {
          obLogin[key] = event.target.value;
          if (fields[key].wrap.classList.contains("is-err")) setErr(key, null);
        }
      });
      var msg = el("div", { class: "ob-msg", id: id + "-msg", "aria-live": "polite" });
      var wrap = el("div", { class: "ob-field ob-field--" + key }, [input, el("label", { class: "ob-flabel", for: id, text: label })].concat(extras || []).concat([msg]));
      fields[key] = { input: input, msg: msg, wrap: wrap };
      return wrap;
    }

    var eye = el("button", {
      class: "ob-eye", type: "button", "aria-pressed": "false", "aria-controls": "ob-l-password",
      "aria-label": "Afficher le mot de passe",
      onclick: function () {
        var input = fields.password.input;
        var start = input.selectionStart, end = input.selectionEnd;
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        eye.setAttribute("aria-pressed", show ? "true" : "false");
        eye.setAttribute("aria-label", show ? "Masquer le mot de passe" : "Afficher le mot de passe");
        eye.replaceChildren(icon(show ? "eye-off" : "eye", 19));
        input.focus();
        try { input.setSelectionRange(start, end); } catch (e) {}
      }
    }, [icon("eye", 19)]);

    function toSignup(email) {
      if (email) signup.email = email;
      obGoAuth("signup");
    }

    function demoButton() {
      // La démonstration est un compte à part : l'ouvrir ne touche à rien.
      return el("button", {
        class: "ob-line-btn", type: "button",
        onclick: openDemo
      }, [icon("bolt", 15), "Essayer la démo"]);
    }

    function showNoAccount(email) {
      panel.replaceChildren(el("div", { class: "ob-panel", role: "alert" }, [
        el("p", { class: "ob-panel-title", text: "Aucun compte avec cette adresse sur cet appareil." }),
        el("p", { text: "Pendant la bêta, un compte vit dans le navigateur où il a été créé. Vérifiez l'adresse, ou créez votre compte ici." }),
        el("div", { class: "ob-panel-actions" }, [
          el("button", { class: "ob-line-btn ob-line-btn--volt", type: "button", onclick: function () { toSignup(email); } }, [icon("plus", 15), "Créer un compte"]),
          demoButton()
        ])
      ]));
      obAnnounce("Aucun compte avec cette adresse sur cet appareil.");
    }

    function showForgot() {
      if (cloud) {
        panel.replaceChildren(el("div", { class: "ob-panel", role: "status" }, [
          el("p", { class: "ob-panel-title", text: "Réinitialisation bientôt disponible." }),
          el("p", { text: "La réinitialisation du mot de passe par email ouvre très prochainement. Votre compte et votre logement restent en sécurité en attendant." })
        ]));
        return;
      }
      panel.replaceChildren(el("div", { class: "ob-panel", role: "status" }, [
        el("p", { class: "ob-panel-title", text: "Pas de réinitialisation pendant la bêta." }),
        el("p", { text: "Sans serveur, aucun email ne peut partir. Votre compte et votre logement restent dans ce navigateur ; si le mot de passe est perdu, créez un nouveau compte avec une autre adresse." }),
        el("div", { class: "ob-panel-actions" }, [
          el("button", { class: "ob-line-btn", type: "button", onclick: function () { toSignup(null); } }, [icon("plus", 15), "Créer un nouveau compte"])
        ])
      ]));
    }

    var cta = obCta("Se connecter", { type: "submit" });
    var ctaLabel = cta.querySelector(".ob-cta-label");
    function setBusy(on) {
      busy = on;
      cta.classList.toggle("is-busy", on);
      if (on) cta.setAttribute("aria-busy", "true"); else cta.removeAttribute("aria-busy");
      ctaLabel.textContent = on ? "Connexion…" : "Se connecter";
    }

    function submit(event) {
      event.preventDefault();
      if (busy) return;
      panel.replaceChildren();
      var mail = obLogin.email.trim().toLowerCase();
      var bad = null;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
        setErr("email", mail ? "Cette adresse email n'est pas valide : vérifiez le @ et le domaine." : "Indiquez votre adresse email.");
        bad = "email";
      } else setErr("email", null);
      if (!obLogin.password) { setErr("password", "Indiquez votre mot de passe."); bad = bad || "password"; }
      else setErr("password", null);
      if (bad) { fields[bad].input.focus(); shake(bad); return; }

      if (cloud) { cloudLogin(mail); return; }
      var target = accountFind(mail);
      if (!target) { showNoAccount(mail); return; }
      var acctIn = target.account;

      setBusy(true);
      var started = Date.now();
      obVerify(acctIn.secret, obLogin.password).then(function (ok) {
        setTimeout(function () {
          if (!ok) {
            setBusy(false);
            setErr("password", "Mot de passe incorrect. Vérifiez les majuscules, ou voyez « Mot de passe oublié ? ».");
            fields.password.input.focus();
            fields.password.input.select();
            shake("password");
            obAnnounce("Mot de passe incorrect.");
            return;
          }
          // Compte ancien sans empreinte : on la pose maintenant.
          var sealed = acctIn.secret || !obCanHash() ? Promise.resolve(acctIn.secret || null) : obSeal(obLogin.password);
          sealed.then(function (secret) {
            obOpenAccount(mail, secret);
            toast(state.household ? "Bon retour, " + (obFirstName(acctIn.name) || "bienvenue") + "." : "Connecté. Reprenons la configuration de votre logement.");
          });
        }, Math.max(0, (obCalm() ? 100 : 450) - (Date.now() - started)));
      });
    }

    /* En ligne : le serveur vérifie le mot de passe et ouvre la session ; la
       page se recharge alors sur le compte, son foyer et son inventaire. */
    function cloudLogin(mail) {
      setBusy(true);
      cloud.login({ email: mail, password: obLogin.password }).then(function (res) {
        if (res.ok) return;
        setBusy(false);
        if (res.error === "unconfirmed") {
          panel.replaceChildren(el("div", { class: "ob-panel", role: "alert" }, [
            el("p", { class: "ob-panel-title", text: "Adresse pas encore confirmée." }),
            el("p", { text: "Ouvrez le lien reçu par email à l'inscription, puis reconnectez-vous." }),
            el("div", { class: "ob-panel-actions" }, [resendButton(mail)])
          ]));
          obAnnounce("Adresse pas encore confirmée.");
          return;
        }
        var message = res.error === "limite" ? "Trop de tentatives. Réessayez dans une minute."
          : res.error === "invalid" ? "Email ou mot de passe incorrect."
          : "La connexion a échoué. Réessayez dans un instant.";
        setErr("password", message);
        fields.password.input.focus();
        shake("password");
        obAnnounce(message);
      });
    }

    /* Les comptes de cet appareil, en un geste : toucher l'un remplit
       l'email et passe au mot de passe. */
    var known = accountsList();
    var picker = known.length > 1 ? el("div", { class: "ob-accounts", role: "group", "aria-label": "Comptes sur cet appareil" },
      known.slice(0, 6).map(function (o) {
        var mailOf = accountKey(o.account.email);
        return el("button", {
          class: "ob-account" + (accountKey(obLogin.email) === mailOf ? " is-on" : ""), type: "button",
          "aria-pressed": accountKey(obLogin.email) === mailOf ? "true" : "false",
          onclick: function (event) {
            // La démonstration n'a pas de mot de passe : on l'ouvre d'un geste.
            if (mailOf === DEMO_ACCOUNT.email) { enter(DEMO_ACCOUNT, true); return; }
            obLogin.email = mailOf;
            fields.email.input.value = mailOf;
            setErr("email", null);
            panel.replaceChildren();
            Array.prototype.forEach.call(picker.children, function (b) { b.classList.remove("is-on"); b.setAttribute("aria-pressed", "false"); });
            event.currentTarget.classList.add("is-on");
            event.currentTarget.setAttribute("aria-pressed", "true");
            fields.password.input.focus();
          }
        }, [
          el("span", { class: "ob-account-av", "aria-hidden": "true", text: (obFirstName(o.account.name) || "?").charAt(0).toUpperCase() }),
          el("span", { class: "ob-account-txt" }, [
            el("strong", { text: mailOf === DEMO_ACCOUNT.email ? "Démonstration" : (o.account.name || mailOf) }),
            el("span", { text: mailOf })
          ])
        ]);
      })) : null;

    var form = el("form", { class: "ob-form", onsubmit: submit, novalidate: true, "aria-label": "Connexion" }, [
      field("email", "Adresse email", "email", "username"),
      field("password", "Mot de passe", "password", "current-password", [eye]),
      el("div", { class: "ob-login-row" }, [
        el("button", { class: "ob-linkbtn", type: "button", onclick: showForgot }, "Mot de passe oublié ?")
      ]),
      cta
    ]);

    var side = home
      ? obSidePanel({ name: home.name, type: home.type, floors: home.floors || 1, rooms: obHouseRooms() }, { hideMobile: true, caption: "Votre logement vous attend, tel que vous l'avez laissé." })
      : obSidePanel({ name: "Chez vous", type: "apartment", floors: 1, rooms: OB_TEASER }, { hideMobile: true, caption: "Aperçu. Votre logement vous attendra ici, pièce par pièce." });

    var head = el("header", { class: "ob-head" }, [
      logo(22),
      el("p", { class: "ob-head-link" }, [
        el("span", { class: "ob-head-q", text: "Pas encore de compte ? " }),
        el("button", { class: "ob-linkbtn", type: "button", onclick: function () { toSignup(null); } }, "Créer un compte")
      ])
    ]);

    var stage = [
      el("h1", { class: "ob-title ob-title--hero", id: "ob-step-title", tabindex: "-1" }, [
        "Content de vous ", el("em", { class: "ob-serif", text: "revoir" }), "."
      ]),
      el("p", { class: "ob-lede", text: picker ? "Choisissez votre compte, ou saisissez votre adresse." : home ? "Connectez-vous pour retrouver " + home.name + "." : "Connectez-vous pour retrouver votre logement et tout ce qu'il contient." }),
      picker,
      form,
      panel,
      el("p", { class: "ob-fine", text: cloud
        ? "Votre compte et votre inventaire sont enregistrés en Europe : vous les retrouvez sur tous vos appareils."
        : "Bêta : votre compte vit dans ce navigateur. Le mot de passe n'y est jamais stocké en clair, seulement son empreinte." }),
      el("p", { class: "ob-auth-switch" }, [
        "Pas encore de compte ? ",
        el("button", { class: "ob-linkbtn", type: "button", onclick: function () { toSignup(null); } }, "Créer un compte")
      ])
    ];

    var screen = obShell("login", head, stage, side);
    if (obFine()) setTimeout(function () {
      var target = obLogin.email ? fields.password.input : fields.email.input;
      if (target && target.isConnected && !document.activeElement.matches("input")) target.focus({ preventScroll: true });
    }, 30);
    return screen;
  }

  /* « Compte créé » : une seconde et demie pour marquer le passage, sans
     prétendre qu'un email de validation est parti. Passable d'un clic. */
  function obWelcomeScreen() {
    var name = obWelcome && obWelcome.name;
    var token = {};
    obWelcomeToken = token;
    function next() {
      if (obWelcomeToken !== token) return;
      obWelcomeToken = null;
      obWelcome = null;
      obTransition(function () {}, "fwd");
    }
    obKeys = { back: null, primary: next };
    var check = el("div", { class: "ob-welcome-check", "aria-hidden": "true" }, [obCheck(44)]);
    var stage = [
      check,
      el("h1", { class: "ob-title ob-welcome-title", id: "ob-step-title", tabindex: "-1" }, [
        el("span", { text: "Compte créé," }),
        el("span", { class: "ob-welcome-name", text: name ? "bienvenue " + name + "." : "bienvenue." })
      ]),
      el("p", { class: "ob-lede", text: "Votre compte est enregistré sur cet appareil. Place à votre formule, puis à votre logement." }),
      el("div", { class: "ob-actions" }, [obCta("Choisir ma formule", { onclick: next })])
    ];
    setTimeout(function () {
      var r = check.getBoundingClientRect();
      if (r.width) obSpark(r.left + r.width / 2, r.top + r.height / 2, { count: 28, power: 6 });
    }, 380);
    setTimeout(next, obCalm() ? 2600 : 1800);
    return obShell("welcome", el("header", { class: "ob-head" }, [logo(22)]), stage, null);
  }

  /* ═══ Choix de formule ══════════════════════════════════════════════ */

  var FREE_FEATURES = [
    "Objets illimités", "Pièces, zones et meubles illimités",
    "Recherche instantanée tolérante aux fautes", "Mots-clés et métadonnées",
    "Photo par objet", "Foyer partagé jusqu'à 5 membres",
    "Installation sur l'écran d'accueil", "Export de vos données à tout moment"
  ];
  var PAID_FEATURES = [
    "Tout le plan Libre, sans limite", "Scan Éclair : référencement par la caméra",
    "Plan 2D/3D interactif du logement", "Recherche en langage naturel",
    "Alertes péremption, garantie et prêts", "Accès délégué proche aidant",
    "Historique et journal des déplacements", "Membres du foyer illimités",
    "Export PDF assurance et sinistre", "Support prioritaire"
  ];
  var OB_PLANS = [
    { id: "free", name: "Libre", price: "0 €", suffix: "pour toujours", pitch: "Tout ce qu'il faut pour ne plus jamais chercher.", features: FREE_FEATURES },
    { id: "premium", name: "Éclair", price: "0 €", suffix: "pendant la bêta, puis 9 €/mois", pitch: "Pour référencer vite et chercher encore plus vite.", features: PAID_FEATURES, tag: "Offert pendant la bêta" }
  ];

  /* Deux cartes en groupe radio : flèches pour passer de l'une à l'autre,
     Espace pour choisir, Entrée pour valider (branché par l'étape). */
  function obPlanChooser(initial, onChange) {
    var chosen = initial === "premium" ? "premium" : "free";
    var cards = {};

    function set(id, event) {
      if (id === chosen && !event) return;
      chosen = id;
      OB_PLANS.forEach(function (plan) {
        var on = plan.id === id;
        cards[plan.id].setAttribute("aria-checked", on ? "true" : "false");
        cards[plan.id].tabIndex = on ? 0 : -1;
      });
      if (event) obBurstFrom(cards[id], event, { count: id === "premium" ? 26 : 14, power: id === "premium" ? 6 : 4 });
      if (onChange) onChange(id);
    }

    var group = el("div", {
      class: "ob-plans", role: "radiogroup", "aria-label": "Formule",
      onkeydown: function (event) {
        var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
        if (!keys[event.key]) return;
        event.preventDefault();
        var next = chosen === "free" ? "premium" : "free";
        set(next, null);
        cards[next].focus();
      }
    });

    OB_PLANS.forEach(function (plan) {
      var card = el("div", {
        class: "ob-plan ob-plan--" + plan.id, role: "radio",
        tabindex: chosen === plan.id ? "0" : "-1",
        "aria-checked": chosen === plan.id ? "true" : "false",
        "aria-labelledby": "ob-plan-" + plan.id,
        onclick: function (event) { if (chosen !== plan.id) set(plan.id, event); },
        onkeydown: function (event) {
          if (event.key === " ") { event.preventDefault(); if (chosen !== plan.id) set(plan.id, event); }
        }
      }, [
        el("span", { class: "ob-plan-shine", "aria-hidden": "true" }),
        el("div", { class: "ob-plan-top" }, [
          el("p", { class: "ob-plan-name", id: "ob-plan-" + plan.id }, [
            plan.name,
            plan.tag ? el("span", { class: "ob-plan-tag", text: plan.tag }) : null
          ]),
          el("span", { class: "ob-tick", "aria-hidden": "true" }, [obCheck(16)])
        ]),
        el("p", { class: "ob-plan-price" }, [el("span", { class: "tnum", text: plan.price }), el("small", { text: plan.suffix })]),
        el("p", { class: "ob-plan-pitch", text: plan.pitch }),
        el("ul", { class: "ob-plan-feats" }, plan.features.map(function (feature) {
          return el("li", {}, [icon("check", 14), el("span", { text: feature })]);
        }))
      ]);
      obTilt(card, 8);
      cards[plan.id] = card;
      group.appendChild(card);
    });

    return { node: group, get: function () { return chosen; }, set: set };
  }

  var OB_PLAN_NOTE = "Bêta : l'Éclair est offert aux early adopters. Aucune carte n'est demandée et rien n'est débité. Vous serez prévenu avant toute facturation.";

  function obPlanLabel(id) { return id === "premium" ? "Activer l'Éclair offert" : "Continuer avec Libre"; }

  /* Conservé pour un changement de formule hors du parcours (réglages) :
     les mêmes cartes, dans une feuille. */
  function planSheet() {
    var button;
    var chooser = obPlanChooser(state.plan, function (id) { button.textContent = obPlanLabel(id); });
    button = el("button", {
      class: "btn btn-lg btn-volt", type: "button", style: "width:100%",
      onclick: function () {
        state.plan = chooser.get();
        state.planSeen = true;
        save();
        closeSheet();
        render();
        if (state.plan === "premium") toast("Éclair activé : offert pendant la bêta.");
      },
      text: obPlanLabel(chooser.get())
    });
    sheet({
      title: "Choisissez votre formule",
      wide: true,
      onClose: function () { state.planSeen = true; save(); render(); },
      body: [chooser.node, el("p", { class: "ob-fine", text: OB_PLAN_NOTE })],
      foot: [button]
    });
  }

  /* ═══ Écran 2 — Onboarding ══════════════════════════════════════════ */

  var wiz = null;

  function obSteps() {
    return ["plan", "type", "name", "floors", "rooms", "rename", "furniture"].filter(function (step) {
      if (step === "plan") return wiz.withPlan;
      // Appartement et studio sautent l'étape, sauf s'ils ont une cave ou un
      // box en sous-sol : il faut alors pouvoir placer ce niveau.
      if (step === "floors") return !(wiz.type === "studio" || wiz.type === "apartment") || wiz.basement;
      return true;
    });
  }

  /* Niveaux du logement en cours de configuration, du plus bas au plus haut. */
  function obWizLevels() {
    var multi = wiz.type === "house" || wiz.type === "other" || wiz.basement;
    var F = multi ? Math.max(1, Math.min(8, wiz.floors)) : 1;
    var list = wiz.basement ? [-1] : [];
    for (var i = 0; i < F; i++) list.push(i);
    return list;
  }

  /* Une pièce dont le niveau disparaît (moins d'étages, sous-sol décoché)
     descend au plus proche : jamais de pièce hors du logement. */
  function obClampFloors() {
    var list = obWizLevels(), top = list[list.length - 1], bottom = list[0];
    wiz.rooms.forEach(function (room) {
      if (typeof room.floor !== "number") room.floor = 0;
      if (room.floor > top) room.floor = top;
      if (room.floor < bottom) room.floor = bottom;
    });
    if (list.indexOf(wiz.activeFloor) === -1) wiz.activeFloor = list.indexOf(0) !== -1 ? 0 : list[0];
  }

  function obFloorName(f) { return f < 0 ? "Sous-sol" : f === 0 ? "Rez-de-chaussée" : f === 1 ? "1er étage" : f + "e étage"; }
  function obFloorShort(f) { return f < 0 ? "Sous-sol" : f === 0 ? "RDC" : f === 1 ? "1er" : f + "e"; }
  function obAtFloor(f) { return f < 0 ? "au sous-sol" : f === 0 ? "au rez-de-chaussée" : "au " + obFloorName(f); }

  /* Le niveau d'une pièce à l'ajout. Le niveau choisi explicitement prime ;
     sans choix, des défauts sensés : grenier tout en haut, cave au sous-sol,
     garage et extérieurs au rez-de-chaussée. */
  var OB_AT_GROUND = { garage: 1, jardin: 1, terrasse: 1, cabanon: 1 };
  function obFloorFor(key) {
    var list = obWizLevels();
    if (list.length === 1 || wiz.floorPicked) return wiz.activeFloor;
    if (key === "grenier") return list[list.length - 1];
    if ((key === "cave" || key === "soussol") && list[0] < 0) return list[0];
    if (OB_AT_GROUND[key]) return 0;
    return wiz.activeFloor;
  }

  /* Un interrupteur accessible (role="switch"), mis à jour en place. */
  function obSwitch(label, sub, on, onChange, extraClass) {
    var node = el("button", {
      class: "ob-switch-row" + (extraClass ? " " + extraClass : ""), type: "button", role: "switch",
      "aria-checked": on ? "true" : "false",
      onclick: function (event) {
        var next = node.getAttribute("aria-checked") !== "true";
        node.setAttribute("aria-checked", next ? "true" : "false");
        onChange(next, event);
      }
    }, [
      el("span", { class: "ob-switch-txt" }, [
        el("span", { class: "ob-switch-lbl", text: label }),
        sub ? el("span", { class: "ob-switch-sub", text: sub }) : null
      ]),
      el("span", { class: "ob-switch", "aria-hidden": "true" }, [el("i")])
    ]);
    return node;
  }

  function obNameIdeas(type) {
    var first = obFirstName(state.account && state.account.name);
    var ideas = {
      apartment: ["L'appart", "Mon appartement", "La maison"],
      house: ["La maison", "La maison de famille", "La maison de vacances"],
      studio: ["Le studio", "Mon studio", "Le pied-à-terre"],
      other: ["La maison", "Le loft", "La résidence secondaire"]
    }[type] || ["La maison"];
    return (first ? ["Chez " + first] : []).concat(ideas);
  }

  function obFloorsText(n) {
    if (n <= 1) return "Plain-pied : tout est au même niveau.";
    if (n === 2) return "Rez-de-chaussée et un étage.";
    return "Rez-de-chaussée et " + (n - 1) + " étages.";
  }

  /* La petite maison de l'étape « niveaux » : les étages s'empilent, le
     toit se soulève pour laisser entrer le nouveau. */
  function obHouseArt(n, delta, basement, basementNew) {
    var h = Math.min(22, 116 / n), W = 84, X = 18, base = 150;
    var top = base - n * h;
    var svg = obSvg("svg", { class: "ob-house-svg", viewBox: "0 0 120 176", "aria-hidden": "true", focusable: "false" });
    // Le sous-sol : sous la ligne du sol, en pointillés — enterré, mais là.
    if (basement) {
      var under = obSvg("g", { class: "ob-house-under" + (basementNew ? " is-new" : "") });
      under.appendChild(obSvg("rect", { x: X + 4, y: base + 3, width: W - 8, height: 17, rx: 1.5 }));
      under.appendChild(obSvg("rect", { class: "ob-house-win is-lit", x: X + 14, y: base + 8, width: 10, height: 5, rx: 1 }));
      under.appendChild(obSvg("path", { d: "M" + (X + W - 26) + " " + (base + 18) + "h6v-4h6v-4h6", class: "ob-house-steps" }));
      svg.appendChild(under);
    }
    svg.appendChild(obSvg("path", { class: "ob-house-ground", d: "M4 " + base + "H116" }));
    for (var i = 0; i < n; i++) {
      var y = base - (i + 1) * h;
      var floor = obSvg("g", { class: "ob-house-floor" + (delta > 0 && i === n - 1 ? " is-new" : "") });
      floor.appendChild(obSvg("rect", { x: X, y: y.toFixed(1), width: W, height: h.toFixed(1), rx: 1.5 }));
      var wh = Math.max(3, h * 0.36), wy = y + (h - wh) / 2;
      for (var w = 0; w < 3; w++) {
        if (i === 0 && w === 1) {
          floor.appendChild(obSvg("rect", { class: "ob-house-door", x: X + W / 2 - 5, y: (y + h * 0.3).toFixed(1), width: 10, height: (h * 0.7).toFixed(1), rx: 1 }));
          continue;
        }
        var lit = (i * 3 + w * 5 + n) % 4 === 0;
        floor.appendChild(obSvg("rect", { class: "ob-house-win" + (lit ? " is-lit" : ""), x: X + 12 + w * 25, y: wy.toFixed(1), width: 10, height: wh.toFixed(1), rx: 1 }));
      }
      svg.appendChild(floor);
    }
    svg.appendChild(obSvg("path", {
      class: "ob-house-roof" + (delta > 0 ? " is-lift" : delta < 0 ? " is-drop" : ""),
      style: "--h:" + h.toFixed(1) + "px",
      d: "M" + (X - 7) + " " + top.toFixed(1) + " L60 " + (top - 30).toFixed(1) + " L" + (X + W + 7) + " " + top.toFixed(1) + "Z"
    }));
    return svg;
  }

  function screenOnboarding() {
    if (obWelcome) return obWelcomeScreen();
    if (!wiz) {
      var first = obFirstName(state.account ? state.account.name : "");
      wiz = {
        step: 0,
        withPlan: !state.planSeen && !cloud,   // en ligne, la formule est celle du compte
        type: "apartment",
        name: first ? "Chez " + first : "La maison",
        floors: 1,
        basement: false,      // un niveau -1 : cave, box, sous-sol
        activeFloor: 0,       // le niveau où vont les pièces ajoutées
        floorPicked: false,   // choisi explicitement : il prime sur les défauts
        rooms: [],
        custom: ""
      };
    }
    obClampFloors();

    var steps = obSteps();
    wiz.step = Math.max(0, Math.min(steps.length - 1, wiz.step));
    var current = steps[wiz.step];
    var sideNode = null;

    function go(delta) {
      obTransition(function () {
        wiz.step = Math.max(0, Math.min(obSteps().length - 1, wiz.step + delta));
      }, delta < 0 ? "back" : "fwd");
    }

    function data() {
      var levels = obWizLevels();
      return { name: wiz.name.trim() || "La maison", type: wiz.type, floors: levels.length, levels: levels, rooms: wiz.rooms };
    }

    function side(band) {
      sideNode = obSidePanel(data(), { band: band, labels: true, activeFloor: current === "rooms" ? wiz.activeFloor : null });
      return sideNode;
    }

    /* Redessine l'aperçu sans toucher à l'étape : seules les pièces
       nouvelles tombent, les autres restent en place. */
    function repaintSide(opts) {
      if (!sideNode || !sideNode.isConnected) return;
      var fresh = obSidePanel(data(), Object.assign({ band: sideNode.classList.contains("ob-side--band"), labels: true, activeFloor: current === "rooms" ? wiz.activeFloor : null }, opts || {}));
      sideNode.replaceChildren.apply(sideNode, Array.prototype.slice.call(fresh.childNodes));
    }

    /* Retire UN exemplaire précis, puis renumérote ce qui reste : supprimer
       « Chambre 2 » sur trois chambres ne doit pas laisser un trou entre
       « Chambre » et « Chambre 3 ». Les pièces renommées à la main sont
       laissées telles quelles — on ne réécrit pas le choix de l'utilisateur.
       Ne dessine rien : l'appelant repeint en place ou relance le rendu. */
    function removeRoomById(id, key) {
      wiz.rooms = wiz.rooms.filter(function (r) { return r.id !== id; });
      if (!key) return;

      var preset = null;
      for (var i = 0; i < ROOMS.length; i++) if (ROOMS[i].key === key) preset = ROOMS[i];
      if (!preset) return;

      var remaining = wiz.rooms.filter(function (r) { return r.key === key; });
      var allDefault = remaining.every(function (r) { return r.label.indexOf(preset.label) === 0; });
      if (allDefault) {
        remaining.forEach(function (room, index) {
          room.label = index === 0 ? preset.label : preset.label + " " + (index + 1);
        });
      }
    }

    function addRoom(preset) {
      var existing = wiz.rooms.filter(function (r) { return r.key === preset.key; }).length;
      var room = {
        id: uid("r"), key: preset.key, icon: preset.icon, kind: preset.kind,
        // Un deuxième exemplaire est numéroté d'office : « Chambre 2 » est plus
        // utile qu'une deuxième « Chambre » indistinguable.
        label: existing === 0 ? preset.label : preset.label + " " + (existing + 1),
        floor: obFloorFor(preset.key),
        // Aucun meuble d'office : l'étape Meubles propose, on choisit.
        furniture: []
      };
      wiz.rooms.push(room);
      return room;
    }

    function commit() {
      var levels = obWizLevels();
      state.household = { name: wiz.name.trim() || "La maison", type: wiz.type, floors: levels.filter(function (f) { return f >= 0; }).length, basement: levels[0] < 0 };
      state.locations = [];
      state.items = [];

      // Le vrai niveau de chaque pièce (-1, 0, 1…), et l'icône de chaque
      // rangement : celle du catalogue, devinée, ou choisie.
      wiz.rooms.forEach(function (room) {
        var parent = { id: uid("loc"), parentId: null, kind: room.kind, name: room.label.trim() || "Pièce", icon: room.icon, floor: typeof room.floor === "number" ? room.floor : 0 };
        state.locations.push(parent);
        room.furniture.forEach(function (f) {
          state.locations.push({ id: uid("loc"), parentId: parent.id, kind: "furniture", name: furnLabel(f).trim() || "Rangement", icon: typeof f === "string" ? null : (f.icon || null), floor: parent.floor });
        });
      });

      state.screen = "app";
      state.tab = "search";
      wiz = null;
      obKeys = null;
      save();
      render();
      window.scrollTo(0, 0);
    }

    /* La fin : le logement se matérialise, une gerbe d'étincelles, puis
       l'application. Bref, et passable d'un clic. */
    function finish(event, button) {
      var furn = 0;
      wiz.rooms.forEach(function (room) { furn += room.furniture.length; });
      var d = data();
      if (button) obBurstFrom(button, event, { count: 20, up: true });

      var done = false;
      function leave() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        overlay.classList.add("is-leaving");
        setTimeout(commit, obCalm() ? 0 : 260);
      }

      var enterBtn = obCta("Ouvrir mon inventaire", { onclick: leave });
      var overlay = el("div", { class: "ob-celebrate", role: "dialog", "aria-modal": "true", "aria-labelledby": "ob-cel-title" }, [
        el("div", { class: "ob-cel-model" }, [obModel(d, { noDrop: true, materialize: true, labels: false })]),
        // « prend vie » : neutre, quel que soit le genre du nom choisi.
        el("h2", { class: "ob-cel-title", id: "ob-cel-title", text: d.name + " prend vie." }),
        el("p", { class: "ob-cel-sub", text: plural(wiz.rooms.length, "pièce", "pièces") + ", " + plural(furn, "rangement", "rangements") + ". Il ne reste qu'à y ranger vos objets." }),
        enterBtn
      ]);
      overlay.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); leave(); } });
      var host = document.querySelector(".ob") || document.body;
      host.appendChild(overlay);
      enterBtn.focus({ preventScroll: true });
      obAnnounce(d.name + " prend vie. " + plural(wiz.rooms.length, "pièce", "pièces") + ".");

      if (!obCalm()) {
        [0, 260, 620].forEach(function (delay, n) {
          setTimeout(function () {
            if (done) return;
            var r = overlay.querySelector(".ob-cel-model").getBoundingClientRect();
            obSpark(r.left + r.width * (0.3 + n * 0.2), r.top + r.height * 0.45, { count: 34, power: 7, up: true, confetti: true });
          }, 380 + delay);
        });
      }
      var timer = setTimeout(leave, obCalm() ? 4000 : 3400);
    }

    obKeys = { back: wiz.step > 0 ? function () { go(-1); } : null, primary: null };

    var total = steps.length;
    var head = el("header", { class: "ob-head" }, [
      logo(22),
      el("div", { class: "ob-head-right" }, [
        wiz.step > 0 ? el("button", {
          class: "ob-back", type: "button", "aria-keyshortcuts": "Escape",
          onclick: function () { go(-1); }
        }, [icon("arrow-left", 15), el("span", { text: "Retour" })]) : null,
        el("p", { class: "ob-count tnum", text: "Étape " + (wiz.step + 1) + " sur " + total })
      ])
    ]);

    /* La barre « éclair » : elle repart de là où elle était et file vers
       la nouvelle valeur, étincelle en tête. */
    var ratio = (wiz.step + 1) / total;
    var from = typeof screenOnboarding.last === "number" ? screenOnboarding.last : 0;
    var fill = el("i", { class: "ob-progress-fill" });
    var progress = el("div", {
      class: "ob-progress", role: "progressbar", "aria-label": "Progression de la configuration",
      style: "--p:" + from.toFixed(4),
      "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(wiz.step + 1),
      "aria-valuetext": "Étape " + (wiz.step + 1) + " sur " + total
    }, [fill]);
    screenOnboarding.last = ratio;
    requestAnimationFrame(function () { requestAnimationFrame(function () { progress.style.setProperty("--p", ratio.toFixed(4)); }); });

    function title(text, children) {
      return el("h1", { class: "ob-title", id: "ob-step-title", tabindex: "-1" }, children || [text]);
    }
    function lede(text) { return el("p", { class: "ob-lede", text: text }); }

    var stage, sidePanel = null;

    /* ─── Formule ─── */
    if (current === "plan") {
      var planCta;
      var chooser = obPlanChooser(state.plan, function (id) {
        planCta.querySelector(".ob-cta-label").textContent = obPlanLabel(id);
      });
      var confirmPlan = function (event) {
        state.plan = chooser.get();
        state.planSeen = true;
        save();
        if (state.plan === "premium") {
          obBurstFrom(planCta, event, { count: 30, power: 7, up: true });
          toast("Éclair activé : offert pendant la bêta.");
        }
        go(1);
      };
      planCta = obCta(obPlanLabel(chooser.get()), { onclick: confirmPlan });
      obKeys.primary = function () { confirmPlan(null); };
      stage = [
        title("Choisissez votre formule"),
        lede("Commencez gratuitement, passez à l'Éclair quand vous voulez. Sans engagement."),
        chooser.node,
        el("div", { class: "ob-actions ob-actions--plan ob-actions--sticky" }, [planCta]),
        el("div", { class: "ob-plan-notes" }, [
          el("p", { class: "ob-fine", text: OB_PLAN_NOTE }),
          el("p", { class: "ob-fine", text: "Vous pourrez changer de formule à tout moment depuis les réglages." })
        ])
      ];
    }

    /* ─── Type de logement ─── */
    else if (current === "type") {
      var busy = false;
      var tiles = [];
      var pick = function (value, node, event) {
        if (busy) return;
        busy = true;
        wiz.type = value;
        if (value === "apartment" || value === "studio") wiz.floors = 1;
        tiles.forEach(function (tile) { tile.setAttribute("aria-pressed", tile === node ? "true" : "false"); });
        obBurstFrom(node, event, { count: 24, power: 6 });
        repaintSide();
        setTimeout(function () { go(1); }, obCalm() ? 0 : 440);
      };
      obKeys.primary = function () {
        var on = tiles.filter(function (t) { return t.getAttribute("aria-pressed") === "true"; })[0];
        if (on) pick(on.getAttribute("data-value"), on, null);
      };
      stage = [
        title("Vous habitez dans…"),
        lede("Cela nous sert à proposer les bons espaces. Touchez votre logement pour continuer."),
        el("div", { class: "ob-types", role: "group", "aria-label": "Type de logement" }, [
          ["apartment", "h-appart", "Un appartement", "Un seul niveau"],
          ["house", "h-maison", "Une maison", "Étages, cave, garage"],
          ["studio", "h-studio", "Un studio", "Une pièce principale"],
          ["other", "h-autre", "Autre chose", "Loft, péniche, local"]
        ].map(function (option) {
          var tile = el("button", {
            class: "ob-type", type: "button", "data-value": option[0],
            "aria-pressed": wiz.type === option[0] ? "true" : "false",
            onclick: function (event) { pick(option[0], tile, event); }
          }, [
            el("span", { class: "ob-type-shine", "aria-hidden": "true" }),
            el("span", { class: "ob-type-ic" }, [sym(option[1], 40)]),
            el("span", { class: "ob-type-name", text: option[2] }),
            el("span", { class: "ob-type-sub", text: option[3] }),
            el("span", { class: "ob-tick", "aria-hidden": "true" }, [obCheck(15)])
          ]);
          tiles.push(tile);
          return obTilt(tile, 12);
        })),
        /* Discret, mais avant le choix : pour un appartement, c'est ce qui
           décide si l'étape « niveaux » apparaît. */
        obSwitch("J'ai une cave ou un box en sous-sol", "Il deviendra le niveau −1 de votre logement.", wiz.basement, function (on) {
          wiz.basement = on;
          obClampFloors();
          repaintSide();
          obAnnounce(on ? "Sous-sol ajouté." : "Sous-sol retiré.");
        }, "ob-switch-row--quiet")
      ];
      sidePanel = side(false);
    }

    /* ─── Nom ─── */
    else if (current === "name") {
      var typing = 0;
      var chips = [];
      var nameInput = el("input", {
        class: "ob-bigname", id: "ob-name", value: wiz.name, maxlength: 80, autocomplete: "off",
        spellcheck: "false", "aria-labelledby": "ob-step-title", "aria-describedby": "ob-name-help",
        "data-ob-focus": "1", "data-ob-own-enter": "1",
        oninput: function (event) { clearInterval(typing); wiz.name = event.target.value; syncName(); },
        onkeydown: function (event) { if (event.key === "Enter") { event.preventDefault(); go(1); } }
      });
      var syncName = function () {
        var sign = sideNode && sideNode.querySelector(".ob-sign-name");
        if (sign) sign.textContent = nameInput.value.trim() || "La maison";
        chips.forEach(function (chip) { chip.setAttribute("aria-pressed", chip.getAttribute("data-value") === wiz.name ? "true" : "false"); });
      };
      obKeys.primary = function () { go(1); };
      stage = [
        title("Comment appelez-vous ce lieu ?"),
        lede("C'est le nom de votre foyer, visible par les membres que vous inviterez."),
        el("div", { class: "ob-namebox" }, [nameInput, el("span", { class: "ob-name-line", "aria-hidden": "true" })]),
        el("div", { class: "ob-ideas", role: "group", "aria-label": "Suggestions de nom", id: "ob-name-help" }, obNameIdeas(wiz.type).map(function (idea) {
          var chip = el("button", {
            class: "ob-idea", type: "button", "data-value": idea,
            "aria-pressed": wiz.name === idea ? "true" : "false",
            onclick: function (event) {
              clearInterval(typing);
              wiz.name = idea;
              obBurstFrom(chip, event, { count: 8, power: 3 });
              // Le focus revient au champ : Entrée continue, on peut retoucher le nom.
              // Pas au doigt : le clavier virtuel masquerait le bouton Continuer.
              if (obFine()) nameInput.focus({ preventScroll: true });
              if (obCalm()) { nameInput.value = idea; syncName(); return; }
              // Le nom s'écrit sous vos yeux, lettre à lettre.
              var i = 0;
              typing = setInterval(function () {
                i += 1;
                nameInput.value = idea.slice(0, i);
                var sign = sideNode && sideNode.querySelector(".ob-sign-name");
                if (sign) sign.textContent = nameInput.value;
                if (i >= idea.length) { clearInterval(typing); syncName(); }
              }, 28);
              chips.forEach(function (c) { c.setAttribute("aria-pressed", c === chip ? "true" : "false"); });
            }
          }, [idea]);
          chips.push(chip);
          return chip;
        })),
        el("div", { class: "ob-actions" }, [obCta("Continuer", { onclick: function () { go(1); } })])
      ];
      sidePanel = side(false);
    }

    /* ─── Niveaux ─── */
    else if (current === "floors") {
      var reel = el("span", { class: "ob-odo-reel", style: "--n:" + wiz.floors }, [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) {
        return el("span", { text: String(n) });
      }));
      var odo = el("span", { class: "ob-odo tnum", "aria-hidden": "true" }, [reel]);
      var unit = el("span", { class: "ob-odo-unit", "aria-hidden": "true", text: wiz.floors > 1 ? "niveaux" : "niveau" });
      var out = el("output", { class: "ob-sr", "aria-live": "polite", text: plural(wiz.floors, "niveau", "niveaux") });
      var descText = function () { return obFloorsText(wiz.floors) + (wiz.basement ? " Plus un sous-sol." : ""); };
      var desc = el("p", { class: "ob-floors-desc", text: descText() });
      var art = el("div", { class: "ob-house" }, [obHouseArt(wiz.floors, 0, wiz.basement)]);
      var basementSwitch = obSwitch("Sous-sol, niveau −1", "Cave, box ou garage enterré.", wiz.basement, function (on, event) {
        wiz.basement = on;
        obClampFloors();
        desc.textContent = descText();
        art.replaceChildren(obHouseArt(wiz.floors, 0, on, on));
        repaintSide({ levelNew: on ? -1 : null });
        if (on) obBurstFrom(basementSwitch, event, { count: 8, power: 3 });
        obAnnounce(on ? "Sous-sol ajouté, niveau moins un." : "Sous-sol retiré.");
      });
      var minus, plus;
      var setFloors = function (n) {
        n = Math.max(1, Math.min(8, n));
        if (n === wiz.floors) return;
        var delta = n > wiz.floors ? 1 : -1;
        wiz.floors = n;
        reel.style.setProperty("--n", n);
        unit.textContent = n > 1 ? "niveaux" : "niveau";
        out.textContent = plural(n, "niveau", "niveaux");
        obClampFloors();
        desc.textContent = descText();
        var focused = document.activeElement;
        minus.disabled = n <= 1;
        plus.disabled = n >= 8;
        // Un bouton qui se désactive sous le focus le perdrait : on le passe à l'autre.
        if (focused === minus && minus.disabled) plus.focus();
        if (focused === plus && plus.disabled) minus.focus();
        art.replaceChildren(obHouseArt(n, delta, wiz.basement));
        obPop(odo);
        repaintSide({ levelNew: delta > 0 ? n - 1 : null });
      };
      minus = el("button", { class: "ob-round", type: "button", "aria-label": "Retirer un niveau", disabled: wiz.floors <= 1, onclick: function () { setFloors(wiz.floors - 1); } }, [icon("minus", 20)]);
      plus = el("button", { class: "ob-round", type: "button", "aria-label": "Ajouter un niveau", disabled: wiz.floors >= 8, onclick: function (event) { setFloors(wiz.floors + 1); obBurstFrom(plus, event, { count: 8, power: 3 }); } }, [icon("plus", 20)]);
      obKeys.primary = function () { go(1); };
      stage = [
        title("Combien de niveaux ?"),
        lede("Rez-de-chaussée, étages et combles s'ils vous servent de rangement. Le sous-sol se règle juste en dessous."),
        el("div", { class: "ob-floors" }, [
          el("div", { class: "ob-floors-ctrl" }, [
            el("div", {
              class: "ob-stepper", role: "group", "aria-label": "Nombre de niveaux",
              onkeydown: function (event) {
                if (event.key === "ArrowUp" || event.key === "ArrowRight" || event.key === "+") { event.preventDefault(); setFloors(wiz.floors + 1); }
                if (event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "-") { event.preventDefault(); setFloors(wiz.floors - 1); }
              }
            }, [minus, el("span", { class: "ob-odo-wrap" }, [odo, unit]), plus, out]),
            desc,
            basementSwitch
          ]),
          art
        ]),
        el("div", { class: "ob-actions" }, [obCta("Continuer", { onclick: function () { go(1); } })])
      ];
      sidePanel = side(false);
    }

    /* ─── Pièces ─── */
    else if (current === "rooms") {
      var tilesByKey = {};
      var tray = el("div", { class: "ob-trays" });
      var levels = obWizLevels();

      /* Le niveau actif : les pièces touchées y vont. Segment de gauche à
         droite, du plus bas au plus haut, comme on monte l'escalier. */
      var floorHint = el("p", { class: "ob-floor-hint", "aria-live": "polite" });
      var paintFloorHint = function () {
        floorHint.replaceChildren(
          "Les pièces touchées s'ajoutent ", el("strong", { text: obAtFloor(wiz.activeFloor) }),
          wiz.floorPicked || levels.length < 2 ? "." : ". Grenier, cave et garage se placent d'eux-mêmes."
        );
      };
      var floorButtons = [];
      var pickFloor = function (f, focus) {
        wiz.activeFloor = f;
        wiz.floorPicked = true;
        floorButtons.forEach(function (b) {
          var on = +b.getAttribute("data-floor") === f;
          b.setAttribute("aria-checked", on ? "true" : "false");
          b.tabIndex = on ? 0 : -1;
          if (on && focus) b.focus();
        });
        paintFloorHint();
        repaintSide();
      };
      var floorBar = levels.length > 1 ? el("div", {
        class: "ob-floorbar", role: "radiogroup", "aria-label": "Niveau où ajouter les pièces",
        onkeydown: function (event) {
          var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
          if (!step) return;
          event.preventDefault();
          var i = levels.indexOf(wiz.activeFloor);
          pickFloor(levels[Math.max(0, Math.min(levels.length - 1, i + step))], true);
        }
      }, levels.map(function (f) {
        var b = el("button", {
          class: "ob-floorbtn", type: "button", role: "radio", "data-floor": f,
          "aria-checked": f === wiz.activeFloor ? "true" : "false", tabindex: f === wiz.activeFloor ? "0" : "-1",
          "aria-label": obFloorName(f),
          onclick: function () { pickFloor(f, false); }
        }, [el("span", { text: obFloorShort(f) })]);
        floorButtons.push(b);
        return b;
      })) : null;
      paintFloorHint();
      var trayHead = el("p", { class: "ob-tray-head" });
      var bagCount = el("span", { class: "ob-bag-n tnum" });
      var bag = el("span", { class: "ob-bag", "aria-hidden": "true" }, [icon("box", 16), bagCount]);
      var roomsCta = obCta("Continuer", { onclick: function () { if (wiz.rooms.length) go(1); } });
      var hint = el("p", { class: "ob-hint", text: "Sélectionnez au moins une pièce pour continuer." });
      var customInput, customAdd;

      var countOf = function (key) { return wiz.rooms.filter(function (r) { return r.key === key; }).length; };
      var ariaOf = function (preset, count) {
        return count > 0 ? "Ajouter : " + preset.label + " (" + count + " déjà)" : "Ajouter : " + preset.label;
      };

      var chipOf = function (room, isNew) {
        var node = el("span", { class: "ob-chip" + (isNew ? " is-new" : ""), role: "listitem", "data-id": room.id }, [
          sym(room.icon, 16),
          el("span", { class: "ob-chip-lbl", text: room.label }),
          el("button", {
            class: "ob-x", type: "button", "aria-label": "Retirer " + room.label, title: "Retirer",
            onclick: function () { dropRoom(room, node); }
          }, [icon("x", 13)])
        ]);
        return node;
      };

      var paintRooms = function (newId, popKey) {
        ROOMS.forEach(function (preset) {
          var tile = tilesByKey[preset.key], count = countOf(preset.key);
          tile.node.classList.toggle("is-on", count > 0);
          tile.node.setAttribute("aria-label", ariaOf(preset, count));
          tile.badge.textContent = count ? "×" + count : "";
          if (popKey === preset.key) obPop(tile.badge);
        });
        // Le panier se lit comme une coupe : un groupe par niveau, du haut vers le bas.
        var groups = levels.length > 1 ? levels.slice().reverse() : [null];
        tray.replaceChildren.apply(tray, wiz.rooms.length
          ? groups.map(function (f) {
              var here = f === null ? wiz.rooms : wiz.rooms.filter(function (r) { return r.floor === f; });
              if (!here.length) return null;
              return el("div", { class: "ob-tray-group" }, [
                f === null ? null : el("p", { class: "ob-tray-fl" }, [obFloorName(f), el("span", { class: "tnum", text: " · " + here.length })]),
                el("div", { class: "ob-tray", role: "list", "aria-label": f === null ? "Pièces sélectionnées" : "Pièces " + obAtFloor(f) },
                  here.map(function (room) { return chipOf(room, room.id === newId); }))
              ]);
            }).filter(Boolean)
          : [el("span", { class: "ob-tray-empty", text: "Rien pour l'instant. Touchez une pièce ci-dessus." })]);
        trayHead.textContent = wiz.rooms.length ? plural(wiz.rooms.length, "pièce sélectionnée", "pièces sélectionnées") : "Votre sélection";
        bagCount.textContent = String(wiz.rooms.length);
        roomsCta.disabled = wiz.rooms.length === 0;
        hint.hidden = wiz.rooms.length > 0;
        repaintSide();
      };

      var dropRoom = function (room, node) {
        var index = wiz.rooms.indexOf(room);
        node.classList.add("is-out");
        setTimeout(function () {
          removeRoomById(room.id, room.key);
          paintRooms(null, room.key);
          var xs = tray.querySelectorAll(".ob-x");
          var next = xs[Math.min(index, xs.length - 1)];
          (next || customInput).focus({ preventScroll: true });
          obAnnounce("Pièce retirée : " + room.label + ".");
        }, obCalm() ? 0 : 170);
      };

      var addCustom = function () {
        var label = wiz.custom.trim();
        if (!label) return;
        var room = { id: uid("r"), key: null, icon: "r-piece", kind: "room", label: label.slice(0, 80), floor: wiz.activeFloor, furniture: [] };
        wiz.rooms.push(room);
        wiz.custom = "";
        customInput.value = "";
        customAdd.disabled = true;
        paintRooms(room.id, null);
        obAnnounce("Pièce ajoutée : " + room.label + ".");
      };

      customAdd = el("button", { class: "ob-line-btn", type: "button", disabled: !wiz.custom.trim(), onclick: addCustom }, [icon("plus", 15), "Ajouter"]);
      customInput = el("input", {
        class: "ob-input ob-input--plain", placeholder: "Autre pièce ou zone…", maxlength: 80,
        "aria-label": "Ajouter une pièce qui n'est pas dans la liste", value: wiz.custom, "data-ob-own-enter": "1",
        oninput: function (event) {
          wiz.custom = event.target.value;
          // Mis à jour EN PLACE : redessiner à chaque frappe ferait perdre le curseur.
          customAdd.disabled = !wiz.custom.trim();
        },
        onkeydown: function (event) {
          if (event.key !== "Enter") return;
          event.preventDefault();
          addCustom();
        }
      });

      var grid = el("div", { class: "ob-rooms" }, ROOMS.map(function (preset) {
        var count = countOf(preset.key);
        var badge = el("span", { class: "ob-room-n tnum", "aria-hidden": "true", text: count ? "×" + count : "" });
        var ic = el("span", { class: "ob-room-ic" }, [sym(preset.icon, 26)]);
        var node = el("button", {
          class: "ob-room" + (count ? " is-on" : ""), type: "button", "aria-label": ariaOf(preset, count),
          onclick: function (event) {
            var room = addRoom(preset);
            paintRooms(room.id, preset.key);
            obPop(node);
            obBurstFrom(node, event, { count: 10, power: 3.5 });
            var target = tray.querySelector('[data-id="' + room.id + '"]');
            obFly(ic, obInView(target) ? target : bag);
            if (!obInView(target)) obPop(bag);
            obAnnounce("Pièce ajoutée : " + room.label + (levels.length > 1 ? ", " + obAtFloor(room.floor) : "") + ".");
          }
        }, [ic, el("span", { class: "ob-room-lbl", text: preset.label }), badge, el("span", { class: "ob-room-plus", "aria-hidden": "true" }, [icon("plus", 13)])]);
        tilesByKey[preset.key] = { node: node, badge: badge };
        return obTilt(node, 10);
      }));

      obKeys.primary = function () { if (wiz.rooms.length) go(1); };
      stage = [
        title("Quelles pièces ?"),
        lede(levels.length > 1
          ? "Choisissez un niveau, puis touchez ses pièces — plusieurs fois pour en avoir plusieurs. La croix en retire une."
          : "Touchez pour ajouter, plusieurs fois pour en avoir plusieurs. La croix en retire une."),
        floorBar ? el("div", { class: "ob-floorpick" }, [floorBar, floorHint]) : null,
        grid,
        el("div", { class: "ob-custom" }, [customInput, customAdd]),
        el("div", { class: "ob-basket" }, [trayHead, tray]),
        el("div", { class: "ob-actions ob-actions--sticky" }, [bag, roomsCta, hint])
      ];
      sidePanel = side(true);
      paintRooms(null, null);
    }

    /* ─── Noms ─── */
    else if (current === "rename") {
      var focusRoom = function (id) {
        if (!sideNode) return;
        Array.prototype.forEach.call(sideNode.querySelectorAll("[data-room]"), function (g) {
          g.classList.toggle("is-focus", g.getAttribute("data-room") === id);
        });
      };
      var renameLevels = obWizLevels();
      var rows = wiz.rooms.map(function (room, index) {
        var input = el("input", {
          class: "ob-rename-input", value: room.label, maxlength: 80,
          "aria-label": "Nom de la pièce " + (index + 1) + " sur " + wiz.rooms.length, "data-ob-own-enter": "1",
          oninput: function (event) {
            room.label = event.target.value;
            var label = sideNode && sideNode.querySelector('[data-label="' + room.id + '"]');
            if (label) label.textContent = obShort(room.label);
          },
          onfocus: function () { focusRoom(room.id); },
          onblur: function () { focusRoom(null); },
          onkeydown: function (event) {
            if (event.key !== "Enter") return;
            event.preventDefault();
            var all = document.querySelectorAll(".ob-rename-input");
            if (all[index + 1]) all[index + 1].focus();
            else go(1);
          }
        });
        return el("li", { class: "ob-rename-row" + (renameLevels.length > 1 ? " has-floor" : ""), style: "--i:" + Math.min(index, 10) }, [
          el("button", {
            class: "ob-icon-btn", type: "button",
            "aria-label": "Changer l'icône de " + room.label, title: "Changer l'icône",
            onclick: function () {
              iconPicker({
                title: "Icône de " + room.label, current: room.icon,
                onPick: function (value) {
                  room.icon = value || ICON_BY_KIND[room.kind];
                  render();
                  var buttons = document.querySelectorAll(".ob-rename-row .ob-icon-btn");
                  if (buttons[index]) buttons[index].focus();
                }
              });
            }
          }, [sym(room.icon, 20)]),
          input,
          /* Réassigner le niveau : un menu natif, lisible au clavier comme au
             lecteur d'écran. La maquette suit aussitôt. */
          renameLevels.length > 1 ? el("select", {
            class: "ob-floor-select", "aria-label": "Niveau de la pièce " + (index + 1),
            onchange: function (event) {
              room.floor = +event.target.value;
              repaintSide();
              focusRoom(room.id);
              obAnnounce(room.label + " : " + obFloorName(room.floor) + ".");
            }
          }, renameLevels.slice().reverse().map(function (f) {
            return el("option", { value: String(f), selected: room.floor === f ? true : null, text: obFloorName(f) });
          })) : null,
          el("button", {
            class: "ob-x ob-x--row", type: "button", "aria-label": "Retirer " + room.label, title: "Retirer",
            onclick: function () {
              removeRoomById(room.id, room.key);
              render();
              var inputs = document.querySelectorAll(".ob-rename-input");
              var next = inputs[Math.min(index, inputs.length - 1)];
              if (next) next.focus(); else { var t = document.getElementById("ob-step-title"); if (t) t.focus(); }
              obAnnounce("Pièce retirée : " + room.label + ".");
            }
          }, [icon("x", 15)])
        ]);
      });
      obKeys.primary = function () { go(1); };
      stage = [
        title("Précisez les noms"),
        lede(renameLevels.length > 1
          ? "« Chambre 2 » devient « Chambre de Léa ». Touchez l'icône pour la changer, et corrigez le niveau si besoin."
          : "« Chambre 2 » devient « Chambre de Léa ». Touchez l'icône pour la changer. Facultatif, mais très utile à la recherche."),
        rows.length
          ? el("ul", { class: "ob-rename" }, rows)
          : el("p", { class: "ob-hint", text: "Aucune pièce pour l'instant. Revenez à l'étape précédente pour en ajouter." }),
        el("div", { class: "ob-actions ob-actions--sticky" }, [obCta("Continuer", { onclick: function () { go(1); } })])
      ];
      sidePanel = side(false);
    }

    /* ─── Meubles ─── */
    else {
      /* Rien n'est ajouté d'office. Chaque pièce propose SES rangements en
         puces : un toucher ajoute un exemplaire, deux touchers deux (« Table
         de chevet », « Table de chevet 2 »). Le catalogue complet reste là. */
      var sections = wiz.rooms.map(function (room) {
        var preset = null;
        for (var p = 0; p < ROOMS.length; p++) if (ROOMS[p].key === room.key) preset = ROOMS[p];
        var suggestKeys = (preset && preset.suggests) || ["etagere", "placard", "caisse", "carton"];
        var list = el("div", { class: "ob-tray", role: "list", "aria-label": "Rangements de " + room.label });
        var sugg = el("div", { class: "ob-sugg", role: "group", "aria-label": "Suggestions pour " + room.label });
        var count = el("span", { class: "ob-furn-n tnum" });
        var paint;

        var catalogue = el("button", {
          class: "ob-add-chip", type: "button", "aria-label": "Catalogue complet des rangements pour " + room.label,
          onclick: function () {
            var before = room.furniture.map(function (f) { return f.id; });
            furniturePicker(room, function () {
              var added = room.furniture.filter(function (f) { return before.indexOf(f.id) === -1; }).map(function (f) { return f.id; });
              paint(added);
              repaintSide();
              if (added.length) obAnnounce(plural(added.length, "rangement ajouté", "rangements ajoutés") + " à " + room.label + ".");
            });
          }
        }, [icon("grid", 14), el("span", { text: "Catalogue" })]);

        var chipOf = function (f, isNew) {
          var node = el("span", { class: "ob-chip ob-chip--furn" + (isNew ? " is-new" : ""), role: "listitem", "data-id": f.id }, [
            el("button", {
              class: "ob-chip-pic", type: "button", "aria-label": "Changer l'icône de " + f.label, title: "Changer l'icône",
              onclick: function () {
                iconPicker({
                  title: "Icône de " + f.label, current: f.icon,
                  onPick: function (value) {
                    var entry = f.key ? furnitureByKey(f.key) : null;
                    f.icon = value || (entry ? entry.pic : furnitureGuessPic(f.base || f.label));
                    paint([]);
                    var again = list.querySelector('[data-id="' + f.id + '"] .ob-chip-pic');
                    if (again) { again.focus({ preventScroll: true }); obPop(again); }
                    obAnnounce("Icône de " + f.label + " changée.");
                  }
                });
              }
            }, [sym(f.icon || "f-autre", 20)]),
            el("span", { class: "ob-chip-lbl", text: f.label }),
            el("button", {
              class: "ob-x", type: "button", "aria-label": "Retirer " + f.label + " de " + room.label, title: "Retirer",
              onclick: function () {
                var index = room.furniture.indexOf(f);
                node.classList.add("is-out");
                setTimeout(function () {
                  furnRemove(room, f.id);
                  paint([]);
                  repaintSide();
                  var xs = list.querySelectorAll(".ob-x");
                  var next = xs[Math.min(index, xs.length - 1)] || sugg.querySelector("button");
                  if (next) next.focus({ preventScroll: true });
                  obAnnounce(f.label + " retiré de " + room.label + ".");
                }, obCalm() ? 0 : 170);
              }
            }, [icon("x", 13)])
          ]);
          return node;
        };

        paint = function (freshIds, popKey) {
          list.replaceChildren.apply(list, room.furniture.length
            ? room.furniture.map(function (f) { return chipOf(f, freshIds.indexOf(f.id) !== -1); })
            : [el("span", { class: "ob-tray-empty", text: "Aucun rangement pour l'instant." })]);
          count.textContent = room.furniture.length ? plural(room.furniture.length, "rangement", "rangements") : "Aucun rangement";
          var buttons = suggestKeys.map(function (key) {
            var entry = furnitureByKey(key);
            if (!entry) return null;
            var n = room.furniture.filter(function (f) { return f.key === key; }).length;
            return el("button", {
              class: "ob-sugg-chip" + (n ? " is-on" : ""), type: "button", "data-key": key,
              "aria-label": "Ajouter : " + entry.label + (n ? " (" + n + " déjà)" : ""),
              onclick: function (event) {
                var item = furnAdd(room, entry);
                paint([item.id], key);
                repaintSide();
                obBurstFrom(event.currentTarget, event, { count: 8, power: 3 });
                obAnnounce(item.label + " ajouté à " + room.label + ".");
              }
            }, [
              el("span", { class: "ob-sugg-plus", "aria-hidden": "true" }, [icon("plus", 12)]),
              sym(entry.pic, 18),
              el("span", { text: entry.label }),
              n ? el("span", { class: "ob-sugg-n tnum", "aria-hidden": "true", text: "×" + n }) : null
            ]);
          }).filter(Boolean);
          buttons.push(catalogue);
          sugg.replaceChildren.apply(sugg, buttons);
          if (popKey) {
            var hit = sugg.querySelector('[data-key="' + popKey + '"]');
            if (hit) { hit.focus({ preventScroll: true }); obPop(hit.querySelector(".ob-sugg-n")); }
          }
        };
        paint([]);

        return el("section", { class: "ob-furn" }, [
          el("h2", { class: "ob-furn-head" }, [
            el("span", { class: "ob-furn-ic", "aria-hidden": "true" }, [sym(room.icon, 18)]),
            el("span", { class: "ob-furn-name", text: room.label }),
            count
          ]),
          list,
          el("p", { class: "ob-sugg-head", text: "Suggestions" }),
          sugg
        ]);
      });

      var finishCta;
      var onFinish = function (event) { finish(event, finishCta); };
      finishCta = obCta("Créer mon logement", { onclick: onFinish }, "check");
      obKeys.primary = function () { onFinish(null); };
      stage = [
        title("Les meubles de rangement"),
        lede("Touchez les suggestions de chaque pièce — deux fois pour deux tables de chevet. Touchez l'icône d'un rangement pour la changer. Le catalogue complet reste à portée."),
        sections.length ? el("div", { class: "ob-furns" }, sections) : el("p", { class: "ob-hint", text: "Aucune pièce : vous pourrez tout créer depuis l'application." }),
        el("div", { class: "ob-actions ob-actions--sticky" }, [finishCta])
      ];
      sidePanel = side(true);
    }

    return obShell("onb", head, stage, sidePanel, progress);
  }

  /* ─── Ancres d'entrée ─────────────────────────────────────────────────
     app#demo : le compte de démonstration, un compte à part, toujours
     rouvert sur le même logement d'exemple. Le compte en cours reste rangé
     sur l'appareil.
     app#signup : toujours le formulaire d'inscription. Une session
     ouverte est fermée d'abord (rien n'est effacé) : on crée un compte de
     plus, on ne remplace personne.
     app#login : l'écran de connexion ; connecté, on reste dans l'app. */
  function obRoute() {
    var hash = String(location.hash || "").toLowerCase();
    if (hash !== "#demo" && hash !== "#signup" && hash !== "#login") return;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    if (hash === "#demo") {
      openDemo();
      return;
    }
    if (cloud) {
      // En ligne, la session est celle du serveur : un lien ne la ferme pas.
      if (!state.session) obAuthView = hash === "#signup" ? "signup" : "login";
      return;
    }
    if (hash === "#signup") {
      if (state.session) { state.session = false; save(); resetViews(); }
      signup = obBlankSignup();
      obAuthView = "signup";
      return;
    }
    if (!state.session) obAuthView = "login";
  }
  window.addEventListener("hashchange", function () { obRoute(); render(); });

  /* ═══ Écran 3 — Application ═════════════════════════════════════════ */

  var TABS = [
    { id: "search",   icon: "search", label: "Rechercher" },
    { id: "places",   icon: "grid",   label: "Mes lieux" },
    { id: "scan",     icon: "scan",   label: "Scan Éclair", short: "Scan", premium: true },
    { id: "map",      icon: "map",    label: "Plan",  premium: true },
    { id: "alerts",   icon: "bell",   label: "Alertes" },
    { id: "settings", icon: "cog",    label: "Réglages" }
  ];

  function screenApp() {
    var premium = state.plan === "premium";
    var views = {
      search: viewSearch, places: viewPlaces, scan: viewScan,
      map: viewMap, alerts: viewAlerts, settings: viewSettings
    };
    // Un onglet inconnu (état enregistré par une autre version) ne doit pas
    // planter le rendu.
    if (!views[state.tab]) state.tab = "search";
    var alertCount = alerts().length;
    var homeIcon = state.household && state.household.type === "house" ? "h-maison" : "h-appart";
    var homeName = state.household ? state.household.name : "Mon logement";

    function planLine(cls) {
      return el("span", { class: cls + (premium ? " on" : "") }, premium
        ? [icon("bolt", 12), "Formule Éclair"]
        : ["Formule Libre"]);
    }

    /* Le rail : le foyer et sa formule en tête — on sait chez qui on est, et
       avec quoi — puis les onglets, sous lesquels glisse un seul indicateur. */
    var rail = el("nav", { class: "rail", "aria-label": "Navigation principale" }, [
      el("div", { class: "rail-head" }, [
        logo(21),
        el("span", { class: "kbd-hint", title: "Chercher depuis n'importe quel écran" }, [el("kbd", { class: "kbd", text: "⌘K" })])
      ]),
      el("button", {
        class: "rail-home", type: "button", "aria-label": homeName + " — réglages du foyer",
        onclick: function () { goTab("settings"); }
      }, [
        el("span", { class: "fig" }, [sym(homeIcon, 24)]),
        el("span", { class: "txt" }, [
          el("span", { class: "nm", text: homeName }),
          planLine("pl")
        ]),
        icon("chev", 14)
      ]),
      el("div", { class: "rail-nav" }, TABS.map(function (tab) {
        var on = state.tab === tab.id;
        return el("button", {
          class: "rail-btn", type: "button", "data-tab": tab.id,
          "aria-current": on ? "page" : null,
          onclick: function () { goTab(tab.id); }
        }, [
          on ? el("span", { class: "rail-ind", "aria-hidden": "true" }) : null,
          icon(tab.icon, 19),
          el("span", { class: "lbl", text: tab.label }),
          tab.id === "alerts" && alertCount > 0 ? el("span", { class: "rail-count", "aria-label": plural(alertCount, "alerte", "alertes"), text: String(alertCount) }) : null,
          tab.premium && !premium ? el("span", { class: "rail-bolt", title: "Fonction Éclair" }, [icon("bolt", 14)]) : null
        ]);
      })),
      el("div", { class: "rail-foot" }, [
        el("button", {
          class: "rail-btn", type: "button", onclick: toggleTheme,
          "aria-label": state.theme === "dark" ? "Passer au thème clair" : "Passer au thème sombre"
        }, [icon(state.theme === "dark" ? "sun" : "moon", 18), el("span", { class: "lbl", text: state.theme === "dark" ? "Thème clair" : "Thème sombre" })])
      ])
    ]);

    /* Mobile : cinq onglets en bas ; les réglages passent par le foyer, en
       haut à droite, comme un avatar. */
    var tabbar = el("nav", { class: "tabbar", "aria-label": "Navigation principale" }, TABS.slice(0, 5).map(function (tab) {
      var on = state.tab === tab.id;
      return el("button", {
        class: "tab", type: "button", "data-tab": tab.id,
        "aria-current": on ? "page" : null,
        "aria-label": tab.id === "alerts" && alertCount > 0 ? tab.label + ", " + plural(alertCount, "alerte", "alertes") : null,
        onclick: function () { goTab(tab.id); }
      }, [
        el("span", { class: "tab-icon" }, [
          on ? el("span", { class: "tab-ind", "aria-hidden": "true" }) : null,
          icon(tab.icon, 21),
          tab.id === "alerts" && alertCount > 0 ? el("span", { class: "tab-badge", "aria-hidden": "true", text: String(alertCount) }) : null
        ]),
        el("span", { class: "tab-lbl", text: tab.short || tab.label })
      ]);
    }));

    return el("div", { class: "app" }, [
      rail,
      el("div", { class: "app-main" }, [
        el("header", { class: "app-head" }, [
          logoMarkOnly(28),
          /* La recherche est le produit : accessible depuis chaque onglet. Sur
             le sien, l'en-tête dit simplement chez qui l'on est. */
          state.tab === "search"
            ? el("span", { class: "home-name" }, [el("b", { text: homeName }), planLine("")])
            : el("button", {
                class: "cmdk-trigger", type: "button",
                onclick: function () { openPalette(); }
              }, [
                icon("search", 17),
                el("span", { class: "grow", text: "Chercher un objet…" }),
                el("kbd", { class: "kbd", text: "⌘K" })
              ]),
          el("button", {
            class: "head-avatar", type: "button", "data-nav": "settings",
            "aria-label": "Réglages du foyer", title: "Réglages",
            "aria-current": state.tab === "settings" ? "page" : null,
            onclick: function () { goTab("settings"); }
          }, [sym(homeIcon, 20), el("span", { class: "cog", "aria-hidden": "true" }, [icon("cog", 11)])])
        ]),
        cloud && cloud.role() === "guest" ? el("div", { class: "ai-note", role: "note", style: "margin:16px clamp(16px, 4vw, 40px) 0" }, [
          icon("eye", 16),
          el("span", { text: "Vous êtes invité dans ce foyer : vous consultez l'inventaire, sans le modifier." })
        ]) : null,
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
    wrap.innerHTML = '<svg viewBox="0 0 48 48" fill="none" style="display:block;width:100%;height:100%">' + // html-sûr : SVG constant
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

  /* La clé de la liste affichée au rendu précédent : l'apparition échelonnée
     ne se joue que si la requête change, jamais à chaque rendu. */
  var lastResultsKey = null;

  function viewSearch() {
    var query = searchState.query.trim();
    var hasQuery = query.length > 0;
    var premium = state.plan === "premium";

    // Les résultats de la recherche IA étaient calculés puis jamais affichés :
    // tant que la phrase interprétée est celle du champ, ce sont eux qu'on montre.
    var aiActive = !!(aiResults && searchState.aiTried && searchState.aiTried === query);

    // « À ranger » n'est pas un mot-clé : c'est l'absence d'emplacement.
    var unsorted = state.items.filter(function (item) { return !item.locationId; }).length;
    var results = searchState.filter === "__unsorted"
      ? state.items.filter(function (item) { return !item.locationId; })
          .map(function (item) { return { item: item, score: 0, reason: "recent" }; })
      : aiActive ? aiResults : search(searchState.query);
    var shown = results;

    var resultsKey = (searchState.filter || "") + "|" + (aiActive ? "ai|" : "") + norm(query) + "|" + results.length;
    var stagger = resultsKey !== lastResultsKey;
    lastResultsKey = resultsKey;
    // La trouvaille : un seul résultat pour une vraie requête, il pulse une fois.
    var singleFound = hasQuery && stagger && results.length === 1 ? results[0].item.id : null;
    var highlight = aiActive || searchState.filter === "__unsorted" ? "" : query;

    var input = el("input", {
      type: "search", value: searchState.query, "data-graft": "",
      placeholder: "Clés, passeport, guirlande…",
      "aria-label": "Chercher un objet",
      autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
      oninput: function (event) {
        searchState.query = event.target.value;
        searchState.filter = null;
        if (searchState.aiTried !== null) { searchState.ai = null; searchState.aiTried = null; aiResults = null; }
        redrawSearch();
      },
      // Enregistré à la validation, pas à la frappe : sinon « p », « pa »,
      // « pas » rempliraient l'historique avant « passeport ».
      onkeydown: function (event) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        rememberSearch(searchState.query);
        // Sur téléphone, « Rechercher » range le clavier : les résultats sont dessous.
        if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) event.target.blur();
      },
      // Un champ retiré du document par un rendu reçoit aussi un « blur » :
      // c'est ce qui remplissait l'historique de « p », « pa », « pas »…
      onblur: function (event) { if (event.target.isConnected) rememberSearch(searchState.query); }
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
        emptyArt(),
        el("h2", { class: "display t-md", text: "Votre logement est vide pour l'instant" }),
        el("p", { class: "lede", style: "max-width:42ch", text: "Référencez un premier objet : c'est la seule chose à faire avant de pouvoir le retrouver." }),
        el("div", { class: "inline", style: "justify-content:center;margin-top:10px" }, [
          el("button", { class: "btn btn-volt", type: "button", onclick: function () { itemSheet(null); } }, [icon("plus", 16), "Référencer un objet"])
        ])
      ]);
    } else if (results.length === 0) {
      body = el("div", { class: "empty" }, [
        emptyArt(),
        el("h2", { class: "display t-md", text: searchState.aiTried ? "Même en interprétant, rien ne correspond." : "Rien ne correspond à « " + query + " »" }),
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

        el("div", { class: "results-head" }, [
          el("h2", { class: "label", text: aiActive ? "Trouvé en interprétant votre phrase"
            : searchState.filter === "__unsorted" ? "À ranger"
            : hasQuery || searchState.filter ? "Résultats" : "Tout votre logement, du plus récent" }),
          el("span", { class: "count", "aria-live": "polite", text: plural(shown.length, "objet", "objets") })
        ]),

        el("ul", { class: "results" + (stagger ? " stagger" : "") }, results.slice(0, 60).map(function (row, index) {
          var item = row.item;
          var li = el("li", {
            class: "result" + (row.reason === "tag" ? " tagmatch" : "") + (item.id === singleFound || item.id === tourFoundId ? " found" : ""),
            style: "--i:" + index
          }, [
            el("span", { class: "thumb" }, [sym(rootIconOf(item.locationId), 20)]),
            el("button", { class: "body", type: "button", onclick: function () { itemSheet(item); } }, [
              el("span", { class: "name" }, [
                markMatch(item.name, highlight),
                item.quantity > 1 ? el("span", { class: "qty", text: "×" + item.quantity }) : null
              ]),
              crumbs(item.locationId, item.spot)
            ]),
            el("div", { class: "tags" }, (item.tags || []).slice(0, 2).map(function (tag) {
              return el("span", { class: "tagpill", text: tag });
            })),
            el("button", {
              class: "mini", type: "button", title: "Je l'ai trouvé", "aria-label": "Je l'ai trouvé : confirmer l'emplacement de " + item.name,
              onclick: function () {
                item.lastSeenAt = Date.now(); save();
                // Le moment « trouvaille » : la ligne pulse une fois en volt.
                li.classList.remove("found");
                void li.offsetWidth;
                li.classList.add("found");
                toast("Emplacement confirmé.");
              }
            }, [icon("check", 17)])
          ]);
          return li;
        }))
      ]);
    }

    var history = (state.history || []);

    function clearAi() { searchState.ai = null; searchState.aiTried = null; aiResults = null; }

    return el("div", { class: "page search-page" }, [
      el("div", { class: "search-head", "data-graft": "" }, [
        el("h1", { class: "search-title", text: "Que cherchez-vous ?" }),
        el("div", { class: "search-meta" }, [
          el("p", { class: "search-sub" }, [
            el("b", { text: String(state.items.length) }),
            (state.items.length < 2 ? " objet référencé" : " objets référencés") + (state.household ? " dans « " + state.household.name + " »" : "") + "."
          ]),
          el("span", { class: "spacer" }),
          // La démonstration ne lance pas la visite d'office : elle la propose.
          tourIsDemo() && !state.tourSeen ? el("button", {
            class: "btn btn-sm btn-quiet tour-launch", type: "button", onclick: tourStart
          }, [icon("spark", 14), "Visite guidée"]) : null,
          el("button", {
            class: "btn btn-sm btn-volt add-item-btn", type: "button",
            onclick: function () { if (tour) tourOpenSheet(); else itemSheet(null); }
          }, [icon("plus", 15), "Ajouter un objet"])
        ]),

        el("div", { class: "search-row", "data-graft": "" }, [
          el("div", { class: "search-box", "data-graft": "" }, [
            icon("search", 24),
            input,
            searchState.query ? el("button", {
              class: "icon-btn", type: "button", "aria-label": "Effacer la recherche",
              onclick: function () {
                searchState.query = ""; searchState.filter = null; clearAi();
                redrawSearch(true);
              }
            }, [icon("x", 18)]) : el("kbd", { class: "kbd", title: "Ouvrir la palette depuis n'importe quel écran", text: "⌘K" })
          ]),

          /* La recherche IA se déclenche à la demande, jamais à chaque
             frappe : chaque appel a un coût réel, et la recherche classique
             suffit presque toujours. */
          el("button", {
            class: "search-ai", type: "button",
            disabled: premium ? (!hasQuery || searchState.aiBusy) : false,
            "aria-busy": searchState.aiBusy ? "true" : null,
            title: premium ? "Interpréter votre phrase (l'inventaire ne sort jamais)" : "Fonction Éclair : voir la formule",
            onclick: premium ? runAiSearch : function () { goTab("settings"); }
          }, [
            icon(searchState.aiBusy ? "loop" : "spark", 17),
            searchState.aiBusy ? "Interprétation…" : "Avec mes mots",
            !premium ? el("span", { class: "rail-bolt" }, [icon("bolt", 13)]) : null
          ])
        ]),

        el("div", { class: "search-filters", role: "group", "aria-label": "Filtres par mot-clé" }, [
          el("button", {
            class: "chip chip-sm" + (searchState.filter ? "" : " on"), type: "button",
            "aria-pressed": searchState.filter ? "false" : "true",
            onclick: function () { searchState.filter = null; searchState.query = ""; clearAi(); render(); }
          }, ["Tous"])
        ].concat(topTags.slice(0, 5).map(function (tag) {
          var on = searchState.filter === tag;
          return el("button", {
            class: "chip chip-sm" + (on ? " on" : ""), type: "button", "aria-pressed": on ? "true" : "false",
            onclick: function () {
              searchState.filter = on ? null : tag;
              searchState.query = on ? "" : tag;
              clearAi();
              render();
            }
          }, [tag, el("b", { text: String(counts[tag]) })]);
        })).concat([
          unsorted > 0 ? el("button", {
            class: "chip chip-sm" + (searchState.filter === "__unsorted" ? " on" : ""), type: "button",
            "aria-pressed": searchState.filter === "__unsorted" ? "true" : "false",
            onclick: function () {
              var on = searchState.filter === "__unsorted";
              searchState.filter = on ? null : "__unsorted";
              searchState.query = "";
              clearAi();
              render();
            }
          }, ["À ranger", el("b", { text: String(unsorted) })]) : null
        ]))
      ]),

      /* L'historique prend la place des « récemment référencés » : on
         l'affiche tant qu'aucune recherche n'est en cours. */
      !hasQuery && !searchState.filter && history.length > 0 ? el("div", { style: "margin-top:28px" }, [
        el("div", { class: "inline", style: "justify-content:space-between" }, [
          el("h2", { class: "label", text: "Vos recherches" }),
          el("button", {
            class: "btn btn-sm btn-quiet", type: "button",
            onclick: function () { state.history = []; save(); render(); }
          }, "Effacer l'historique")
        ]),
        el("div", { class: "hist" }, history.map(function (entry) {
          return el("span", { class: "hist-chip" }, [
            el("button", {
              class: "go", type: "button", "aria-label": "Rechercher " + entry.q,
              onclick: function () { searchState.query = entry.q; searchState.filter = null; clearAi(); render(); }
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

  /* Redessine la recherche à la frappe SANS toucher au champ.

     Un render() complet retirait le champ du document à chaque touche : le
     navigateur lui envoyait un « blur » (qui enregistrait « p », « pa »,
     « pas »… dans l'historique), la composition d'un accent était coupée, et
     sur téléphone le clavier clignotait. On greffe donc la nouvelle vue
     autour de l'ancien champ : tout ce qui n'est pas sur le chemin
     page › en-tête › rangée › boîte › champ est remplacé, le champ reste. */
  function graft(oldParent, newParent) {
    var oldKeep = oldParent.querySelector(":scope > [data-graft]");
    var newKeep = newParent.querySelector(":scope > [data-graft]");
    if (!oldKeep || !newKeep) {
      oldParent.replaceChildren.apply(oldParent, Array.prototype.slice.call(newParent.childNodes));
      return;
    }
    while (oldKeep.previousSibling) oldKeep.previousSibling.remove();
    while (oldKeep.nextSibling) oldKeep.nextSibling.remove();
    var seen = false;
    Array.prototype.slice.call(newParent.childNodes).forEach(function (node) {
      if (node === newKeep) { seen = true; return; }
      if (seen) oldParent.appendChild(node); else oldParent.insertBefore(node, oldKeep);
    });
    if (oldKeep.tagName === "INPUT") return;
    oldKeep.className = newKeep.className;
    graft(oldKeep, newKeep);
  }

  function redrawSearch(focusInput) {
    var page = document.querySelector(".app-main > .search-page");
    var input = page && page.querySelector(".search-box input");
    if (page && input && document.activeElement === input) {
      graft(page, viewSearch());
      return;
    }
    render();
    if (!focusInput) return;
    var fresh = document.querySelector(".search-box input");
    if (!fresh) return;
    fresh.focus();
    try { fresh.setSelectionRange(fresh.value.length, fresh.value.length); } catch (e) {}
  }

  function runAiSearch() {
    var query = searchState.query.trim();
    if (!query || searchState.aiBusy) return;

    if (!sampleApi) {
      toast("L'assistant n'est pas disponible dans cette vue.");
      return;
    }
    if (!aiConsented()) { aiConsentThen(runAiSearch); return; }

    searchState.aiBusy = true;
    searchState.aiTried = query;
    aiResults = null;
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

    // En ligne, le serveur détient la consigne : on ne lui envoie que la phrase.
    (cloud ? cloud.aiSearch(query) : sampleApi.json(prompt, { modelTier: "quick", cache: true }))
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
            : code === "not_premium" ? "La recherche IA fait partie de la formule Éclair."
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

      function startAdd() { adding = node.id; expanded[node.id] = true; render(); }
      function startRename() { editing = node.id; render(); }
      function changeIcon() {
        iconPicker({
          title: "Icône de " + node.name, current: node.icon,
          onPick: function (value) { node.icon = value; save(); render(); }
        });
      }
      function remove() {
        var ids = descendantIds(node.id);
        var parent = node.parentId ? locById(node.parentId) : null;
        confirmSheet({
          title: "Supprimer « " + node.name + " » ?",
          body: count > 0
            ? plural(count, "objet rangé ici remontera", "objets rangés ici remonteront") + (parent ? " dans « " + parent.name + " »" : " dans « À ranger »") + ". Rien n'est perdu."
            : (ids.length > 1 ? "Ce lieu et les rangements qu'il contient seront supprimés." : "Ce lieu est vide : rien d'autre ne change."),
          confirmLabel: "Supprimer",
          danger: true,
          onConfirm: function () {
            // Les objets remontent au parent : supprimer un meuble ne doit
            // jamais faire disparaître ce qu'il contenait.
            state.items.forEach(function (item) {
              if (ids.indexOf(item.locationId) !== -1) item.locationId = node.parentId;
            });
            state.locations = state.locations.filter(function (l) { return ids.indexOf(l.id) === -1; });
            state.scans = (state.scans || []).filter(function (sc) { return ids.indexOf(sc.locationId) === -1; });
            save(); render();
            toast("« " + node.name + " » supprimé.");
          }
        });
      }

      var rows = [el("div", {
        class: "node" + (depth === 0 ? " is-root" : ""),
        style: "--depth:" + depth + ";padding-left:" + (depth * 22 + 6) + "px"
      }, [
        el("button", {
          class: "twist" + (kids.length ? "" : " hidden"), type: "button",
          "aria-expanded": open ? "true" : "false", "aria-label": (open ? "Replier " : "Déplier ") + node.name,
          onclick: function () { expanded[node.id] = !open; render(); }
        }, [icon("chev", 15)]),

        el("button", {
          class: "mini icon-edit", type: "button",
          "aria-label": "Changer l'icône de " + node.name, title: "Changer l'icône",
          onclick: changeIcon
        }, [sym(node.icon || ICON_BY_KIND[node.kind], 18)]),

        editing === node.id
          ? el("input", {
              class: "input", value: node.name, maxlength: 80, autofocus: true, "aria-label": "Nouveau nom de " + node.name,
              // Échap annule : le « blur » qui suit la disparition du champ ne
              // doit pas enregistrer ce qu'Échap vient d'abandonner.
              onblur: function (event) {
                if (editing !== node.id) return;
                node.name = event.target.value.trim().slice(0, 80) || node.name;
                editing = null; save(); render();
              },
              onkeydown: function (event) {
                if (event.key === "Enter") event.target.blur();
                if (event.key === "Escape") { event.stopPropagation(); editing = null; render(); }
              }
            })
          : el("span", { class: "nm", text: node.name }),

        count > 0 ? el("span", { class: "count", "aria-label": plural(count, "objet", "objets"), text: String(count) }) : null,

        el("div", { class: "acts" }, [
          el("button", { class: "mini", type: "button", "aria-label": "Ajouter dans " + node.name, title: "Ajouter dedans", onclick: startAdd }, [icon("plus", 15)]),
          el("button", { class: "mini", type: "button", "aria-label": "Renommer " + node.name, title: "Renommer", onclick: startRename }, [icon("pencil", 14)]),
          el("button", { class: "mini warn", type: "button", "aria-label": "Supprimer " + node.name, title: "Supprimer", onclick: remove }, [icon("trash", 14)])
        ]),

        /* Au doigt, pas de survol : les actions passent par un menu. */
        el("button", {
          class: "mini node-more", type: "button", "aria-label": "Actions pour " + node.name,
          onclick: function () {
            function act(label, ic, run, danger) {
              return el("button", { type: "button", class: danger ? "danger" : null, onclick: function () { closeSheet(); run(); } }, [icon(ic, 19), label]);
            }
            sheet({
              title: node.name,
              body: [el("div", { class: "action-list" }, [
                act("Ajouter dedans", "plus", startAdd),
                act("Renommer", "pencil", startRename),
                act("Changer l'icône", "grid", changeIcon),
                act("Supprimer", "trash", remove, true)
              ])]
            });
          }
        }, [icon("more", 18)])
      ])];

      if (adding === node.id) {
        var addInput = el("input", {
          class: "input", autofocus: true, maxlength: 80, enterkeyhint: "done",
          "aria-label": (childKind(node.kind) === "furniture" ? "Nouveau meuble dans " : "Nouveau contenant dans ") + node.name,
          placeholder: childKind(node.kind) === "furniture" ? "Nouveau meuble" : "Nouveau contenant",
          onkeydown: function (event) {
            if (event.key === "Enter") addNode(node, event.target.value);
            if (event.key === "Escape") { event.stopPropagation(); adding = null; render(); }
          }
        });
        rows.push(el("div", { class: "node-add", style: "padding-left:" + ((depth + 1) * 22 + 40) + "px" }, [
          addInput,
          el("button", { class: "btn btn-sm btn-volt", type: "button", onclick: function () { addNode(node, addInput.value); } }, [icon("plus", 14), "Ajouter"]),
          childKind(node.kind) === "furniture"
            ? el("button", {
                class: "btn btn-sm btn-line", type: "button",
                onclick: function () {
                  // Le même catalogue illustré qu'à l'installation : on ne
                  // devine pas mieux le nom d'un meuble six mois plus tard.
                  var basket = { label: node.name, furniture: [] };
                  var existing = childrenOf(node.id).map(function (child) { return child.name; });
                  furniturePicker(basket, function () {
                    // Des entrées { label, icon } : exemplaires numérotés et icône choisie.
                    basket.furniture.forEach(function (f) {
                      state.locations.push({
                        id: uid("loc"), parentId: node.id, kind: "furniture",
                        name: furnLabel(f), icon: f.icon || null, floor: node.floor
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

    var rootInput = adding === "root" ? el("input", {
      class: "input", style: "flex:1 1 200px", placeholder: "Nouvelle pièce ou zone", autofocus: true, maxlength: 80,
      "aria-label": "Nom de la nouvelle pièce ou zone", enterkeyhint: "done",
      onkeydown: function (event) {
        if (event.key === "Enter") addNode(null, event.target.value);
        if (event.key === "Escape") { adding = null; render(); }
      }
    }) : null;

    return el("div", { class: "page" }, [
      el("h1", { class: "display t-lg", text: "Mes lieux" }),
      el("p", { class: "lede", style: "margin-top:8px", text: "Pièce, meuble, contenant : l'architecture de votre logement. Ajoutez, renommez, réorganisez à tout moment." }),

      el("div", { class: "tree", style: "margin-top:22px" }, treeRows.length ? treeRows : [
        el("p", { class: "tree-empty", text: "Aucun lieu pour l'instant. Ajoutez une pièce pour commencer." })
      ]),

      adding === "root"
        ? el("div", { class: "inline", style: "margin-top:14px" }, [
            rootInput,
            el("button", { class: "btn btn-volt", type: "button", onclick: function () { addNode(null, rootInput.value); } }, [icon("plus", 15), "Ajouter"]),
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

            (cloud ? cloud.aiScan(blob) : sampleApi.json(prompt, { images: blob, modelTier: "default" }))
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
                  : code === "not_premium" ? "Le Scan Éclair fait partie de la formule Éclair."
                  : code === "read_only" ? "Votre rôle d'invité ne permet pas d'ajouter des objets."
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
        el("span", { class: "badge" }, [icon("bolt", 12), "Éclair"])
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

      el("div", { class: "scan-stage" + (scanState.image ? " has-image" : ""), style: "margin-top:16px", "aria-busy": scanState.busy ? "true" : null }, [
        scanState.image
          ? el("img", { src: scanState.image, alt: "Photo à analyser" })
          : el("div", { class: "scan-empty" }, [
              el("span", { class: "corners", "aria-hidden": "true" }),
              el("span", { class: "fig" }, [icon("scan", 30)]),
              el("p", { class: "muted", style: "font-size:.9375rem;max-width:34ch", text: photoAvailable ? "Prenez une photo d'un rangement, ou importez-en une depuis votre appareil." : "Démonstration : le résultat d'une analyse d'étagère, à corriger puis enregistrer." })
            ]),
        scanState.busy ? el("div", { class: "scan-overlay", role: "status" }, [
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
                onclick: function () { aiConsentThen(function () { input.click(); }); }
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
          return el("li", { class: "row" + (item.keep ? "" : " off") }, [
            el("button", {
              class: "check", type: "button", role: "checkbox",
              "aria-checked": item.keep ? "true" : "false", "aria-label": "Garder « " + item.name + " »",
              onclick: function () { scanState.detected[index].keep = !item.keep; render(); }
            }, [el("span", { class: "box" }, [item.keep ? icon("check", 14) : null])]),
            el("input", {
              class: "bare", value: item.name, maxlength: 120, "aria-label": "Nom de l'objet",
              oninput: function (event) { scanState.detected[index].name = event.target.value; }
            }),
            item.quantity > 1 ? el("span", { class: "qty-tag", text: "×" + item.quantity }) : null,
            item.confidence === "medium" ? el("span", { class: "conf", title: "L'IA n'en est pas certaine : vérifiez le nom", text: "À vérifier" }) : null
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
        // Le canevas est recréé à chaque rendu : on rend aussi le contexte,
        // sinon le navigateur en accumule jusqu'à perdre les plus anciens.
        try { var lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext(); } catch (e) {}
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
      dispose: function () {
        running = false;
        cancelAnimationFrame(raf);
        // Même ménage que le nuage de points : un contexte WebGL par visite
        // de l'Espace 3D, jamais rendu, finissait par évincer les autres.
        try { var lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext(); } catch (e) {}
      }
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

    function saveReview(confirmed) {
      var previous = scanOf(review.locationId);
      if (previous && confirmed !== true) {
        confirmSheet({
          title: "Remplacer le relevé ?",
          body: "Le relevé actuel de « " + (locById(review.locationId) || {}).name + " » sera remplacé. Les rangements déjà situés devront être reposés.",
          confirmLabel: "Remplacer",
          onConfirm: function () { saveReview(true); }
        });
        return;
      }

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
        el("span", { class: "badge" }, [icon("bolt", 12), "Éclair"])
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
            confirmSheet({
              title: "Supprimer le relevé ?",
              body: "Le relevé de « " + room.name + " » sera effacé de cet appareil. Les rangements situés perdront leur point.",
              confirmLabel: "Supprimer",
              danger: true,
              onConfirm: function () {
                scanStore.del(scan.id);
                state.scans = state.scans.filter(function (sc) { return sc.id !== scan.id; });
                descendantIds(room.id).forEach(function (lid) {
                  var node = locById(lid);
                  if (node) node.space = null;
                });
                dropScene(); save(); render();
                toast("Relevé supprimé.");
              }
            });
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

  /* Les niveaux sont des nombres : -1 sous-sol, 0 rez-de-chaussée, 1 premier
     étage… Un niveau qui ne contient que des combles (grenier) s'appelle ainsi,
     quel que soit son numéro. */
  var FLOOR_NAMES = {
    "1": "1er étage", "0": "Rez-de-chaussée", "-1": "Sous-sol"
  };

  function floorLabel(floor, rooms) {
    if (floor > 0 && rooms && rooms.length && rooms.every(function (r) { return r.icon === "r-grenier"; })) return "Combles";
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

    var cardIndex = 0;

    function roomCard(room) {
      var count = total(room.id);
      var kids = childrenOf(room.id);
      // La part de la largeur suit le contenu, bornée : une pièce vide reste
      // cliquable, une pièce pleine ne mange pas toute la rangée.
      var weight = 0.55 + (count / max) * 1.6;

      var order = cardIndex++;
      return el("button", {
        class: "room-card",
        type: "button",
        style: "flex:" + weight.toFixed(2) + " 1 190px;--i:" + order,
        "aria-pressed": mapFocus === room.id ? "true" : "false",
        "aria-label": room.name + ", " + plural(count, "objet", "objets"),
        onclick: function () {
          mapFocus = mapFocus === room.id ? null : room.id;
          render();
          // Le détail s'ouvre sous l'étage de la pièce : on l'amène à l'écran.
          var panel = document.querySelector(".focus-panel");
          if (panel) panel.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
        }
      }, [
        el("span", { class: "rc-head" }, [
          el("span", { class: "rc-icon" }, [sym(room.icon || ICON_BY_KIND[room.kind], 19)]),
          el("span", { class: "rc-name", text: room.name }),
          el("span", { class: "rc-n", text: String(count) })
        ]),

        /* La jauge : elle dit d'un trait ce que le treemap disait par la
           surface, sans déformer la pièce. */
        el("span", { class: "rc-bar", "aria-hidden": "true" }, [
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
    if (mapFocus && !focus) mapFocus = null;

    function focusPanel() {
      var ids = descendantIds(focus.id);
      var inside = state.items.filter(function (item) { return ids.indexOf(item.locationId) !== -1; });
      return el("div", { class: "focus-panel", role: "region", "aria-label": "Contenu de " + focus.name }, [
        el("div", { class: "inline", style: "justify-content:space-between;flex-wrap:nowrap" }, [
          el("h2", {}, [sym(focus.icon || ICON_BY_KIND[focus.kind], 20), focus.name]),
          el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer le détail de " + focus.name,
                         onclick: function () { mapFocus = null; render(); } }, [icon("x", 17)])
        ]),
        inside.length === 0
          ? el("p", { class: "muted", style: "font-size:.875rem;margin-top:10px", text: "Rien de référencé ici pour l'instant." })
          : el("ul", { class: "results" }, inside.slice(0, 12).map(function (item) {
              return el("li", { class: "result" }, [
                el("span", { class: "thumb" }, [sym(rootIconOf(item.locationId), 19)]),
                el("button", { class: "body", type: "button", onclick: function () { itemSheet(item); } }, [
                  el("span", { class: "name", text: item.name }),
                  crumbs(item.locationId, item.spot)
                ])
              ]);
            })),
        inside.length > 12 ? el("button", {
          class: "btn btn-sm btn-quiet", type: "button", style: "margin-top:10px",
          onclick: function () { searchState.query = focus.name; searchState.filter = null; aiResults = null; goTab("search"); }
        }, ["Voir les " + inside.length + " objets", icon("arrow-right", 14)]) : null
      ]);
    }

    return el("div", { class: "page page-wide" }, [
      el("div", { class: "page-head" }, [
        el("h1", { class: "display t-lg", text: "Votre logement" }),
        el("span", { class: "badge" }, [icon("bolt", 12), "Éclair"])
      ]),
      modeSwitch(),

      state.locations.length === 0
        ? el("div", { class: "empty" }, [
            emptyArt(),
            el("h2", { class: "display t-md", text: "Pas encore de pièces" }),
            el("p", { class: "lede", text: "Ajoutez des pièces dans « Mes lieux » pour construire votre plan." }),
            el("button", { class: "btn btn-volt", type: "button", onclick: function () { goTab("places"); } }, [icon("grid", 15), "Aller à Mes lieux"])
          ])
        : el("div", { class: "floors" }, floors.map(function (floor) {
            var rooms = byFloor[String(floor)];
            var hasFocus = focus && rooms.some(function (r) { return r.id === focus.id; });
            return el("section", { class: "floor", "aria-label": floorLabel(floor, rooms) }, [
              el("div", { class: "floor-tag" }, [
                el("h2", { text: floorLabel(floor, rooms) }),
                el("span", { class: "n", text: plural(rooms.reduce(function (n, r) { return n + total(r.id); }, 0), "objet", "objets") })
              ]),
              el("div", { class: "floor-rooms" }, rooms.map(roomCard)),
              hasFocus ? focusPanel() : null
            ]);
          })),

      el("p", { class: "footnote", text: "Chaque étage montre ses pièces côte à côte ; la largeur et la jauge suivent ce qu'elles contiennent. Touchez une pièce pour voir ce qu'il y a dedans." })
    ]);
  }


  /* ─── Vue : alertes ───────────────────────────────────────────────── */

  function viewAlerts() {
    var rows = alerts();

    function days(n) { return n === 0 ? "aujourd'hui" : n === 1 ? "demain" : "dans " + n + " jours"; }

    function alertRow(row) {
      var late = row.kind === "expiry" && row.days < 0;
      var text = row.kind === "expiry"
        ? (late ? "Périmé depuis " + plural(Math.abs(row.days), "jour", "jours") : "Périme " + days(row.days))
        : row.kind === "warranty"
          ? "Garantie : fin " + days(row.days)
          : "Chez " + row.item.lentTo + " depuis " + row.days + " j";

      return el("li", { class: "alert-row" + (late ? " is-late" : "") + (row.kind === "lent" ? " is-lent" : "") }, [
        el("span", { class: "state", "aria-hidden": "true" }, [icon(row.kind === "expiry" ? "warn" : row.kind === "warranty" ? "shield" : "loop", 19)]),
        el("button", { class: "body", type: "button", onclick: function () { itemSheet(row.item); } }, [
          el("span", { class: "name", text: row.item.name }),
          crumbs(row.item.locationId, row.item.spot)
        ]),
        el("span", { class: "due", text: text }),
        // Un prêt se clôt d'un geste : c'est l'action que l'alerte appelle.
        row.kind === "lent" ? el("button", {
          class: "btn btn-sm btn-line", type: "button", "aria-label": "Marquer « " + row.item.name + " » comme rendu",
          onclick: function () {
            row.item.lentTo = null; row.item.lentAt = null; row.item.lastSeenAt = Date.now();
            save(); render(); toast("« " + row.item.name + " » est de retour.");
          }
        }, [icon("check", 14), "Rendu"]) : null
      ]);
    }

    var groups = [
      { title: "À traiter", rows: rows.filter(function (r) { return r.kind === "expiry" && r.days < 0; }) },
      { title: "Échéances proches", rows: rows.filter(function (r) { return (r.kind === "expiry" && r.days >= 0) || r.kind === "warranty"; }) },
      { title: "Objets prêtés", rows: rows.filter(function (r) { return r.kind === "lent"; }) }
    ];

    return el("div", { class: "page" }, [
      el("h1", { class: "display t-lg", text: "Alertes" }),
      el("p", { class: "lede", style: "margin-top:8px", text: rows.length
        ? plural(rows.length, "chose demande", "choses demandent") + " votre attention : péremptions, garanties, prêts."
        : "Péremptions, fins de garantie, objets prêtés : tout ce qui a une date apparaît ici." }),

      // Les alertes sont calculées pour tout le monde ; seule leur remontée par
      // email est réservée à l'Éclair. On ne cache pas derrière un paiement une
      // information qui concerne la santé ou les garanties.
      state.plan !== "premium" && rows.length > 0 ? el("div", { class: "ai-note" }, [
        icon("bolt", 15),
        el("span", { class: "muted", text: "Avec l'Éclair, ces alertes vous parviennent par email avant que la date ne passe." })
      ]) : null,

      rows.length === 0
        ? el("div", { class: "all-clear" }, [
            el("span", { class: "blob", "aria-hidden": "true" }, [icon("check", 26)]),
            el("h2", { class: "display t-md", text: "Rien à signaler" }),
            el("p", { class: "lede", text: "Ajoutez une date de péremption ou un prêt dans la fiche d'un objet : l'alerte viendra toute seule." })
          ])
        : el("div", {}, groups.filter(function (g) { return g.rows.length > 0; }).map(function (group) {
            return el("section", { class: "alert-group" }, [
              el("h2", {}, [group.title, el("span", { class: "n", text: String(group.rows.length) })]),
              el("ul", { class: "row-list" }, group.rows.map(alertRow))
            ]);
          }))
    ]);
  }

  /* ─── Vue : réglages ──────────────────────────────────────────────── */

  /* Nom, email et mot de passe du compte ouvert. Le registre des comptes est
     indexé par email : changer d'adresse déplace l'entrée, sans doublon.
     Changer de mot de passe demande l'actuel, comme partout ailleurs. */
  function accountSheet() {
    var acct = state.account;
    if (!acct) return;
    var draft = { name: acct.name || "", email: acct.email || "", current: "", next: "" };
    var errs = {};

    function input(key, label, type, auto, hint) {
      var box = el("input", {
        class: "input", type: type, value: draft[key], maxlength: 200, autocomplete: auto,
        "aria-describedby": "acct-" + key + "-err",
        oninput: function (event) { draft[key] = event.target.value; setErr(key, null); }
      });
      var err = el("span", { class: "err", id: "acct-" + key + "-err", role: "alert", hidden: true });
      errs[key] = { input: box, err: err };
      return el("label", { class: "field" }, [
        el("span", { text: label }), box, err,
        hint ? el("span", { class: "field-hint", text: hint }) : null
      ]);
    }
    function setErr(key, message) {
      var f = errs[key];
      if (!f) return;
      f.err.hidden = !message;
      f.err.textContent = message || "";
      if (message) f.input.setAttribute("aria-invalid", "true"); else f.input.removeAttribute("aria-invalid");
    }
    function fail(key, message) { setErr(key, message); errs[key].input.focus(); }

    var busy = false;
    function commit() {
      if (busy) return;
      var name = draft.name.trim();
      var mail = draft.email.trim().toLowerCase();
      var nameErr = obFieldError("fullName", name);
      if (nameErr) { fail("name", nameErr); return; }
      var mailErr = obFieldError("email", mail);
      if (mailErr) { fail("email", mailErr); return; }
      var moved = mail !== accountKey(acct.email);
      if (!cloud && moved && accountFind(mail)) { fail("email", "Un autre compte de cet appareil utilise déjà cette adresse."); return; }
      var changePw = !!draft.next;
      if (changePw) {
        var pwErr = obFieldError("password", draft.next);
        if (pwErr) { fail("next", pwErr); return; }
      }
      if ((changePw || (cloud && moved)) && (acct.secret || cloud) && !draft.current) { fail("current", "Indiquez votre mot de passe actuel."); return; }

      busy = true;
      if (cloud) { cloudCommit(name, mail, moved, changePw); return; }
      var checked = changePw ? obVerify(acct.secret, draft.current) : Promise.resolve(true);
      checked.then(function (ok) {
        if (!ok) { busy = false; fail("current", "Mot de passe actuel incorrect."); return null; }
        return changePw ? obSeal(draft.next).then(function (secret) { return { secret: secret }; }) : {};
      }).then(function (result) {
        if (!result) return;
        if (moved) {
          var map = accountsRead();
          delete map[accountKey(acct.email)];
          accountsWrite(map);
        }
        acct.name = name;
        acct.email = mail;
        if (result.secret !== undefined) acct.secret = result.secret;
        save();
        closeSheet();
        render();
        toast(changePw ? "Compte mis à jour, nouveau mot de passe enregistré." : "Compte mis à jour.");
      });
    }

    /* En ligne, le serveur vérifie le mot de passe actuel et envoie un lien à la
       nouvelle adresse : elle ne remplace l'ancienne qu'une fois ce lien ouvert. */
    function cloudCommit(name, mail, moved, changePw) {
      var input = { name: name, email: mail };
      if (draft.current) input.current = draft.current;
      if (changePw) input.password = draft.next;
      cloud.updateAccount(input).then(function (res) {
        busy = false;
        if (!res.ok) {
          var code = res.error;
          if (code === "current") fail("current", "Mot de passe actuel incorrect.");
          else if (code === "exists") fail("email", "Un autre compte utilise déjà cette adresse.");
          else if (code === "email") fail("email", "Cette adresse email n'est pas valide : vérifiez le @ et le domaine.");
          else if (code === "password") fail("next", "Ce mot de passe n'est pas accepté. Choisissez-en un autre, de 12 caractères au moins.");
          else if (code === "name") fail("name", "Indiquez au moins un prénom.");
          else if (code === "limite") toast("Trop d'essais d'affilée. Réessayez dans une minute.");
          else toast("Le compte n'a pas pu être mis à jour. Réessayez dans un instant.");
          return;
        }
        acct.name = name;
        save();
        closeSheet();
        render();
        toast(res.emailPending
          ? "Compte mis à jour. Ouvrez le lien envoyé à " + mail + " pour confirmer la nouvelle adresse."
          : changePw ? "Compte mis à jour, nouveau mot de passe enregistré." : "Compte mis à jour.");
      }, function () {
        busy = false;
        toast("Le compte n'a pas pu être mis à jour. Vérifiez votre connexion.");
      });
    }

    var form = el("form", {
      class: "acct-form", novalidate: true,
      onsubmit: function (event) { event.preventDefault(); commit(); }
    }, [
      input("name", "Prénom et nom", "text", "name"),
      input("email", "Adresse email", "email", "email", "Elle sert à vous connecter."),
      el("p", { class: "acct-sub", text: "Changer de mot de passe" }),
      acct.secret || cloud ? input("current", "Mot de passe actuel", "password", "current-password",
        cloud ? "Demandé seulement pour changer d'adresse email ou de mot de passe." : null) : null,
      input("next", "Nouveau mot de passe", "password", "new-password", "Laissez vide pour le garder. 12 caractères minimum, dont 5 différents."),
      // Entrée dans un champ envoie le formulaire.
      el("button", { type: "submit", hidden: true, tabindex: "-1", "aria-hidden": "true" })
    ]);

    sheet({
      title: "Mes informations",
      body: [form],
      foot: [
        el("button", { class: "btn btn-line", type: "button", onclick: function () { closeSheet(); } }, "Annuler"),
        el("button", { class: "btn btn-volt", type: "button", onclick: commit }, [icon("check", 15), "Enregistrer"])
      ],
      initialFocus: errs.name.input
    });
  }

  /* Le nom du logement, tel qu'il s'affiche partout. */
  function homeSheet() {
    if (!state.household) return;
    var value = state.household.name || "";
    var box, err;
    function commit() {
      var name = value.trim();
      if (!name) { err.hidden = false; box.setAttribute("aria-invalid", "true"); box.focus(); return; }
      state.household.name = name.slice(0, 80);
      save(); closeSheet(); render();
      toast("Logement renommé.");
    }
    sheet({
      title: "Renommer le logement",
      body: [el("label", { class: "field" }, [
        el("span", { text: "Nom du logement" }),
        box = el("input", {
          class: "input", type: "text", value: value, maxlength: 80, autocomplete: "off",
          "aria-describedby": "home-name-err",
          oninput: function (event) { value = event.target.value; err.hidden = true; box.removeAttribute("aria-invalid"); },
          onkeydown: function (event) { if (event.key === "Enter") { event.preventDefault(); commit(); } }
        }),
        err = el("span", { class: "err", id: "home-name-err", role: "alert", hidden: true, text: "Donnez un nom à votre logement." })
      ])],
      foot: [
        el("button", { class: "btn btn-line", type: "button", onclick: function () { closeSheet(); } }, "Annuler"),
        el("button", { class: "btn btn-volt", type: "button", onclick: commit }, [icon("check", 15), "Enregistrer"])
      ],
      initialFocus: box
    });
  }

  /* ─── Installer sur l'écran d'accueil ───────────────────────────────

     Chrome et Edge (Android, ordinateur) proposent une vraie fenêtre
     d'installation : on garde l'événement et le bouton l'ouvre. Safari
     (iPhone, iPad, Mac) n'en a pas : le même bouton montre alors les trois
     gestes à faire, avec les icônes que l'on verra à l'écran. Un survol
     n'existe pas sur un téléphone : d'où une feuille, pas une animation au
     survol. Déjà installée, l'application ne propose rien. */
  var installPrompt = null;
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    installPrompt = event;
    if (state.session && state.tab === "settings") render();
  });
  window.addEventListener("appinstalled", function () {
    installPrompt = null;
    toast("Fulmo est installé sur votre écran d'accueil.");
    if (state.session && state.tab === "settings") render();
  });

  function appInstalled() {
    try {
      return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    } catch (e) { return false; }
  }
  function installPlatform() {
    var ua = navigator.userAgent || "";
    // L'iPad se présente comme un Mac : seul l'écran tactile le trahit.
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
    if (/Android/.test(ua)) return "android";
    if (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua)) return "mac-safari";
    return "desktop";
  }

  function installApp() {
    if (installPrompt) {
      var prompt = installPrompt;
      installPrompt = null;
      prompt.prompt();
      prompt.userChoice.then(function (choice) {
        if (choice && choice.outcome !== "accepted") toast("Installation annulée. Le bouton reste dans les Réglages.");
        render();
      }, function () { render(); });
      return;
    }
    installGuide();
  }

  function installGuide() {
    var platform = installPlatform();
    function step(n, glyph, title, detail) {
      return el("li", { class: "install-step" }, [
        el("span", { class: "install-n", "aria-hidden": "true", text: String(n) }),
        el("span", { class: "install-ic", "aria-hidden": "true" }, [icon(glyph, 22)]),
        el("span", { class: "install-txt" }, [el("b", { text: title }), detail ? el("span", { text: detail }) : null])
      ]);
    }
    var steps, note = null, title = "Ajouter Fulmo à l'écran d'accueil";
    if (platform === "ios") {
      steps = [
        step(1, "share", "Touchez le bouton Partager", "En bas de l'écran dans Safari (en haut sur iPad), le carré d'où sort une flèche."),
        step(2, "add-box", "Choisissez « Sur l'écran d'accueil »", "Faites défiler la liste vers le bas si vous ne le voyez pas."),
        step(3, "check", "Touchez « Ajouter »", "L'icône Fulmo apparaît parmi vos applications.")
      ];
      // Sur iPhone, l'icône ouvre un espace de stockage distinct de Safari.
      note = "Sur iPhone et iPad, l'application ajoutée garde ses propres données, séparées de celles de Safari : créez votre compte depuis l'icône, une fois ajoutée.";
    } else if (platform === "android") {
      steps = [
        step(1, "dots-v", "Ouvrez le menu du navigateur", "Les trois points, en haut à droite dans Chrome."),
        step(2, "add-box", "Choisissez « Installer l'application »", "Ou « Ajouter à l'écran d'accueil », selon le navigateur."),
        step(3, "check", "Confirmez", "L'icône Fulmo apparaît parmi vos applications.")
      ];
    } else if (platform === "mac-safari") {
      title = "Ajouter Fulmo au Dock";
      steps = [
        step(1, "share", "Ouvrez le menu Fichier de Safari", "Ou le bouton Partager de la barre d'outils."),
        step(2, "add-box", "Choisissez « Ajouter au Dock »", null),
        step(3, "check", "Confirmez avec « Ajouter »", "Fulmo s'ouvre ensuite comme une application.")
      ];
    } else {
      title = "Installer Fulmo";
      steps = [
        step(1, "download", "Cherchez l'icône d'installation", "À droite de la barre d'adresse dans Chrome ou Edge."),
        step(2, "add-box", "Ou passez par le menu", "« Caster, enregistrer et partager » puis « Installer la page en tant qu'application »."),
        step(3, "check", "Confirmez avec « Installer »", "Fulmo s'ouvre ensuite dans sa propre fenêtre.")
      ];
    }
    var done = el("button", { class: "btn btn-volt", type: "button", onclick: function () { closeSheet(); } }, "J'ai compris");
    sheet({
      title: title,
      body: [
        el("p", { class: "muted install-lede", text: "Fulmo s'ouvre alors en plein écran, d'un geste, comme une application." }),
        el("ol", { class: "install-steps" }, steps),
        note ? el("p", { class: "install-note" }, [icon("warn", 15), el("span", { text: note })]) : null
      ],
      foot: [done],
      initialFocus: done
    });
  }

  function viewSettings() {
    var premium = state.plan === "premium";

    /* Toute la ligne est l'interrupteur : le libellé se touche aussi. */
    function switchRow(label, hint, checked, onChange) {
      return el("button", {
        class: "set-row switch-row", type: "button", role: "switch",
        "aria-checked": checked ? "true" : "false", onclick: onChange
      }, [
        el("span", { class: "txt" }, [el("b", { text: label }), hint ? el("span", { text: hint }) : null]),
        el("span", { class: "switch", "aria-hidden": "true" }, [el("i")])
      ]);
    }
    function exportData() {
      // En ligne, l'export complet (compte, foyers, consentements) vient du serveur.
      if (cloud) { window.location.assign(cloud.exportUrl); return; }
      var payload = {
        exported_at: new Date().toISOString(), format: "fulmo.export.v1",
        // Le compte sans l'empreinte du mot de passe : elle n'apprend rien à
        // personne et n'a pas à circuler dans un fichier.
        account: state.account ? {
          name: state.account.name, email: state.account.email,
          created_at: state.account.createdAt ? new Date(state.account.createdAt).toISOString() : null,
          terms: state.account.terms || null
        } : null,
        plan: state.plan, consents: state.consents || {},
        household: state.household, locations: state.locations, items: state.items,
        history: state.history, scans: state.scans
      };
      var filename = "fulmo-export-" + new Date().toISOString().slice(0, 10) + ".json";
      var data = JSON.stringify(payload, null, 2);
      if (downloadsApi) {
        downloadsApi.save({ filename: filename, data: data })
          .then(function () { toast("Export enregistré."); })
          // Le visiteur peut refuser : ce n'est pas une erreur.
          .catch(function () { toast("Export annulé."); });
        return;
      }
      // Navigateur nu : un simple téléchargement. Le bouton n'existait pas
      // hors de la passerelle, et l'export était introuvable.
      try {
        var url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
        var link = el("a", { href: url, download: filename, style: "display:none" });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast("Export téléchargé : " + filename);
      } catch (e) {
        toast("L'export n'a pas pu être créé dans ce navigateur.");
      }
    }

    var household = state.household || {};
    var roomsCount = state.locations.filter(function (l) { return !l.parentId; }).length;

    return el("div", { class: "page" }, [
      el("h1", { class: "display t-lg", text: "Réglages" }),

      el("section", { class: "set-section" }, [
        el("h2", { text: "Foyer et compte" }),
        el("div", { class: "set-group" }, [
          el("div", { class: "set-row" }, [
            el("span", { class: "fig" }, [sym(household.type === "house" ? "h-maison" : "h-appart", 22)]),
            el("span", { class: "txt" }, [
              el("b", { text: household.name || "Mon logement" }),
              el("span", { text: plural(roomsCount, "pièce", "pièces") + " · " + plural(state.items.length, "objet", "objets") })
            ]),
            state.household && (!cloud || cloud.role() === "admin") ? el("button", { class: "btn btn-sm btn-line", type: "button", "aria-label": "Renommer le logement", onclick: homeSheet }, [icon("pencil", 14), "Renommer"]) : null
          ]),
          el("div", { class: "set-row" }, [
            el("span", { class: "fig" }, [icon("shield", 19)]),
            el("span", { class: "txt" }, [
              el("b", { text: state.account ? state.account.name : "—" }),
              el("span", { text: state.account ? state.account.email : "" })
            ]),
            // La démonstration se remet à zéro à chaque ouverture : rien à y modifier.
            // En ligne, seulement si l'application sait enregistrer ces changements.
            state.account && !tourIsDemo() && (!cloud || typeof cloud.updateAccount === "function") ? el("button", { class: "btn btn-sm btn-line", type: "button", "aria-label": "Modifier mes informations", onclick: accountSheet }, [icon("pencil", 14), "Modifier"]) : null
          ]),
          el("div", { class: "set-actions" }, [
            el("button", { class: "btn btn-line", type: "button", onclick: obLogout }, [icon("logout", 15), "Se déconnecter"])
          ])
        ])
      ]),

      cloud ? cloudHouseholdSection() : null,

      appInstalled() ? null : el("section", { class: "set-section" }, [
        el("h2", { text: "Application" }),
        el("div", { class: "set-group" }, [
          el("div", { class: "set-row" }, [
            el("span", { class: "fig" }, [icon("phone", 19)]),
            el("span", { class: "txt" }, [
              el("b", { text: "Fulmo sur l'écran d'accueil" }),
              el("span", { text: "Une icône pour ouvrir Fulmo d'un geste, en plein écran, comme une application." })
            ]),
            el("button", { class: "btn btn-sm btn-volt", type: "button", onclick: installApp }, [icon("add-box", 14), installPrompt ? "Installer" : "Ajouter"])
          ])
        ])
      ]),

      el("section", { class: "set-section" }, [
        el("h2", { text: "Formule" }),
        el("div", { class: "set-group" }, [
          el("div", { class: "set-row" }, [
            el("span", { class: "fig" + (premium ? " volt" : "") }, [icon("bolt", 19)]),
            el("span", { class: "txt" }, [
              el("b", { text: premium ? "Éclair — offert pendant la bêta" : "Libre — gratuit" }),
              el("span", { text: premium ? "Scan Éclair, plan du logement, espace 3D et recherche en langage naturel." : "Recherche, lieux et alertes. Passez à l'Éclair pour le scan, le plan et l'IA." })
            ])
          ]),
          cloud ? null : switchRow(
            premium ? "Éclair activé" : "Activer l'Éclair",
            "Pendant la bêta, l'Éclair est offert aux early adopters, sans paiement. Ensuite 9 €/mois, uniquement avec votre accord : vous serez prévenu avant.",
            premium,
            function () {
              state.plan = premium ? "free" : "premium";
              save(); render();
              toast(state.plan === "premium" ? "Éclair activé." : "Retour à la formule Libre.");
            }
          )
        ])
      ]),

      el("section", { class: "set-section" }, [
        el("h2", { text: "Apparence" }),
        el("div", { class: "set-group" }, [
          el("div", { class: "set-row" }, [
            el("span", { class: "txt" }, [
              el("b", { text: "Thème" }),
              el("span", { text: "Le clair pour chercher en plein jour, le sombre pour le soir." })
            ]),
            el("div", { class: "seg", role: "radiogroup", "aria-label": "Thème" }, [
              ["light", "Clair", "sun"], ["dark", "Sombre", "moon"]
            ].map(function (option) {
              var on = state.theme === option[0];
              return el("button", {
                type: "button", role: "radio", "aria-checked": on ? "true" : "false",
                onclick: function () { if (!on) { state.theme = option[0]; applyTheme(); save(); render(); } }
              }, [icon(option[2], 15), option[1]]);
            }))
          ])
        ])
      ]),

      el("section", { class: "set-section" }, [
        el("h2", { text: "Aide" }),
        el("div", { class: "set-group" }, [
          el("div", { class: "set-row" }, [
            el("span", { class: "fig" }, [icon("spark", 19)]),
            el("span", { class: "txt" }, [
              el("b", { text: "Visite guidée" }),
              el("span", { text: "Les menus un par un, puis un objet rangé et retrouvé. Deux minutes." })
            ]),
            el("button", { class: "btn btn-sm btn-line tour-replay", type: "button", onclick: tourStart }, "Revoir la visite guidée")
          ])
        ])
      ]),

      el("section", { class: "set-section" }, [
        el("h2", { text: "Vos données" }),
        el("div", { class: "set-group" }, [
          el("div", { class: "set-row" }, [
            el("span", { class: "fig" }, [icon("shield", 19)]),
            el("span", { class: "txt" }, [
              el("b", { text: cloud ? "Enregistrées en Europe" : "Stockées sur cet appareil" }),
              el("span", { text: cloud
                ? "Votre foyer et vos objets sont enregistrés sur nos serveurs dans l'Union européenne, visibles des seuls membres du foyer. La phrase d'une recherche IA et la photo d'un Scan Éclair partent vers l'assistant, avec votre accord ; les relevés 3D restent sur l'appareil qui les a faits."
                : "Rien n'est envoyé à un serveur. Seules la phrase d'une recherche IA et la photo d'un Scan Éclair partent vers l'assistant, avec votre accord." })
            ])
          ]),
          switchRow(
            "Fonctions d'IA",
            aiConsented()
              ? "Accord donné le " + new Date(state.consents.ai.at).toLocaleDateString("fr-FR") + ". Désactivez pour ne plus rien envoyer au fournisseur d'IA (Anthropic, États-Unis)."
              : "Désactivées. Activez pour envoyer vos recherches en langage naturel et vos photos de Scan Éclair au fournisseur d'IA (Anthropic, États-Unis).",
            aiConsented(),
            function () {
              if (aiConsented()) { aiConsentSet(false); render(); toast("Fonctions d'IA désactivées."); return; }
              aiConsentThen(function () { render(); toast("Fonctions d'IA activées."); });
            }
          ),
          el("div", { class: "set-actions" }, [
            el("button", { class: "btn btn-line", type: "button", onclick: exportData }, [icon("download", 15), "Exporter en JSON"]),
            el("button", { class: "btn btn-danger-line", type: "button", onclick: deleteAccount }, [icon("trash", 15), "Supprimer mon compte"]),
            cloud ? null : el("button", { class: "btn btn-danger-line", type: "button", onclick: confirmReset }, [icon("trash", 15), "Tout effacer"])
          ])
        ])
      ]),

      el("section", { class: "set-section" }, [
        el("h2", { text: "Informations légales" }),
        el("ul", { class: "set-group set-list" }, [
          ["Mentions légales", "mentions-legales.html"],
          ["Politique de confidentialité", "confidentialite.html"],
          ["Conditions générales d'utilisation et de vente", "conditions.html"]
        ].map(function (link) {
          return el("li", {}, [icon("chev", 14), el("a", { href: siteUrl(link[1]), target: "_blank", rel: "noopener", text: link[0] })]);
        }).concat([
          cloud ? null : el("li", {}, [icon("chev", 14), el("a", { href: "confidentialite.html#cookies", "data-consent-open": "", text: "Gérer les cookies" })])
        ]))
      ]),

      cloud ? null : el("section", { class: "set-section" }, [
        el("h2", { text: "Ce qui diffère de la vraie application" }),
        el("ul", { class: "set-group set-list" }, [
          "L'inscription n'envoie pas d'email de confirmation et n'appelle pas Supabase Auth.",
          "La connexion avec Google ou Apple n'existe que dans l'application en ligne.",
          "L'abonnement ne passe pas par Stripe : la bascule Éclair est libre.",
          "Le foyer partagé et les invitations par email ne sont pas rejouables sans serveur.",
          "Les données vivent dans ce navigateur, pas dans PostgreSQL avec sa Row Level Security.",
          "Le moteur de recherche, lui, est le portage fidèle de la logique SQL : accents, casse, préfixes et fautes de frappe."
        ].map(function (line) {
          return el("li", {}, [icon("chev", 14), el("span", { text: line })]);
        }))
      ])
    ]);
  }

  /* En ligne : les membres du foyer (page de l'application) et, pour qui en a
     plusieurs, le choix du foyer affiché. */
  function cloudHouseholdSection() {
    var role = cloud.role();
    var roleText = role === "admin" ? "Administrateur : vous gérez les membres et leurs droits."
      : role === "member" ? "Membre : vous ajoutez et modifiez les objets."
      : "Invité : vous consultez le foyer sans le modifier.";
    var others = cloud.households().filter(function (h) { return h.id !== cloud.householdId(); });
    return el("section", { class: "set-section" }, [
      el("h2", { text: "Foyer partagé" }),
      el("div", { class: "set-group" }, [
        el("div", { class: "set-row" }, [
          el("span", { class: "fig" }, [icon("share", 19)]),
          el("span", { class: "txt" }, [
            el("b", { text: "Membres du foyer" }),
            el("span", { text: roleText })
          ]),
          el("a", { class: "btn btn-sm btn-line", href: cloud.membersUrl() }, [icon("arrow-right", 14), role === "admin" ? "Gérer" : "Voir"])
        ])
      ].concat(others.map(function (h) {
        return el("div", { class: "set-row" }, [
          el("span", { class: "fig" }, [sym("h-appart", 22)]),
          el("span", { class: "txt" }, [
            el("b", { text: h.name }),
            el("span", { text: "Un autre foyer dont vous êtes membre." })
          ]),
          el("button", { class: "btn btn-sm btn-line", type: "button", onclick: function () { cloud.switchTo(h.id); } }, [icon("loop", 14), "Ouvrir"])
        ]);
      })))
    ]);
  }

  function paywall(title, body) {
    return el("div", { class: "page" }, [
      el("div", { class: "empty" }, [
        el("div", { class: "blob", style: "background:color-mix(in oklab, var(--volt) 14%, transparent);color:var(--accent)" }, [icon("bolt", 26)]),
        el("span", { class: "label badge", text: "Fonction Éclair" }),
        el("h1", { class: "display t-md", style: "margin-top:6px", text: title }),
        el("p", { class: "lede", style: "max-width:44ch", text: body }),
        // En ligne, la formule est celle du compte : elle ne se bascule pas ici.
        cloud ? null : el("button", {
          class: "btn btn-lg btn-volt", type: "button", style: "margin-top:10px",
          onclick: function () { state.plan = "premium"; save(); render(); toast("Éclair activé : offert pendant la bêta."); }
        }, [icon("bolt", 16), "Activer l'Éclair (offert pendant la bêta)"]),
        el("p", { class: "muted", style: "font-size:.75rem;max-width:40ch", text: "Offert aux early adopters pendant la bêta, sans carte bancaire. Ensuite 9 €/mois, uniquement avec votre accord." })
      ])
    ]);
  }

  /* ─── Feuille d'objet ─────────────────────────────────────────────── */

  /* `hooks` (facultatif) : { onSaved(objet), onClose() } — la visite guidée
     s'en sert pour suivre la fiche sans la réécrire. */
  function itemSheet(item, defaultName, hooks) {
    hooks = hooks || {};
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

    var nameInput, nameError;

    function commit() {
      var name = draft.name.trim();
      // Un nom vide ne s'enregistrait pas, sans rien dire : on le dit, là où
      // il manque.
      if (!name) {
        nameInput.setAttribute("aria-invalid", "true");
        nameError.hidden = false;
        nameInput.focus();
        return;
      }

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
      if (hooks.onSaved) hooks.onSaved(item || payload);
      else toast(item ? "Objet enregistré." : "Objet référencé.");
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
      onClose: hooks.onClose,
      body: [
        el("label", { class: "field" }, [
          el("span", { text: "Nom de l'objet" }),
          nameInput = el("input", {
            class: "input", style: "font-size:1.0625rem", value: draft.name, maxlength: 120,
            placeholder: "Perceuse, passeport, guirlande…",
            // Le clavier ne s'ouvre d'office que pour un nouvel objet : on
            // ouvre une fiche existante pour la lire, pas pour la retaper.
            autofocus: !item, "aria-describedby": "item-name-err",
            oninput: function (event) {
              draft.name = event.target.value;
              if (draft.name.trim()) { event.target.removeAttribute("aria-invalid"); nameError.hidden = true; }
            },
            onkeydown: function (event) { if (event.key === "Enter") { event.preventDefault(); commit(); } }
          }),
          nameError = el("span", { class: "err", id: "item-name-err", role: "alert", hidden: true, text: "Donnez un nom à l'objet pour pouvoir le retrouver." }),
          el("span", { class: "field-hint", text: "Nommez-le comme vous le chercherez plus tard." })
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
          class: "btn btn-danger-line", type: "button", style: "align-self:flex-start",
          onclick: function () {
            confirmSheet({
              title: "Supprimer « " + item.name + " » ?",
              body: "L'objet disparaît de l'inventaire et des recherches. Cette action est définitive.",
              confirmLabel: "Supprimer",
              danger: true,
              // Annuler ramène à la fiche, pas à la page.
              onCancel: function () { itemSheet(item); },
              onConfirm: function () {
                state.items = state.items.filter(function (i) { return i.id !== item.id; });
                save(); render(); toast("Objet supprimé.");
              }
            });
          }
        }, [icon("trash", 15), "Supprimer cet objet"]) : null
      ],
      foot: [
        el("button", { class: "btn btn-lg btn-volt", type: "button", style: "width:100%", onclick: commit, text: "Enregistrer" })
      ]
    });

    return card;
  }

  /* ═══ Visite guidée ══════════════════════════════════════════════════

     À la première entrée dans l'application, un voile sombre et flou couvre
     l'écran ; un seul projecteur net, cerclé de volt, glisse d'un élément à
     l'autre et une bulle de verre explique. La visite navigue vraiment : elle
     ouvre chaque onglet, éclaire d'abord son entrée, puis la zone utile de la
     vue. Elle finit par le geste qui compte — référencer un objet — dans la
     vraie fiche d'ajout, puis le retrouve.

     Contrainte de fond : render() reconstruit #root. Tout ce qui appartient à
     la visite vit donc dans <body>, hors de #root, et une boucle
     requestAnimationFrame relit à chaque image la position de la cible —
     rendu, défilement, redimensionnement, défilement interne d'une feuille :
     le projecteur suit tout, sans écouteur à rebrancher. */

  var tour = null;
  var tourPending = null;
  var tourFoundId = null;   // l'objet que la recherche fait pulser à la fin

  function tourIsDemo() {
    return !!(state.account && accountKey(state.account.email) === accountKey(DEMO_ACCOUNT.email));
  }
  function tourWide() { return window.innerWidth >= 900; }    // le rail est visible
  function tourPhone() { return window.innerWidth < 640; }
  function tourFirstName() {
    return state.account && state.account.name ? String(state.account.name).trim().split(/\s+/)[0] : "";
  }

  /* Le premier élément VISIBLE qui répond : sur mobile le rail existe mais
     il est masqué, et c'est l'onglet de la barre du bas qu'il faut éclairer. */
  function tourQ(selector) {
    if (!selector) return null;
    if (typeof selector === "function") return selector();
    var list = document.querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return list[i];
    }
    return null;
  }

  function tourSteps() {
    var premium = state.plan === "premium";
    var wide = tourWide();
    var hasItems = state.items.length > 0;
    var first = tourFirstName();
    function tab(id) { return wide ? '.rail-btn[data-tab="' + id + '"]' : '.tabbar .tab[data-tab="' + id + '"]'; }

    return [
      { id: "welcome", tab: "search", hero: true,
        title: "Bienvenue dans votre maison" + (first ? ", " + first : ""),
        text: "Fulmo retient où vous rangez chaque chose, et vous le retrouve en deux secondes. Un tour des menus, puis vous rangerez votre premier objet.",
        next: "Commencer la visite", prevLabel: "Plus tard" },

      { id: "search", tab: "search", target: ".search-box",
        title: "Chercher, tout simplement",
        text: "Tapez ce que vous cherchez, même mal : « pasport » trouve le passeport. Chaque résultat dit où il est rangé — pièce › meuble › contenant." },

      { id: "filters", tab: "search", target: ".search-filters", eclair: !premium,
        title: "Mots-clés et recherche avec vos mots",
        text: premium
          ? "Un mot-clé regroupe d'un geste : noël, papiers, outillage. « Avec mes mots » comprend une phrase — « le truc pour gonfler le matelas ». Seule la phrase part vers l'IA, jamais votre inventaire."
          : "Un mot-clé regroupe d'un geste : noël, papiers, outillage. La recherche « Avec mes mots », qui comprend une phrase entière, fait partie de l'Éclair." },

      wide
        ? { id: "cmdk", tab: "search", target: ".rail-head .kbd-hint",
            title: "⌘K, de partout",
            text: "Où que vous soyez, ⌘K (Ctrl K sous Windows) ou la touche « / » ouvrent la recherche par-dessus l'écran. Objets, lieux et actions au même endroit." }
        : { id: "cmdk", tab: "places", target: ".app-head .cmdk-trigger",
            title: "La recherche, de partout",
            text: "En haut de chaque écran, ce champ ouvre la recherche par-dessus ce que vous faisiez. Objets, lieux et actions au même endroit." },

      { id: "places", tab: "places", tabTarget: tab("places"), target: ".tree",
        title: "Mes lieux",
        text: "L'architecture de votre logement : pièce › meuble › contenant. Ajoutez un tiroir, renommez une étagère, changez une icône quand vous voulez." },

      { id: "scan", tab: "scan", tabTarget: tab("scan"), target: premium ? ".scan-stage" : ".page .empty", eclair: !premium,
        title: "Scan Éclair",
        text: premium
          ? "Photographiez une étagère ou un tiroir : l'IA reconnaît les objets et pré-remplit leurs fiches. Vous décochez, corrigez, validez."
          : "Photographiez un tiroir, l'IA reconnaît les objets et pré-remplit leurs fiches. C'est une fonction Éclair : vous pourrez l'essayer depuis cet écran." },

      { id: "map", tab: "map", tabTarget: tab("map"), target: premium ? ".floors" : ".page .empty", eclair: !premium,
        title: "Plan et Espace 3D",
        text: premium
          ? "Votre logement en coupe, étage par étage : chaque pièce montre ce qu'elle contient. La bascule « Espace 3D » ouvre une pièce relevée en volume, où la recherche désigne le rangement."
          : "Le plan en coupe et l'Espace 3D montrent le rangement au lieu de l'épeler. Deux fonctions Éclair, à découvrir quand vous voulez." },

      { id: "alerts", tab: "alerts", tabTarget: tab("alerts"), target: ".alert-group, .all-clear",
        title: "Alertes",
        text: "Péremptions, fins de garantie, objets prêtés : tout ce qui a une date remonte ici avant qu'il soit trop tard. La date se saisit dans la fiche de l'objet." },

      { id: "settings", tab: "settings", tabTarget: wide ? ".rail-home" : ".app-head .head-avatar", target: ".set-section",
        title: "Votre foyer et les réglages",
        text: "Votre foyer, sa formule, le thème clair ou sombre, l'export de vos données en un fichier. Dans la version en ligne, c'est ici que vous inviterez votre foyer à partager l'inventaire." },

      { id: "add", tab: "search", target: ".add-item-btn", interactive: true,
        title: hasItems ? "Et maintenant, un objet de plus" : "À vous : votre premier objet",
        text: "Tout part de là : ranger. La fiche va s'ouvrir, et la visite vous guide champ par champ.",
        next: hasItems ? "Ajouter un autre objet" : "Ajouter mon premier objet", action: tourOpenSheet },

      { id: "name", live: true, target: ".sheet .field",
        title: "Son nom",
        text: "Nommez-le comme vous le chercherez plus tard. Une idée pour commencer :",
        suggest: ["Passeport", "Clés de la cave", "Chargeur de téléphone"],
        canNext: function () { var input = tourQ(".sheet .field input"); return !!(input && input.value.trim()); } },

      { id: "place", live: true,
        target: function () { var list = tourQ(".sheet .loc-list"); return list ? list.closest(".field") : null; },
        title: "Où est-il rangé ?",
        text: "Choisissez le rangement le plus précis : un tiroir vaut mieux qu'une pièce. Tapez pour filtrer la liste." },

      { id: "save", live: true, target: ".sheet-foot .btn-volt", noNext: true,
        title: "Enregistrez",
        text: "Un geste, et c'est retenu. Touchez « Enregistrer »." },

      { id: "found", tab: "search", target: ".result.found", ending: true,
        title: "Voilà. Rangez, puis demandez.",
        text: "Il se retrouve en une frappe, avec son chemin. Tout Fulmo tient dans ce geste. La visite reste dans les Réglages si vous voulez la revoir.",
        next: "Terminer" }
    ];
  }

  /* Démarre la visite. Rien ne s'impose une seconde fois : l'état « vue »
     est enregistré dès la fin ou l'abandon. */
  function tourStart() {
    if (tour || !state.household) return;
    clearTimeout(tourPending);
    tourPending = null;
    closePalette();
    closeSheet();

    var veil = el("div", { class: "tour-veil" });
    var spot = el("div", { class: "tour-spot", "aria-hidden": "true" });
    var arrow = el("i", { class: "tour-arrow", "aria-hidden": "true" });
    var bubble = el("section", { class: "tour-bubble", "aria-labelledby": "tour-title" });
    var live = el("p", { class: "sr-only", "aria-live": "polite" });
    var overlay = el("div", { class: "tour", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-title" },
      [veil, spot, bubble, live]);
    bubble.appendChild(arrow);
    // Un clic à côté ne fait rien : la visite ne se ferme que par « Passer ».
    veil.addEventListener("click", function (event) { event.preventDefault(); });
    document.body.appendChild(overlay);

    tour = {
      overlay: overlay, veil: veil, spot: spot, bubble: bubble, arrow: arrow, live: live,
      steps: tourSteps(), index: -1, rect: null, drawn: "", side: null,
      previous: document.activeElement, closingSheet: false
    };
    document.addEventListener("keydown", tourKey, true);
    window.addEventListener("resize", tourOnResize);
    requestAnimationFrame(function () { if (tour) overlay.classList.add("is-on"); });
    tour.raf = requestAnimationFrame(tourFrame);
    tourShow(0);
  }

  function tourEnd(completed, message) {
    if (!tour) return;
    var closing = tour;
    tour = null;
    cancelAnimationFrame(closing.raf);
    document.removeEventListener("keydown", tourKey, true);
    window.removeEventListener("resize", tourOnResize);
    root.inert = false;
    state.tourSeen = true;
    save();
    closing.overlay.classList.remove("is-on");
    closing.overlay.classList.add("is-leaving");
    setTimeout(function () { closing.overlay.remove(); }, reduceMotion() ? 0 : 320);
    setTimeout(function () { tourFoundId = null; }, 2400);
    if (message) toast(message);
    else if (!completed) toast("Visite interrompue. Elle vous attend dans les Réglages.");
    if (closing.previous && closing.previous.isConnected && closing.previous.focus) {
      try { closing.previous.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  /* Affiche une étape : navigue vers sa vue si besoin, prépare la bulle, et
     laisse la boucle d'animation faire glisser le projecteur. */
  function tourShow(index) {
    if (!tour) return;
    var steps = tour.steps;
    index = Math.max(0, Math.min(steps.length - 1, index));
    var step = steps[index];
    var before = steps[tour.index];

    // Revenir de la fiche vers la visite : on referme la fiche sans que sa
    // fermeture soit prise pour un abandon.
    if (before && before.live && !step.live && openSheet) {
      tour.closingSheet = true;
      closeSheet();
      tour.closingSheet = false;
    }

    tour.index = index;
    if (step.tab && (state.tab !== step.tab || (step.tab === "map" && mapMode !== "2d"))) {
      if (step.tab === "map") mapMode = "2d";
      closePalette();
      state.tab = step.tab;
      save();
      render();
    }

    var now = performance.now();
    tour.phase = step.tabTarget && !reduceMotion() ? "tab" : "zone";
    tour.phaseAt = now;
    tour.tween = { from: tour.rect, t0: now };
    tour.scrolled = false;
    tour.side = null;
    tour.hold = false;

    // Pendant la finale, la fiche reste utilisable : seule la page derrière
    // est rendue inerte.
    root.inert = !step.interactive;
    tour.overlay.setAttribute("aria-modal", step.live || step.interactive ? "false" : "true");
    tour.overlay.classList.toggle("is-live", !!step.live);
    tour.overlay.classList.toggle("is-interactive", !!(step.live || step.interactive));

    tourPaintBubble(step);
    tour.live.textContent = "Étape " + (index + 1) + " sur " + steps.length + ". " + step.title + ". " + step.text;
  }

  /* Typographie française : pas de guillemet ni de deux-points orphelin en
     bout de ligne. */
  function tourTypo(text) {
    return String(text).replace(/« /g, "« ").replace(/ (»|:|\?|!|;)/g, " $1");
  }

  function tourPaintBubble(step) {
    var b = tour.bubble;
    var index = tour.index, total = tour.steps.length;
    var first = index === 0;
    var next = step.noNext ? null : el("button", {
      class: "btn btn-sm btn-volt tour-next", type: "button",
      onclick: tourNext
    }, [step.next || "Suivant", step.ending || step.action ? null : icon("arrow-right", 14)]);
    var prev = step.ending ? null : el("button", {
      class: "btn btn-sm btn-quiet tour-prev", type: "button",
      onclick: first ? function () { tourEnd(false); } : tourPrev
    }, first ? (step.prevLabel || "Plus tard") : [icon("arrow-left", 14), "Précédent"]);

    var body = [
      el("div", { class: "tour-top" }, [
        el("span", { class: "tour-count", text: (index + 1) + " / " + total }),
        el("span", { class: "tour-bar", "aria-hidden": "true" }, [el("i", { style: "--p:" + ((index + 1) / total).toFixed(3) })]),
        step.ending || first ? null : el("button", {
          class: "tour-skip", type: "button", onclick: function () { tourEnd(false); }
        }, "Passer")
      ]),
      step.hero ? el("span", { class: "tour-mark", "aria-hidden": "true" }, [icon("bolt", 22)]) : null,
      el("h2", { class: "tour-title", id: "tour-title", text: tourTypo(step.title) }),
      el("p", { class: "tour-text", text: tourTypo(step.text) }),
      step.eclair ? el("p", { class: "tour-eclair" }, [icon("bolt", 13), "Fonction Éclair"]) : null,
      step.suggest ? el("div", { class: "tour-suggest" }, step.suggest.map(function (word) {
        return el("button", {
          class: "chip chip-sm", type: "button",
          onclick: function () {
            var input = tourQ(".sheet .field input");
            if (!input) return;
            input.value = word;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.focus({ preventScroll: true });
          }
        }, word);
      })) : null,
      el("div", { class: "tour-actions" }, [prev, el("span", { class: "spacer" }), next])
    ];
    b.replaceChildren.apply(b, [tour.arrow].concat(body.filter(Boolean)));
    b.classList.toggle("is-hero", !!step.hero);
    b.classList.remove("is-in");
    void b.offsetWidth;
    b.classList.add("is-in");

    // Le focus va au bouton principal — sauf pendant la saisie de la fiche,
    // où il reste dans le champ.
    if (!step.live && next) { try { next.focus({ preventScroll: true }); } catch (e) {} }
  }

  function tourNext() {
    if (!tour) return;
    var step = tour.steps[tour.index];
    if (step.canNext && !step.canNext()) {
      var input = tourQ(".sheet .field input");
      if (input) input.focus();
      tour.bubble.classList.remove("is-nudge");
      void tour.bubble.offsetWidth;
      tour.bubble.classList.add("is-nudge");
      return;
    }
    if (step.ending) { tourEnd(true); return; }
    if (step.action) { step.action(); return; }
    // L'étape « enregistrer » ne s'achève que par l'enregistrement.
    if (step.noNext) return;
    tourShow(tour.index + 1);
  }

  function tourPrev() {
    if (!tour || tour.index === 0) return;
    tourShow(tour.index - 1);
  }

  function tourOnResize() { if (tour) tour.side = null; }

  function tourKey(event) {
    if (!tour) return;
    var step = tour.steps[tour.index];
    var active = document.activeElement;
    var typing = !!(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));

    // Pendant la finale, la fiche garde son clavier : Échap la ferme (et
    // arrête la visite), Tab reste dans la fiche.
    if (step.live) {
      if (!typing && event.key === "ArrowRight") { event.preventDefault(); tourNext(); }
      else if (!typing && event.key === "ArrowLeft") { event.preventDefault(); tourPrev(); }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); tourEnd(false); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); tourNext(); return; }
    if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); tourPrev(); return; }
    if (event.key === "/" || ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === "k")) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.key === "Tab") {
      // Piège de focus : la bulle, plus la cible quand on peut la toucher.
      var nodes = Array.prototype.filter.call(tour.bubble.querySelectorAll("button"), function (n) { return !n.disabled; });
      if (step.interactive) {
        var target = tourQ(step.target);
        if (target) nodes.unshift(target);
      }
      if (!nodes.length) return;
      var at = nodes.indexOf(active);
      event.preventDefault();
      event.stopPropagation();
      nodes[at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length].focus();
    }
  }

  /* ─── Géométrie : le trou, le projecteur, la bulle ─────────────────── */

  function tourHole(node) {
    var r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    var pad = r.height < 48 ? 6 : 10;
    var W = window.innerWidth, H = window.innerHeight;
    var x = Math.max(6, r.left - pad), y = Math.max(6, r.top - pad);
    var x2 = Math.min(W - 6, r.right + pad), y2 = Math.min(H - 6, r.bottom + pad);
    if (x2 - x < 8 || y2 - y < 8) return null;
    return { x: x, y: y, w: x2 - x, h: y2 - y, r: Math.min(18, (y2 - y) / 2) };
  }

  function tourCenterHole() {
    return { x: window.innerWidth / 2, y: window.innerHeight * 0.42, w: 0, h: 0, r: 0 };
  }

  function tourMix(a, b, k) {
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k, r: a.r + (b.r - a.r) * k };
  }

  /* Le voile est découpé d'un rectangle arrondi (règle pair-impair) : le
     flou et l'ombre s'arrêtent net au bord du projecteur, et les clics
     passent au travers du trou jusqu'à la cible. */
  function tourPath(h) {
    var W = window.innerWidth, H = window.innerHeight;
    var p = "M0 0H" + W + "V" + H + "H0Z";
    if (h && h.w > 1 && h.h > 1) {
      var f = function (n) { return Math.round(n * 10) / 10; };
      var r = f(Math.min(h.r, h.w / 2, h.h / 2)), x = f(h.x), y = f(h.y), w = f(h.w), hh = f(h.h);
      p += "M" + f(x + r) + " " + y + "H" + f(x + w - r) +
        "A" + r + " " + r + " 0 0 1 " + f(x + w) + " " + f(y + r) + "V" + f(y + hh - r) +
        "A" + r + " " + r + " 0 0 1 " + f(x + w - r) + " " + f(y + hh) + "H" + f(x + r) +
        "A" + r + " " + r + " 0 0 1 " + x + " " + f(y + hh - r) + "V" + f(y + r) +
        "A" + r + " " + r + " 0 0 1 " + f(x + r) + " " + y + "Z";
    }
    return 'path(evenodd, "' + p + '")';
  }

  /* La cible est amenée à l'écran une fois par étape, là où la bulle ne la
     couvrira pas. Dans une feuille, c'est le corps de la feuille qui défile. */
  function tourReveal(node, step) {
    if (node.closest(".tabbar, .rail, .app-head")) return;
    var smooth = reduceMotion() ? "auto" : "smooth";
    if (node.closest(".sheet")) { node.scrollIntoView({ block: "nearest", behavior: smooth }); return; }
    var r = node.getBoundingClientRect();
    var head = document.querySelector(".app-head");
    var topLimit = (head && head.offsetParent ? head.getBoundingClientRect().bottom : 0) + 20;
    var bottomLimit = window.innerHeight - 24;
    if (tourPhone() && !step.live) bottomLimit = window.innerHeight - tour.bubble.offsetHeight - 110;
    if (r.top >= topLimit && r.bottom <= bottomLimit) return;
    var room = bottomLimit - topLimit;
    var delta = r.height < room ? r.top - topLimit - Math.max(0, (room - r.height) / 4) : r.top - topLimit;
    window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: smooth });
  }

  function tourPlace(hole, step, waiting) {
    var b = tour.bubble;
    var docked = tourPhone() && !step.live;
    b.classList.toggle("is-docked", docked);
    b.classList.toggle("is-waiting", !!waiting);
    if (docked) {
      b.style.transform = "";
      tour.arrow.className = "tour-arrow";
      // Rangée en bas, la bulle ne doit pas couvrir la cible : si la page ne
      // peut plus défiler pour la remonter, la bulle passe en haut.
      var dockTop = window.innerHeight - b.offsetHeight - 90;
      b.classList.toggle("is-top", !!(hole && hole.w > 2 && hole.y + hole.h > dockTop && hole.y > b.offsetHeight + 40));
      return;
    }
    var W = window.innerWidth, H = window.innerHeight, m = 14, gap = 18;
    var bw = b.offsetWidth, bh = b.offsetHeight;
    var left, top, side = null;

    if (!hole || hole.w < 2) {
      left = (W - bw) / 2;
      top = Math.max(m, (H - bh) / 2);
    } else {
      var fits = {
        below: H - (hole.y + hole.h) - gap - m >= bh,
        above: hole.y - gap - m >= bh,
        right: W - (hole.x + hole.w) - gap - m >= bw,
        left: hole.x - gap - m >= bw
      };
      var order = tourPhone() ? ["below", "above"] : step.live ? ["right", "left", "below", "above"] : ["below", "above", "right", "left"];
      // Le côté choisi tient tant qu'il reste possible : la bulle ne saute
      // pas d'un bord à l'autre pendant un défilement.
      if (tour.side && fits[tour.side]) side = tour.side;
      else side = order.filter(function (s) { return fits[s]; })[0] || null;
      tour.side = side;

      if (side === "below" || side === "above") {
        left = Math.min(Math.max(m, hole.x + hole.w / 2 - bw / 2), W - bw - m);
        top = side === "below" ? hole.y + hole.h + gap : hole.y - gap - bh;
        tour.arrow.style.setProperty("--a", Math.min(Math.max(22, hole.x + hole.w / 2 - left), bw - 22) + "px");
      } else if (side === "right" || side === "left") {
        top = Math.min(Math.max(m, hole.y + hole.h / 2 - bh / 2), H - bh - m);
        left = side === "right" ? hole.x + hole.w + gap : hole.x - gap - bw;
        tour.arrow.style.setProperty("--a", Math.min(Math.max(22, hole.y + hole.h / 2 - top), bh - 22) + "px");
      } else {
        // Rien ne tient à côté d'une grande zone : la bulle se pose en bas
        // de l'écran, par-dessus, sans flèche.
        left = (W - bw) / 2;
        top = H - bh - m;
      }
    }
    tour.arrow.className = "tour-arrow" + (side ? " is-" + side : "");
    b.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)";
  }

  /* La boucle : où est la cible, où en est le glissement, où poser la
     bulle. Rien n'est réécrit si rien n'a bougé. */
  function tourFrame() {
    if (!tour) return;
    tour.raf = requestAnimationFrame(tourFrame);
    var step = tour.steps[tour.index];
    var now = performance.now();
    var node = null;

    if (tour.phase === "tab") {
      node = tourQ(step.tabTarget);
      if (!node || now - tour.phaseAt > 650) {
        tour.phase = "zone";
        tour.phaseAt = now;
        tour.tween = { from: tour.rect, t0: now };
      }
    }
    if (tour.phase === "zone" && step.target) {
      node = tourQ(step.target);
      if (node && !tour.scrolled) { tour.scrolled = true; tourReveal(node, step); }
    }
    var want = (node && tourHole(node)) || tourCenterHole();
    var k = 1;
    if (tour.tween && !reduceMotion()) {
      var t = Math.min(1, (now - tour.tween.t0) / 560);
      k = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);   // expo out, la courbe de --ease-out
    }
    var from = tour.tween && tour.tween.from ? tour.tween.from : tourCenterHole();
    var cur = k >= 1 ? want : tourMix(from, want, k);
    if (k >= 1) tour.tween = null;
    tour.rect = cur;
    tourDraw(cur, step);
    tourPlace(node ? cur : null, step, tour.phase === "tab" || tour.hold);
  }

  function tourDraw(cur, step) {
    var key = [cur.x, cur.y, cur.w, cur.h, cur.r, window.innerWidth, window.innerHeight].map(Math.round).join(",");
    if (key !== tour.drawn) {
      tour.drawn = key;
      var clip = tourPath(cur);
      tour.veil.style.clipPath = clip;
      tour.veil.style.webkitClipPath = clip;
      var s = tour.spot.style;
      s.transform = "translate(" + cur.x.toFixed(1) + "px," + cur.y.toFixed(1) + "px)";
      s.width = cur.w.toFixed(1) + "px";
      s.height = cur.h.toFixed(1) + "px";
      s.borderRadius = cur.r.toFixed(1) + "px";
    }
    tour.spot.classList.toggle("is-empty", cur.w < 4);
    tour.spot.classList.toggle("is-pass", !!(step.interactive || step.live));
    if (step.canNext) {
      var nextBtn = tour.bubble.querySelector(".tour-next");
      if (nextBtn) nextBtn.classList.toggle("is-muted", !step.canNext());
    }
  }

  /* ─── La finale : un vrai objet, dans la vraie fiche ───────────────── */

  function tourOpenSheet() {
    if (!tour) return;
    closePalette();
    itemSheet(null, "", {
      onSaved: tourSaved,
      onClose: function () {
        if (tour && !tour.closingSheet) tourEnd(false, "Fiche refermée : la visite s'arrête là. Elle vous attend dans les Réglages.");
      }
    });
    tourShow(tour.index + 1);
  }

  function tourSaved(item) {
    if (!tour) return;
    var from = tour.rect;
    // Le temps de la célébration, la bulle se retire et le voile reprend sa
    // profondeur : la lumière part du bouton qu'on vient de toucher.
    tour.hold = true;
    tour.overlay.classList.remove("is-live");
    tourCelebrate(from && from.w > 2 ? from.x + from.w / 2 : window.innerWidth / 2,
                  from && from.h > 2 ? from.y + from.h / 2 : window.innerHeight / 2);
    searchState = { query: item.name, ai: null, aiBusy: false, aiTried: null, filter: null };
    aiResults = null;
    tourFoundId = item.id;
    state.tab = "search";
    save();
    render();
    var end = tour.steps.length - 1;
    setTimeout(function () { if (tour) tourShow(end); }, reduceMotion() ? 0 : 700);
  }

  /* Célébration : un éclair de lumière volt depuis le bouton, une gerbe
     d'étincelles. Bref ; et seulement la lueur si l'on a demandé moins de
     mouvement. */
  function tourCelebrate(x, y) {
    var flash = el("div", { class: "tour-flash", "aria-hidden": "true", style: "--fx:" + Math.round(x) + "px;--fy:" + Math.round(y) + "px" });
    document.body.appendChild(flash);
    setTimeout(function () { flash.remove(); }, 1100);
    if (reduceMotion()) return;

    var canvas = el("canvas", { class: "tour-sparks", "aria-hidden": "true" });
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    document.body.appendChild(canvas);
    var g = canvas.getContext("2d");
    if (!g) { canvas.remove(); return; }
    g.scale(dpr, dpr);
    var parts = [];
    for (var i = 0; i < 64; i++) {
      var a = Math.random() * Math.PI * 2, v = 2.5 + Math.random() * 7.5;
      parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3.2, life: 1, size: 1 + Math.random() * 2.4, white: i % 4 === 0 });
    }
    var t0 = performance.now();
    (function frame(now) {
      g.clearRect(0, 0, window.innerWidth, window.innerHeight);
      parts.forEach(function (p) {
        p.vx *= 0.965; p.vy = p.vy * 0.965 + 0.32;
        p.x += p.vx; p.y += p.vy; p.life -= 0.017;
        if (p.life <= 0) return;
        g.globalAlpha = p.life;
        g.fillStyle = p.white ? "#ffffff" : "#d9ff3d";
        g.beginPath(); g.arc(p.x, p.y, p.size, 0, 6.2832); g.fill();
      });
      if (now - t0 < 1500) requestAnimationFrame(frame);
      else canvas.remove();
    })(t0);
  }

  /* Appelé après chaque rendu : lance la visite à la première entrée d'un
     compte dans l'application — jamais d'office pour la démonstration, qui
     l'a en bouton. Le délai laisse finir la célébration de l'onboarding. */
  function tourAfterRender() {
    if (tour || tourPending) return;
    if (!state.session || !state.account || !state.household || state.tourSeen || tourIsDemo()) return;
    tourPending = setTimeout(function () {
      tourPending = null;
      if (tour || state.tourSeen || !state.household || !state.session || tourIsDemo()) return;
      if (document.querySelector(".ob-celebrate, .cmdk-backdrop") || openSheet) { tourAfterRender(); return; }
      tourStart();
    }, 900);
  }

  /* ─── Thème ───────────────────────────────────────────────────────── */

  /* Le blanc est le défaut du produit, pas une conséquence du système : on
     cherche un objet en plein jour. Le sombre reste à un clic. */
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme === "dark" ? "dark" : "light");
  }

  /* ─── Rendu ───────────────────────────────────────────────────────── */

  /* L'indicateur d'onglet glisse de l'ancien onglet au nouveau (FLIP). */
  function measureIndicators() {
    var out = {};
    [".rail-ind", ".tab-ind"].forEach(function (selector) {
      var node = root.querySelector(selector);
      if (node && node.offsetParent) out[selector] = node.getBoundingClientRect();
    });
    return out;
  }

  function glideIndicators(before) {
    if (reduceMotion() || !Element.prototype.animate) return;
    Object.keys(before).forEach(function (selector) {
      var node = root.querySelector(selector);
      if (!node || !node.offsetParent) return;
      var now = node.getBoundingClientRect();
      var dx = before[selector].left - now.left, dy = before[selector].top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      node.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }],
        { duration: 380, easing: "cubic-bezier(.16, 1, .3, 1)" });
    });
  }
  var lastView = null;

  function afterRender(screen, previousScroll, before) {
    var inApp = !!(state.account && state.household);
    var view = inApp ? state.tab + (state.tab === "map" ? ":" + mapMode : "") : (state.account ? "onboarding" : "signup");
    var entering = view !== lastView;
    lastView = view;
    if (inApp && entering && screen.querySelector) {
      var main = screen.querySelector(".app-main");
      if (main) main.classList.add("view-enter");
    }
    var bar = demoBar();
    if (bar) root.replaceChildren(bar, screen);
    else root.replaceChildren(screen);
    // On garde la position de lecture dans une vue, on repart du haut quand
    // on en change (on arrivait sur « Alertes » au milieu de la page).
    if (inApp) window.scrollTo(0, entering ? 0 : previousScroll);
    if (inApp && entering) glideIndicators(before);
    // `autofocus` n'agit qu'au chargement d'une page, pas sur un nœud inséré
    // ensuite : les champs « renommer » et « ajouter » ne prenaient jamais le focus.
    var auto = root.querySelector("[autofocus]");
    if (inApp && auto && !openSheet && !cmdk && (!document.activeElement || document.activeElement === document.body)) {
      try { auto.focus({ preventScroll: true }); } catch (e) { auto.focus(); }
    }
    tourAfterRender();
  }

  function render() {
    var previousScroll = window.scrollY;
    var before = measureIndicators();

    // Chaque rendu recrée le canevas 3D : la scène précédente est libérée ici,
    // quel que soit l'onglet. Avant, quitter l'Espace 3D laissait sa boucle
    // tourner et son contexte WebGL vivre, un de plus à chaque visite.
    dropScene();

    var screen;
    if (!state.account || !state.session) screen = obAuthScreen();
    else if (!state.household) screen = screenOnboarding();
    else screen = screenApp();

    afterRender(screen, previousScroll, before);
  }

  /* L'adresse propre est getfulmo.com/app : GitHub Pages sert app.html sous
     ce nom. Un ancien lien en .html s'affiche sous la forme courte, sans
     recharger. Pas en local (file://), où /app n'existe pas. */
  if (location.protocol === "https:" && /\/app\.html$/.test(location.pathname)) {
    try { history.replaceState(null, "", location.pathname.replace(/\.html$/, "") + location.search + location.hash); } catch (e) {}
  }

  applyTheme();
  obRoute();   // app#demo / #signup / #login (section inscription)
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

  /* ─── Capacité `sample` ───────────────────────────────────────────────
     Résolue après le premier rendu : la page doit s'afficher immédiatement et
     fonctionner entièrement sans elle. Les deux fonctions qui s'en servent
     s'allument quand elle arrive. */

  if (cloud) {
    // En ligne, l'assistant passe par le serveur de l'application (accord IA,
    // formule et limites y sont vérifiés). Les photos sont réduites ici avant l'envoi.
    sampleApi = true;
    sampleImages = { mediaTypes: ["image/jpeg", "image/png", "image/webp"] };
    sampleChecked = true;
    cloud.attach({
      state: function () { return state; },
      // Le serveur fait foi : on remplace foyer et inventaire, et on redessine
      // seulement si personne n'est en train de saisir.
      apply: function (fresh) {
        Object.keys(fresh).forEach(function (key) { state[key] = fresh[key]; });
        if (!openSheet && !cmdk && !tour) render();
      },
      idle: function () { return !openSheet && !cmdk && !tour; },
      toast: toast
    });
  } else if (window.claude && typeof window.claude.use === "function") {
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
