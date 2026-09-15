#!/usr/bin/env bash
# release.sh — publie la version courante de manifest.json comme release
# GitHub, pour que BRAT (installé sur chaque vault) la détecte et
# propose/applique la mise à jour (voir README.md pour la mise en place
# initiale de BRAT sur chaque vault).
#
# Ce plugin n'a PAS d'étape de build : main.js est écrit à la main et est
# à la fois la source et l'artefact livré (Obsidian charge le plugin sans
# résoudre de require() relatif vers un autre fichier du dossier — tout doit
# donc tenir dans ce seul fichier). Il suffit donc de committer main.js,
# de bumper la version, puis de lancer ce script.
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
  if [ "$(git rev-parse "$VERSION")" = "$(git rev-parse HEAD)" ]; then
    # Tag déjà présent sur ce commit exact : probablement la reprise d'un run
    # précédent dont seule la publication GitHub avait échoué (voir
    # publier_release) — on saute la (re)création du tag, pas d'erreur.
    echo "Tag $VERSION déjà présent sur ce commit : reprise directe à la publication GitHub."
  else
    echo "Erreur : le tag $VERSION existe déjà sur un autre commit. As-tu oublié de bumper la version dans manifest.json ?" >&2
    exit 1
  fi
else
  git tag "$VERSION"
  git push origin main "$VERSION"
fi

# Publie (ou complète) la release GitHub d'une version, avec repli en cas
# d'erreur transitoire de l'API GitHub. Vécu deux fois en pratique (1.1.4,
# 1.1.5) : `gh release create` échoue en cours de route (HTTP 500/502 côté
# GitHub) mais laisse quand même un brouillon SANS pièce jointe. Sans ce
# rattrapage, le tag est poussé mais BRAT échoue ("pas de fichier
# manifest.json") tant que quelqu'un ne complète pas la release à la main.
publier_release() {
  local version="$1" tentative etat

  for tentative in 1 2 3; do
    if ! gh release view "$version" >/dev/null 2>&1; then
      if gh release create "$version" main.js manifest.json \
          --title "$version" \
          --notes "Voir le journal des commits pour le détail des changements."; then
        echo "Release GitHub $version créée avec main.js/manifest.json en pièces jointes."
        return 0
      fi
      echo "Tentative $tentative : échec de 'gh release create' (souvent transitoire côté GitHub)." >&2
    fi

    # Une release existe (à l'instant, ou laissée incomplète par un run
    # précédent) : on s'assure qu'elle porte bien les deux fichiers et qu'elle
    # est publiée (pas en brouillon), sans échouer si elle l'était déjà.
    if gh release view "$version" >/dev/null 2>&1; then
      gh release upload "$version" main.js manifest.json --clobber >/dev/null 2>&1 || true
      gh release edit "$version" --draft=false >/dev/null 2>&1 || true

      etat=$(gh release view "$version" --json isDraft,assets \
        --jq '(.isDraft|tostring) + "," + ([.assets[].name] | sort | join(":"))' 2>/dev/null || echo "?")
      if [ "$etat" = "false,main.js:manifest.json" ]; then
        echo "Release GitHub $version publiée avec main.js/manifest.json en pièces jointes."
        return 0
      fi
      echo "Tentative $tentative : release $version encore incomplète (état : $etat)." >&2
    fi

    sleep 3
  done

  echo "Erreur : impossible de finaliser la release GitHub $version après plusieurs tentatives." >&2
  echo "Le tag est déjà poussé : relance ./release.sh (il complétera la release existante)," >&2
  echo "ou termine à la main : $REPO_URL/releases/tag/$version" >&2
  exit 1
}

if command -v gh >/dev/null 2>&1; then
  publier_release "$VERSION"
else
  cat <<EOF

'gh' (GitHub CLI) n'est pas installé — termine la release à la main :
  1. $REPO_URL/releases/new?tag=$VERSION
  2. Joins ces 2 fichiers en pièces jointes de la release (PAS le zip de code source) :
       $(pwd)/main.js
       $(pwd)/manifest.json
  3. Publie la release.

(Ou installe 'gh' une fois pour toutes : https://cli.github.com/ — ensuite
'gh auth login', puis ce script fera tout automatiquement.)
EOF
fi
