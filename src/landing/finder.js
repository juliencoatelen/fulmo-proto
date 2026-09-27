// Recherche tolérante de la landing : la même promesse que l'application,
// sur un petit inventaire de démonstration. Accents, casse, pluriels et
// fautes de frappe sont neutralisés avant la comparaison.

// La pièce 3D du hero : un bureau. Chaque objet pointe vers un contenant de la scène.
export const INVENTORY = [
  { name: "Passeport", place: ["Bureau", "Commode", "Tiroir du haut"], target: "commode-haut", kw: ["papiers", "voyage", "identité"] },
  { name: "Carte grise", place: ["Bureau", "Commode", "Tiroir du haut"], target: "commode-haut", kw: ["papiers", "voiture"] },
  { name: "Livret de famille", place: ["Bureau", "Commode", "Tiroir du haut"], target: "commode-haut", kw: ["papiers", "bébé"] },
  { name: "Carnet de santé", place: ["Bureau", "Commode", "Tiroir du milieu"], target: "commode-milieu", kw: ["santé", "bébé", "papiers"] },
  { name: "Thermomètre", place: ["Bureau", "Commode", "Tiroir du milieu"], target: "commode-milieu", kw: ["santé", "médicaments", "fièvre"] },
  { name: "Sirop pour la toux", place: ["Bureau", "Commode", "Tiroir du milieu"], target: "commode-milieu", kw: ["santé", "médicaments"] },
  { name: "Perceuse", place: ["Bureau", "Commode", "Tiroir du bas"], target: "commode-bas", kw: ["bricolage", "outils"] },
  { name: "Clé à molette", place: ["Bureau", "Commode", "Tiroir du bas"], target: "commode-bas", kw: ["bricolage", "outils"] },
  { name: "Chevilles de 6", place: ["Bureau", "Commode", "Tiroir du bas"], target: "commode-bas", kw: ["bricolage", "visserie"] },
  { name: "Décorations de Noël", place: ["Bureau", "Bibliothèque", "Bac 1"], target: "bac-1", kw: ["noël", "déco", "fêtes"] },
  { name: "Guirlande lumineuse", place: ["Bureau", "Bibliothèque", "Bac 1"], target: "bac-1", kw: ["noël", "déco", "lumière"] },
  { name: "Bougies", place: ["Bureau", "Bibliothèque", "Bac 2"], target: "bac-2", kw: ["noël", "maison"] },
  { name: "Doudou de rechange", place: ["Bureau", "Bibliothèque", "Bac 2"], target: "bac-2", kw: ["bébé", "enfants", "peluche"] },
  { name: "Chaussettes de ski", place: ["Bureau", "Bibliothèque", "Bac 3"], target: "bac-3", kw: ["ski", "montagne", "hiver"] },
  { name: "Bonnets et gants", place: ["Bureau", "Bibliothèque", "Bac 3"], target: "bac-3", kw: ["ski", "hiver"] },
  { name: "Pompe à matelas", place: ["Bureau", "Bibliothèque", "Bac 4"], target: "bac-4", kw: ["camping", "plage", "gonfleur", "gonfler"] },
  { name: "Lampe frontale", place: ["Bureau", "Bibliothèque", "Bac 4"], target: "bac-4", kw: ["camping", "lumière"] },
  { name: "Serviettes de plage", place: ["Bureau", "Bibliothèque", "Bac 4"], target: "bac-4", kw: ["plage", "été", "vacances"] },
  { name: "Chargeur d'ordinateur", place: ["Bureau", "Bibliothèque", "Boîte à câbles"], target: "boite-cables", kw: ["câbles", "ordi", "portable", "informatique"] },
  { name: "Chargeur de tablette", place: ["Bureau", "Bibliothèque", "Boîte à câbles"], target: "boite-cables", kw: ["câbles", "ipad", "enfants"] },
  { name: "Rallonge 5 m", place: ["Bureau", "Bibliothèque", "Boîte à câbles"], target: "boite-cables", kw: ["câbles", "électricité"] },
  { name: "Piles AA", place: ["Bureau", "Bibliothèque", "Boîte à câbles"], target: "boite-cables", kw: ["piles", "télécommande"] }
];

// Petite liste de mots vides : on cherche « passeport » dans « où est mon passeport ? »
const STOP = new Set("ou est le la les l de du des d un une mon ma mes ton ta tes son sa ses a au aux et en pour je j ai il elle on range rangé rangee rangés trouve trouver cherche chercher sont qui que quoi dans the".split(" "));

export function normalize(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’]/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
// pluriels simples : « piles » ~ « pile », « chevaux » reste proche
const stem = (w) => (w.length > 3 && /[sx]$/.test(w) ? w.slice(0, -1) : w);
export const tokens = (s) => normalize(s).split(" ").filter((w) => w && !STOP.has(w)).map(stem);

// Distance de Damerau-Levenshtein bornée (transpositions comprises)
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

function tokenScore(q, words) {
  let best = 0;
  for (const w of words) {
    if (w === q) return 3;
    if (q.length >= 3 && w.startsWith(q)) best = Math.max(best, 2.4);
    else if (q.length >= 4 && w.includes(q)) best = Math.max(best, 1.8);
    else if (q.length >= 4) {
      const max = q.length >= 8 ? 2 : 1;
      const dd = distance(q, w, max);
      if (dd <= max) best = Math.max(best, 2 - dd * 0.4);
    }
  }
  return best;
}

const INDEX = INVENTORY.map((item) => ({
  item,
  name: tokens(item.name),
  kw: item.kw.flatMap(tokens),
  place: item.place.flatMap(tokens)
}));

// Renvoie les objets classés, et si la requête a touché un mot-clé commun
export function search(query) {
  const q = tokens(query);
  if (!q.length) return { results: [], keyword: null };
  const scored = [];
  for (const e of INDEX) {
    let total = 0, hit = 0, viaKw = 0;
    for (const t of q) {
      const sn = tokenScore(t, e.name);
      const sk = tokenScore(t, e.kw) * 0.9;
      const sp = tokenScore(t, e.place) * 0.35;
      const s = Math.max(sn, sk, sp);
      if (s > 0) hit++;
      if (sk > sn && sk > 0) viaKw++;
      total += s;
    }
    if (hit / q.length >= 0.5 && total > 0.9) scored.push({ ...e.item, score: total + hit, viaKw: viaKw > 0 });
  }
  scored.sort((a, b) => b.score - a.score);
  // mot-clé transverse : plusieurs objets remontent ensemble
  let keyword = null;
  if (scored.length > 1 && scored.filter((r) => r.viaKw).length >= 2) {
    const kwWords = scored[0].kw.concat(scored[1].kw);
    keyword = kwWords.find((k) => q.some((t) => tokenScore(t, tokens(k)) >= 1.6)) || null;
  }
  return { results: scored, keyword };
}

export const SUGGESTIONS = ["perseuse", "noel", "chargeur ordi", "carte grise", "doudou", "thermometre"];
