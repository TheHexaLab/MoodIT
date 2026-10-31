# Piston patché : la limite par défaut de body-parser (100 Ko) rejette les soumissions qui
# EMBARQUENT des libs JS (parseur DOM pour HTML, plus tard React/Babel pour JSX/TSX). On la relève
# à 32 Mo. Le reste de l'image (isolate, runtimes dans le volume) est inchangé.
# Image épinglée par digest (#24) : le registre ne publie que le tag « latest », on fige donc la
# construction du 2025-02-08 (linux/amd64), celle qui tourne aujourd'hui. Pour monter de version :
# `docker buildx imagetools inspect ghcr.io/engineer-man/piston:latest`, remplacer le digest, puis
# relancer le job CI « integration » (vrai Piston) avant de fusionner.
FROM ghcr.io/engineer-man/piston:latest@sha256:2f66b7456189c4d713aa986d98eccd0b6ee16d26c7ec5f21b30e942756fd127a

RUN sed -i "s/body_parser.json()/body_parser.json({ limit: '32mb' })/" /piston_api/src/index.js

# Sans `privileged` (#24), Docker monte /sys/fs/cgroup en lecture seule ; l'entrypoint de Piston
# doit y créer le cgroup d'isolate. Avec SYS_ADMIN et un espace de noms cgroup privé (cf. compose),
# on le remonte en écriture : seul l'arbre cgroup du conteneur est visible. `exec` garde l'entrypoint
# de Piston en PID 1 (exigé : il déplace le PID 1 dans le cgroup isolate/init).
CMD ["/bin/bash", "-c", "mount -o remount,rw /sys/fs/cgroup || { echo 'remontage de /sys/fs/cgroup impossible : SYS_ADMIN et cgroup privé requis (cf. docker-compose)'; exit 1; }; exec /piston_api/src/docker-entrypoint.sh"]
