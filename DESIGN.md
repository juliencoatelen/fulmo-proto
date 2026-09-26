# DESIGN — Fulmo « Nuit électrique »

Contrat de design partagé par la landing, l'inscription et l'application. Les jetons vivent dans
`assets/css/tokens.css` ; aucun écran ne redéfinit une couleur, une police ou une courbe en dur.

## Le monde
Un intérieur chaleureux, la nuit — bois de chêne, lin, argile, une lampe, la lumière d'une fenêtre —
traversé par une lumière électrique « volt » qui *se souvient* de chaque objet. Deux matières qui
dialoguent : **le foyer** (chaud, tactile, réel) et **l'éclair** (précis, lumineux, instantané).

- La **landing** et l'**inscription** sont de nuit (`.night` / `data-theme="dark"`) : c'est une scène.
- L'**application** est claire par défaut (on cherche en plein jour, téléphone en main), la nuit reste à un clic.

## Couleur
| Rôle | Jeton | Usage |
|---|---|---|
| Nuit | `--ink-0` #07070a | fond des scènes |
| Éclair | `--volt` #d9ff3d | action principale, trouvaille, sélection. Jamais du texte sur blanc (utiliser `--volt-deep`). |
| Arc | `--arc` #7b6cff | IA, 3D, second plan. Jamais en aplat large. |
| Matières | `--oak`, `--linen`, `--clay`, `--sage`, `--dusk` | uniquement la scène 3D et les illustrations |

Règle des proportions : 80 % neutres, 15 % matières, 5 % volt. Le volt est rare, donc il se voit.

## Typographie
- **Bricolage Grotesque** (display, 600–800, `opsz` auto) — titres. Tracking ≥ -0.04em.
- **Geist** — interface et texte courant, 65–75ch max.
- **Instrument Serif** italique — un seul mot d'accent par titre de landing (« *mémoire* »). Jamais dans l'app.
- **Geist Mono** — seulement pour des coordonnées/données réelles (chemin de rangement, compteurs). Jamais comme costume.
- Interdit : sur-titres (eyebrows / kickers) au-dessus des titres, texte en dégradé, numéros de section décoratifs.

## Profondeur
Ombres avec décalage et flou (`--shadow-1..3`). Le halo `--glow` est réservé à l'élément sélectionné ou à l'objet trouvé.
Verre dépoli uniquement pour une surface posée *sur* la scène 3D (barre de navigation de la landing, feuille d'objet sur le plan).

## Mouvement
- Courbes : `--ease-out` (arrivées), `--ease-spring` (sélection), `--ease-in-out` (transitions d'écran).
- Un moment signature par surface :
  - Landing : le **balayage** — un plan laser volt traverse la pièce 3D, la matière se dissout en particules
    (nuage de points) puis se recompose, et une épingle révèle l'objet cherché.
  - Inscription/onboarding : la **sélection transformée** — une tuile choisie se soulève (tilt 3D), s'illumine,
    et une gerbe d'étincelles volt part du point de contact.
  - Application : la **trouvaille** — le résultat trouvé pulse une fois en volt, le chemin se trace.
- Desktop : parallaxe et lumière qui suivent le pointeur (caméra 3D, tilt des cartes, reflet spéculaire).
- Toujours partir d'un état visible (pas de contenu caché en attente de JS). `prefers-reduced-motion` : aucune animation continue, aucune caméra qui bouge.

## Composants clés
- Bouton principal : pilule volt, texte encre, hover = léger soulèvement + reflet qui suit le pointeur.
- Bouton secondaire : contour `--line-strong`, fond transparent.
- Champs : 52px de haut, rayon `--r-md`, focus = anneau `--ring` + label qui flotte.
- Tuiles de sélection : rayon `--r-lg`, état choisi = bord volt 1.5px + `--glow` + coche animée.
- Icônes : sprite SVG maison (trait 2px, bouts ronds). Jamais d'emoji.

## Bibliothèques
- Three.js (ESM via jsDelivr, import map) pour la scène 3D de la landing.
- Aucune dépendance obligatoire pour l'application : tout doit fonctionner si le CDN échoue (dégradation vers une image/illustration statique).
