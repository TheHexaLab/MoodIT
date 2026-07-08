# Piston patché : la limite par défaut de body-parser (100 Ko) rejette les soumissions qui
# EMBARQUENT des libs JS (parseur DOM pour HTML, plus tard React/Babel pour JSX/TSX). On la relève
# à 32 Mo. Le reste de l'image (isolate, runtimes dans le volume) est inchangé.
FROM ghcr.io/engineer-man/piston:latest

RUN sed -i "s/body_parser.json()/body_parser.json({ limit: '32mb' })/" /piston_api/src/index.js
