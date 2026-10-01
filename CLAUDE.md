# Consignes pour Claude — Fulmo

À lire avant toute action sur ce dépôt.

## Sécurité et production
- Ne jamais pousser sur `main`, fusionner une PR ni modifier les réglages GitHub Pages sans l'accord écrit de Julien : `main` est la production.
- Toute modification passe par une branche et une pull request.
- Aucun secret (clé d'API, mot de passe, jeton) dans le dépôt : le site est public. Les clés iront dans les variables d'environnement du futur backend.
- Ne jamais enregistrer un mot de passe en clair, ni l'empreinte du mot de passe dans un export.
- Aucun script, police ou service tiers chargé depuis un CDN sans mise à jour de la politique de confidentialité.

## Juridique (RGPD)
- Pages : `mentions-legales.html`, `confidentialite.html`, `conditions.html`. Tout nouveau traitement de données, sous-traitant, pays d'hébergement ou traceur doit y être ajouté AVANT la mise en ligne, ainsi que dans `docs/legal/registre-des-traitements.md`.
- Un traceur facultatif (mesure d'audience…) ne se charge qu'après consentement, via `FulmoConsent.onChange` (`assets/js/consent.js`).
- Les fonctions d'IA n'envoient rien sans `aiConsented()` (`assets/js/app.js`). Une modification importante des conditions incrémente `LEGAL_VERSION`.
- Les champs `[À COMPLÉTER]` (balises `mark.todo`) doivent être remplis avant l'ouverture au public.
