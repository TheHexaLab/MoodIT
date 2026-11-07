#!/usr/bin/env bash
# Construit les images runner (#116) : notation des compilés (java, csharp, go, rust, c — C++
# partage l'image C) et mode exec ex-Piston (python, node, php, bash, sqlite).
# Utilisé en dev local, par la CI et au déploiement.
set -euo pipefail
cd "$(dirname "$0")"

TAG="${MOODIT_RUNNER_TAG:-latest}"

for lang in java csharp go rust c python node php bash sqlite; do
  echo "── moodit-runner-${lang}:${TAG}"
  docker build -t "moodit-runner-${lang}:${TAG}" -f "${lang}/Dockerfile" .
done
echo "Images runner prêtes."
