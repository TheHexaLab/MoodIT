#!/usr/bin/env bash
# Construit les images runner (#116) : notation des compilés (java, csharp, go, rust, c — C++
# partage l'image C) et mode exec ex-Piston (python, node, php, bash, sqlite).
# Utilisé en dev local, par la CI et au déploiement.
#
# Les FROM sont épinglés par DIGEST (#24, même pratique que les actions CI) et les
# téléchargements directs vérifiés par SHA-256 : les bases et les chaînes de compilation ne
# bougent jamais sans revue. Les paquets apt (python3, mono-devel, sqlite3), eux, ne sont PAS
# figés : ils viennent des archives signées de la distribution (intégrité garantie), mais leur
# version suit les correctifs de celle-ci d'une construction à l'autre — les épingler casserait
# la construction dès qu'une version quitte le miroir. Mise à jour d'une base :
# `docker buildx imagetools inspect <tag>` pour le nouveau digest, puis reconstruire et passer
# le job CI `integration`.
set -euo pipefail
cd "$(dirname "$0")"

# NB : côté build le tag vient de MOODIT_RUNNER_TAG ; côté execution-service, l'image utilisée
# vient de SANDBOX_IMAGE_TAG (app.sandbox.image-tag). Les deux valent « latest » par défaut —
# si l'un change, changer l'autre. En prod, deploy/update.sh pose le COMMIT déployé des deux
# côtés : le format d'échange entre execution-service et le superviseur n'a pas de version, et
# un service ne doit jamais tourner avec les images d'un autre commit (déploiement en cours,
# rollback). `latest` est posé AUSSI : un `docker compose up` lancé à la main, sans la
# variable, retombe sur les dernières images construites.
TAG="${MOODIT_RUNNER_TAG:-latest}"

# Sans argument : les dix images. Avec : seulement celles demandees — la CI s en sert pour
# construire une image par job, sans dupliquer ici la facon de les construire.
LANGS=("$@")
if [ ${#LANGS[@]} -eq 0 ]; then
  LANGS=(java csharp go rust c python node php bash sqlite)
fi

for lang in "${LANGS[@]}"; do
  echo "── moodit-runner-${lang}:${TAG}"
  if [ "$TAG" = "latest" ]; then
    docker build -t "moodit-runner-${lang}:latest" -f "${lang}/Dockerfile" .
  else
    docker build -t "moodit-runner-${lang}:${TAG}" -t "moodit-runner-${lang}:latest" \
      -f "${lang}/Dockerfile" .
  fi
done
echo "Images runner prêtes."
