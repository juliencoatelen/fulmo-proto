#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Fulmo (prototype statique) — garde-fous de sécurité. Voir CLAUDE.md.
#   bash tools/check-security.sh      → 0 = conforme, 1 = à corriger
# Lancé par la CI sur chaque pull request ; le merge est bloqué s'il échoue.
# ═══════════════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")/.." || exit 2
ERR=0
fail() { ERR=$((ERR + 1)); printf '✖ %s  %s\n    → %s\n' "$1" "$2" "$3"; }

HTML=$(git ls-files '*.html' 2>/dev/null || ls *.html)
# Sources écrites à la main (le bundle et les chunks générés sont exclus du
# contrôle innerHTML, mais pas du contrôle réseau).
OWN_JS=$(ls assets/js/app.js assets/js/pano-*.js src/landing/*.js 2>/dev/null)
ALL_JS=$(ls assets/js/*.js assets/js/chunks/*.js src/landing/*.js 2>/dev/null)

# P1 — Chaque page porte la politique de sécurité (CSP), sans 'unsafe-eval'
#      ni script inline autorisé en bloc.
for f in $HTML; do
  grep -q 'http-equiv="Content-Security-Policy"' "$f" || fail P1 "$f" "ajouter la balise CSP (copier celle de app.html)"
  grep 'Content-Security-Policy' "$f" | grep -qE "script-src[^;]*('unsafe-inline'|'unsafe-eval'|\*|https?:)" \
    && fail P1 "$f" "script-src ne doit autoriser que 'self' (et l'empreinte sha256 du script de thème)"
done

# P2 — Aucune ressource tierce : scripts, styles et polices sont auto-hébergés.
for f in $HTML; do
  grep -nE '<script[^>]+src="(https?:)?//|<link[^>]+rel="stylesheet"[^>]+href="(https?:)?//' "$f" \
    | while IFS= read -r l; do echo "$f:$l"; done
done | while IFS= read -r hit; do echo "P2|$hit"; done > /tmp/fulmo-p2.$$
while IFS='|' read -r _ hit; do fail P2 "${hit%%:*}" "ressource tierce interdite : héberger le fichier dans assets/"; done < /tmp/fulmo-p2.$$
rm -f /tmp/fulmo-p2.$$

# P3 — Le prototype n'envoie rien : aucun appel réseau vers un autre domaine.
for f in $ALL_JS; do
  grep -nE "(fetch|sendBeacon|open)\(\s*['\"\`]https?://|new (WebSocket|EventSource)\(" "$f" >/dev/null \
    && fail P3 "$f" "aucune donnée ne doit quitter le navigateur dans le prototype"
done

# P4 — Pas d'exécution de code dynamique.
for f in $ALL_JS; do
  grep -nE '\beval\(|new Function\(|setTimeout\(\s*["'"'"']' "$f" >/dev/null && fail P4 "$f" "eval / new Function interdits"
done

# P5 — Toute injection HTML est justifiée : saisie utilisateur → textContent.
for f in $OWN_JS; do
  grep -nE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write|\bhtml: ' "$f" | grep -v 'html-sûr' \
    | while IFS= read -r l; do echo "$f:${l%%:*}"; done
done > /tmp/fulmo-p5.$$
while IFS= read -r loc; do fail P5 "$loc" "utiliser text: / textContent ; si le HTML est une constante, ajouter « // html-sûr : <raison> »"; done < /tmp/fulmo-p5.$$
rm -f /tmp/fulmo-p5.$$

# P6 — Aucun secret ni fichier d'environnement dans le repo.
git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$' | while IFS= read -r f; do echo "$f"; done > /tmp/fulmo-p6.$$
while IFS= read -r f; do fail P6 "$f" "retirer du repo (git rm --cached) et révoquer la clé"; done < /tmp/fulmo-p6.$$
rm -f /tmp/fulmo-p6.$$
git ls-files | grep -vE '\.(png|jpg|webp|woff2|svg|ico)$' | xargs grep -lE 'sk_live_|sk_test_[A-Za-z0-9]{10}|whsec_[A-Za-z0-9]{10}|sb_secret_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null \
  | grep -v '^tools/check-security.sh$' | while IFS= read -r f; do echo "$f"; done > /tmp/fulmo-p6b.$$
while IFS= read -r f; do fail P6 "$f" "secret détecté : le retirer et le révoquer immédiatement"; done < /tmp/fulmo-p6b.$$
rm -f /tmp/fulmo-p6b.$$

echo
if [ "$ERR" -gt 0 ]; then echo "Garde-fous Fulmo : $ERR problème(s). Voir CLAUDE.md."; exit 1; fi
echo "Garde-fous Fulmo : conforme."
