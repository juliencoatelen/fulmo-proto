/* ═══════════════════════════════════════════════════════════════════════════
   FULMO — consentement aux cookies et traceurs (article 82 de la loi
   Informatique et Libertés, lignes directrices CNIL du 17 septembre 2020).

   Aujourd'hui Fulmo n'écrit que des traceurs strictement nécessaires
   (compte, logement, thème, ce choix lui-même) : ils sont exemptés de
   consentement, donc AUCUN bandeau ne s'affiche. Le module est néanmoins en
   place pour le jour où une catégorie facultative arrive (mesure d'audience,
   support client…) :

     1. passer `enabled: true` sur la catégorie dans CATEGORIES ;
     2. charger le script tiers UNIQUEMENT dans
        FulmoConsent.onChange(function (c) { if (c.audience) … }) ;
     3. incrémenter VERSION : tout le monde est réinterrogé.

   Règles tenues : refuser aussi simple qu'accepter (deux boutons de même
   poids), rien de facultatif avant un clic, choix conservé 6 mois puis
   redemandé, retrait possible à tout moment par le lien « Gérer les cookies ».
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var STORAGE_NAME = "fulmo.consent.v1";   // nom de clé localStorage, pas un secret
  var VERSION = 1;
  var MAX_AGE = 1000 * 60 * 60 * 24 * 182;   // 6 mois (recommandation CNIL)
  var POLICY = "confidentialite.html#cookies";

  var CATEGORIES = [
    {
      id: "necessary", required: true, enabled: true,
      label: "Strictement nécessaires",
      text: "Font fonctionner Fulmo sur votre appareil. Exemptés de consentement, ils ne servent à aucun suivi.",
      items: [
        "fulmo.demo.v2 et fulmo.accounts.v1 (localStorage) : vos comptes, votre logement, vos objets",
        "base IndexedDB « fulmo » : vos relevés 3D et panoramiques",
        "fulmo.theme (localStorage) : thème clair ou sombre",
        "fulmo.consent.v1 (localStorage) : ce choix, conservé 6 mois"
      ]
    },
    {
      id: "audience", required: false, enabled: false,
      label: "Mesure d'audience",
      text: "Compter les visites pour améliorer le site. Désactivée : aucun outil de mesure n'est installé aujourd'hui.",
      items: []
    }
  ];

  var listeners = [];

  function optional() {
    return CATEGORIES.filter(function (c) { return !c.required && c.enabled; });
  }

  function read() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_NAME));
      if (!saved || saved.version !== VERSION) return null;
      if (Date.now() - new Date(saved.date).getTime() > MAX_AGE) return null;
      return saved;
    } catch (e) { return null; }
  }

  function choices() {
    var saved = read();
    var out = { necessary: true };
    optional().forEach(function (c) { out[c.id] = !!(saved && saved.choices && saved.choices[c.id]); });
    return out;
  }

  function write(map) {
    var record = { version: VERSION, date: new Date().toISOString(), choices: map };
    try { localStorage.setItem(STORAGE_NAME, JSON.stringify(record)); } catch (e) {}
    var current = choices();
    listeners.forEach(function (fn) { try { fn(current); } catch (e) {} });
  }

  function all(value) {
    var map = {};
    optional().forEach(function (c) { map[c.id] = value; });
    write(map);
  }

  function node(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];   // html-sûr : appelé uniquement avec des constantes
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  var banner = null;
  function closeBanner() { if (banner) { banner.remove(); banner = null; } }

  function showBanner() {
    if (banner || !optional().length) return;
    banner = node("section", { class: "fc-banner", role: "region", "aria-label": "Cookies" }, [
      node("h2", { text: "Vos choix sur les cookies" }),
      // html-sûr : chaînes constantes du module, aucune saisie utilisateur.
      node("p", { html: "Fulmo utilise des traceurs nécessaires à son fonctionnement et, avec votre accord, d'autres pour " +
        optional().map(function (c) { return c.label.toLowerCase(); }).join(", ") +
        ". Vous pouvez changer d'avis à tout moment. <a href=\"" + POLICY + "\">En savoir plus</a>" }),
      node("div", { class: "fc-actions" }, [
        node("button", { type: "button", text: "Tout refuser", onclick: function () { all(false); closeBanner(); } }),
        node("button", { type: "button", text: "Personnaliser", onclick: function () { open(); } }),
        node("button", { type: "button", text: "Tout accepter", onclick: function () { all(true); closeBanner(); } })
      ])
    ]);
    document.body.appendChild(banner);
  }

  function open() {
    var current = choices();
    var inputs = {};
    var dialog = node("dialog", { class: "fc-dialog", "aria-labelledby": "fc-title" });
    var cats = CATEGORIES.map(function (c) {
      var id = "fc-" + c.id;
      var input = node("input", { type: "checkbox", id: id });
      input.checked = c.required || !!current[c.id];
      if (c.required || !c.enabled) input.disabled = true;
      inputs[c.id] = input;
      return node("div", { class: "fc-cat" }, [
        node("label", { for: id }, [node("b", { text: c.label + (c.required ? " (toujours actifs)" : c.enabled ? "" : " (non utilisée)") })]),
        input,
        node("span", { text: c.text }),
        c.items.length ? node("ul", {}, c.items.map(function (t) { return node("li", { text: t }); })) : null
      ]);
    });
    function finish(map) { if (map) write(map); dialog.close(); dialog.remove(); closeBanner(); }
    dialog.appendChild(node("h2", { id: "fc-title", text: "Gérer les cookies" }));
    // html-sûr : chaîne constante.
    dialog.appendChild(node("p", { html: "Ce que Fulmo enregistre dans votre navigateur, et ce que vous acceptez. " +
      "<a href=\"" + POLICY + "\">Politique de confidentialité</a>" }));
    cats.forEach(function (c) { dialog.appendChild(c); });
    var actions = optional().length
      ? [
          node("button", { type: "button", text: "Tout refuser", onclick: function () { var m = {}; optional().forEach(function (c) { m[c.id] = false; }); finish(m); } }),
          node("button", { type: "button", text: "Enregistrer mes choix", onclick: function () { var m = {}; optional().forEach(function (c) { m[c.id] = inputs[c.id].checked; }); finish(m); } }),
          node("button", { type: "button", text: "Tout accepter", onclick: function () { var m = {}; optional().forEach(function (c) { m[c.id] = true; }); finish(m); } })
        ]
      : [node("button", { type: "button", text: "Fermer", onclick: function () { finish(null); } })];
    dialog.appendChild(node("div", { class: "fc-actions" }, actions));
    dialog.addEventListener("cancel", function () { dialog.remove(); });
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  window.FulmoConsent = {
    open: open,
    get: choices,
    has: function (id) { return !!choices()[id]; },
    onChange: function (fn) { listeners.push(fn); fn(choices()); }
  };

  // Tout élément marqué `data-consent-open` ouvre les préférences, y compris
  // ceux que l'application crée après coup.
  document.addEventListener("click", function (event) {
    var trigger = event.target && event.target.closest ? event.target.closest("[data-consent-open]") : null;
    if (!trigger) return;
    event.preventDefault();
    open();
  });

  function boot() { if (!read()) showBanner(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
