# Registre des activités de traitement — Fulmo (article 30 du RGPD)

Responsable : Julien Coatelen, entrepreneur individuel, nom commercial BASICX Marketing (service Fulmo), SIRET 751 919 101 00038, [adresse — à compléter]. Contact : [email vie privée — à compléter].
Dernière mise à jour : 2 octobre 2026.

| # | Traitement | Finalité | Base légale | Personnes | Données | Destinataires / sous-traitants | Transfert hors UE | Durée | Sécurité |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Comptes | Créer et ouvrir un compte | Contrat | Utilisateurs | Email, mot de passe haché, formule, date d'acceptation des CGU | Site : aucun (stockage local). Application app.getfulmo.com : Supabase (Francfort, eu-central-1), hébergement Vercel (Francfort, fra1) | Possible : Supabase Inc. et Vercel Inc. (US), encadrés par DPF ou CCT | Jusqu'à suppression ; 3 ans sans connexion | Mot de passe haché par Supabase Auth, HTTPS, RLS PostgreSQL |
| 2 | Inventaire du logement | Ranger et retrouver ses objets | Contrat | Utilisateurs, membres du foyer | Lieux, objets, photos, alertes, historique, relevés 3D | Site : aucun (stockage local). Application : Supabase (Francfort, eu-central-1) | Idem 1 | Jusqu'à suppression | Stockage local sur le site, RLS PostgreSQL dans l'application |
| 3 | Fonctions d'IA | Recherche en langage naturel, Scan Éclair | Consentement | Abonnés Éclair | Phrase tapée, photo | Anthropic (US) | Oui : DPF ou CCT | Non conservé par Fulmo ; selon contrat Anthropic | Consentement daté et versionné, retrait en un clic |
| 4 | Hébergement du site | Servir les pages | Intérêt légitime | Visiteurs | Adresse IP, journaux techniques | GitHub, Inc. (US) | Oui : DPF | Selon GitHub | HTTPS |
| 5 | Abonnement (à venir) | Encaisser et facturer | Contrat, obligation légale | Abonnés | Formule, factures (pas de numéro de carte) | Stripe Payments Europe (IE) | Possible (US) : DPF | 10 ans pour les factures | Paiement chez Stripe (PCI DSS) |
| 6 | Preuve des consentements | Démontrer les accords | Obligation légale | Utilisateurs | Date, version, choix | Aucun | Non | Durée du compte ; 6 mois pour les cookies | Stockage local |
| 7 | Hébergement de l'application | Servir app.getfulmo.com | Intérêt légitime | Utilisateurs de l'application | Adresse IP, journaux techniques | Vercel Inc. (US), région Francfort (fra1) | Possible (US) : DPF ou CCT | Selon Vercel | HTTPS, en-têtes de sécurité |
| 8 | Limitation des abus | Bloquer les tentatives répétées de connexion | Intérêt légitime | Utilisateurs de l'application | Empreinte salée (SHA-256) de l'adresse IP | Upstash, Inc. (US), région Francfort (eu-central-1) | Possible (US) : DPF ou CCT | De 1 minute à 24 heures | Adresse IP jamais stockée en clair |

Analyse d'impact (AIPD) : non requise à ce stade (pas de données sensibles à grande échelle, pas de profilage, pas de surveillance). À réévaluer si le Scan Éclair ou le foyer partagé changent d'échelle.
