#!/usr/bin/env bash
# release.sh — publie la version courante de manifest.json comme release
# GitHub, pour que BRAT (installé sur chaque vault) la détecte et
# propose/applique la mise à jour (voir README.md pour la mise en place
# initiale de BRAT sur chaque vault).
#
# Ce plugin n'a PAS d'étape de build : main.js et correctionView.js sont
# écrits à la main et sont à la fois la source et l'artefact livré. Il suffit
# donc de committer ces fichiers, de bumper la version, puis de lancer ce script.
#
# Convention obligatoire (BRAT et le système de mise à jour d'Obsidian s'y
# fient) : le tag git doit être EXACTEMENT égal au champ "version" de
# manifest.json, sans préfixe "v".
#
# Usage : bump la version dans manifest.json puis lancer ce script depuis
# la racine du plugin.

set -euo pipefail
cd "$(dirname "$0")"

REPO_URL="https://github.com/oravard/obsidian-lancer-serveur-depot"

if [ -n "$(git status --porcelain)" ]; then
  echo "Erreur : des changements ne sont pas commités. Commite d'abord (main.js inclus), relance ensuite." >&2
  git status --short
  exit 1
fi

VERSION=$(node -p "require('./manifest.json').version")
echo "Version à publier (manifest.json) : $VERSION"

if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "Erreur : le tag $VERSION existe déjà. As-tu oublié de bumper la version dans manifest.json ?" >&2
  exit 1
fi

git tag "$VERSION"
git push origin main "$VERSION"

if command -v gh >/dev/null 2>&1; then
  gh release create "$VERSION" main.js correctionView.js manifest.json \
    --title "$VERSION" \
    --notes "Voir le journal des commits pour le détail des changements."
  echo "Release GitHub $VERSION créée avec main.js/correctionView.js/manifest.json en pièces jointes."
else
  cat <<EOF

'gh' (GitHub CLI) n'est pas installé — termine la release à la main :
  1. $REPO_URL/releases/new?tag=$VERSION
  2. Joins ces 3 fichiers en pièces jointes de la release (PAS le zip de code source) :
       $(pwd)/main.js
       $(pwd)/correctionView.js
       $(pwd)/manifest.json
  3. Publie la release.

(Ou installe 'gh' une fois pour toutes : https://cli.github.com/ — ensuite
'gh auth login', puis ce script fera tout automatiquement.)
EOF
fi
