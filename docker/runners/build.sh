#!/usr/bin/env bash
# Construit les images runner de notation (#116) : moodit-runner-{java,csharp,go,rust,c}.
# Utilisé en dev local, par la CI et au déploiement. C++ partage l'image C.
set -euo pipefail
cd "$(dirname "$0")"

TAG="${MOODIT_RUNNER_TAG:-latest}"

for lang in java csharp go rust c; do
  echo "── moodit-runner-${lang}:${TAG}"
  docker build -t "moodit-runner-${lang}:${TAG}" -f "${lang}/Dockerfile" .
done
echo "Images runner prêtes."
