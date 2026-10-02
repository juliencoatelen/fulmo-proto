# Fulmo — la mémoire de votre maison

Fulmo (« éclair » en espéranto) retrouve n'importe quel objet de votre logement en deux secondes :
on décrit ses pièces, ses meubles et ses contenants, on range (ou on photographie une étagère avec le
Scan Éclair), puis on cherche — par mot-clé, en langage naturel, sur le plan ou dans l'espace 3D.

## Structure

```
index.html              Landing page (statique, SEO/GEO, scène 3D Three.js)
app.html                Application (inscription, onboarding, recherche, lieux, plan, 3D, alertes…)
404.html                Page d'erreur
mentions-legales.html, confidentialite.html, conditions.html  Pages juridiques (LCEN, RGPD, CGU/CGV)
assets/js/consent.js    Gestion du consentement aux cookies (bandeau seulement si traceur facultatif)
docs/legal/             Registre des traitements (art. 30 RGPD)
CLAUDE.md               Consignes de sécurité et juridiques à respecter avant toute modification
assets/css/tokens.css   Jetons de design partagés + polices auto-hébergées
assets/css/landing.css  Styles de la landing
assets/css/app.css      Styles de l'application
assets/css/onboarding.css  Inscription, formule, onboarding
assets/js/app.js        Application (JS sans dépendance)
assets/js/pano-*.js     Relevé et visionneuse panoramiques
assets/js/landing.bundle.js  Bundle généré de la landing (ne pas éditer à la main)
src/landing/            Sources de la scène 3D et des animations de la landing
assets/fonts/           Bricolage Grotesque, Geist, Geist Mono, Instrument Serif (woff2)
robots.txt, sitemap.xml, llms.txt, site.webmanifest
PRODUCT.md, DESIGN.md   Vérité produit et contrat de design « Nuit électrique »
```

## Développer

```bash
npm install          # three + esbuild (dev uniquement)
npm run build        # régénère assets/js/landing.bundle.js
npm run watch        # reconstruit à chaque modification de src/landing
npm run serve        # http://localhost:8080
```

Le site est 100 % statique : le bundle généré est commité, aucune étape de build n'est nécessaire
pour le publier. Il ne dépend d'aucun CDN (polices et Three.js sont auto-hébergés).

## Publier sur GitHub Pages

Settings → Pages → *Deploy from a branch* → `main` / racine. L'URL canonique déclarée dans les
métadonnées est `https://getfulmo.com/` (fichier `CNAME`). En cas de changement de domaine, adapter `CNAME`, `index.html`, `sitemap.xml`, `robots.txt`, `llms.txt` et les pages légales.

## Prototype

Toutes les données vivent dans le navigateur (localStorage + IndexedDB pour les nuages de points).
Liens utiles : `app.html#signup` (création de compte) et `app.html#demo` (logement de démonstration
de 40 objets, formule Éclair activée).
