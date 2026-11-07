#!/usr/bin/env bash
# Construit les images runner (#116) : notation des compilés (java, csharp, go, rust, c — C++
# partage l'image C) et mode exec ex-Piston (python, node, php, bash, sqlite).
# Utilisé en dev local, par la CI et au déploiement.
#
# Les FROM sont épinglés par DIGEST (#24, même pratique que les actions CI) et les
# téléchargements (jar JUnit, paquets NuGet) vérifiés par SHA-256 : le socle de la sandbox ne
# bouge jamais sans revue. Mise à jour d'une base : `docker buildx imagetools inspect <tag>`
# pour le nouveau digest, puis reconstruire et passer le job CI `integration`.
set -euo pipefail
cd "$(dirname "$0")"

# NB : côté build le tag vient de MOODIT_RUNNER_TAG ; côté execution-service, l'image utilisée
# vient de SANDBOX_IMAGE_TAG (app.sandbox.image-tag). Les deux valent « latest » par défaut —
# si l'un change, changer l'autre.
TAG="${MOODIT_RUNNER_TAG:-latest}"

for lang in java csharp go rust c python node php bash sqlite; do
  echo "── moodit-runner-${lang}:${TAG}"
  docker build -t "moodit-runner-${lang}:${TAG}" -f "${lang}/Dockerfile" .
done
echo "Images runner prêtes."
