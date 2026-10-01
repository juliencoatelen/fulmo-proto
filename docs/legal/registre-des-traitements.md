# Registre des activités de traitement — Fulmo (article 30 du RGPD)

Responsable : BASICX Marketing (service Fulmo), SIRET 751 919 101 00038, [adresse — à compléter]. Contact : [email vie privée — à compléter].
Dernière mise à jour : 1er octobre 2026.

| # | Traitement | Finalité | Base légale | Personnes | Données | Destinataires / sous-traitants | Transfert hors UE | Durée | Sécurité |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Comptes | Créer et ouvrir un compte | Contrat | Utilisateurs | Nom, email, empreinte salée du mot de passe, date d'acceptation des CGU | Aujourd'hui aucun (stockage local). Demain Supabase (UE) | Non aujourd'hui ; Supabase Inc. (US) encadré par CCT | Jusqu'à suppression ; 3 ans d'inactivité en ligne | SHA-256 salé, HTTPS |
| 2 | Inventaire du logement | Ranger et retrouver ses objets | Contrat | Utilisateurs, membres du foyer | Lieux, objets, photos, alertes, historique, relevés 3D | Aucun aujourd'hui. Demain Supabase (UE) | Idem 1 | Jusqu'à suppression | Stockage local, RLS PostgreSQL demain |
| 3 | Fonctions d'IA | Recherche en langage naturel, Scan Éclair | Consentement | Abonnés Éclair | Phrase tapée, photo | Anthropic (US) | Oui : DPF ou CCT | Non conservé par Fulmo ; selon contrat Anthropic | Consentement daté et versionné, retrait en un clic |
| 4 | Hébergement du site | Servir les pages | Intérêt légitime | Visiteurs | Adresse IP, journaux techniques | GitHub, Inc. (US) | Oui : DPF | Selon GitHub | HTTPS |
| 5 | Abonnement (à venir) | Encaisser et facturer | Contrat, obligation légale | Abonnés | Formule, factures (pas de numéro de carte) | Stripe Payments Europe (IE) | Possible (US) : DPF | 10 ans pour les factures | Paiement chez Stripe (PCI DSS) |
| 6 | Preuve des consentements | Démontrer les accords | Obligation légale | Utilisateurs | Date, version, choix | Aucun | Non | Durée du compte ; 6 mois pour les cookies | Stockage local |

Analyse d'impact (AIPD) : non requise à ce stade (pas de données sensibles à grande échelle, pas de profilage, pas de surveillance). À réévaluer si le Scan Éclair ou le foyer partagé changent d'échelle.
