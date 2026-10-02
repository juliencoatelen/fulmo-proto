# Fulmo — prototype public : règles pour Claude

Ce repo est **public** et publié tel quel sur GitHub Pages
(https://getfulmo.com/, ex-juliencoatelen.github.io/fulmo-proto). Tout ce qui est mergé sur `main`
est en ligne quelques minutes plus tard. Lis aussi `PRODUCT.md` et `DESIGN.md`.

## Ce que ce repo est, et n'est pas
- Un site **100 % statique** : HTML, CSS, JS sans dépendance, données dans le navigateur
  du visiteur (localStorage, IndexedDB). **Aucun serveur, aucune donnée transmise.**
- Le vrai backend (comptes, base de données, paiement, IA) vit dans le repo **privé**
  `fulmo-app`, avec ses propres règles. N'ajoute jamais ici de clé d'API, d'appel à
  Supabase, Stripe, Anthropic ou à un service d'analytics : propose de le faire dans `fulmo-app`.

## Règles bloquantes (vérifiées par `bash tools/check-security.sh` et la CI)
- **P1 — CSP** : chaque page HTML garde sa balise `Content-Security-Policy`. Ne l'élargis
  jamais (`'unsafe-eval'`, domaine tiers, `*`). Si tu modifies le script de thème inline
  de `index.html`, recalcule son empreinte sha256 dans la CSP.
- **P2 — Aucune ressource tierce** : pas de CDN, pas de Google Fonts, pas de widget.
  Tout fichier est copié dans `assets/`.
- **P3 — Rien ne sort du navigateur** : pas de `fetch` ni de beacon vers un autre domaine.
- **P4 — Pas de code dynamique** : ni `eval`, ni `new Function`.
- **P5 — Pas d'injection HTML** : tout texte venant de l'utilisateur passe par `text:` /
  `textContent`. Un `innerHTML` n'est permis que pour une constante, marqué `// html-sûr : <raison>`.
- **P6 — Aucun secret** : pas de `.env`, pas de clé, même « de test ».

## Méthode
1. Travaille sur une branche, et ouvre une **pull request**. Ne pousse jamais directement sur `main`.
2. Avant de rendre la main : `bash tools/check-security.sh` doit afficher « conforme ».
   Si `src/landing/` change : `npm run build`, puis commite le bundle régénéré.
3. Si une demande impose de casser une règle, ne le fais pas : explique pourquoi en une
   phrase et propose l'alternative (souvent : « à faire dans fulmo-app »).

## Juridique (RGPD)
- Ne jamais fusionner une PR ni modifier les réglages GitHub Pages sans l'accord écrit de Julien.
- Pages : `mentions-legales.html`, `confidentialite.html`, `conditions.html`. Tout nouveau traitement de données, sous-traitant, pays d'hébergement ou traceur doit y être ajouté AVANT la mise en ligne, ainsi que dans `docs/legal/registre-des-traitements.md`.
- Un traceur facultatif (mesure d'audience…) ne se charge qu'après consentement, via `FulmoConsent.onChange` (`assets/js/consent.js`).
- Les fonctions d'IA n'envoient rien sans `aiConsented()` (`assets/js/app.js`). Une modification importante des conditions incrémente `LEGAL_VERSION`.
- Les champs `[À COMPLÉTER]` (balises `mark.todo`) doivent être remplis avant l'ouverture au public.
