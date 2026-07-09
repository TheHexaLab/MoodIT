# JS vendor stage : bundle en fichiers UNIQUES les libs JS injectées dans le sandbox Piston pour
# les langages « données/vues » (HTML → parseur DOM). Piston n'a ni npm ni réseau : on embarque
# ces bundles dans l'image et l'assembleur les joint à la soumission.
FROM node:20-alpine AS jsvendor
WORKDIR /vendor
# Réseau CI instable (ECONNRESET) : on force npm à réessayer plutôt qu'abandonner au 1er échec.
RUN npm install --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000 \
      node-html-parser@6.1.13 react@18.3.1 react-dom@18.3.1 @babel/standalone@7.24.7 happy-dom@14.12.3 esbuild@0.21.5
# HTML : node-html-parser expose parse()/querySelector()/textContent/getAttribute (API façon DOM).
RUN printf "module.exports = require('node-html-parser');" > html-entry.js \
 && npx esbuild html-entry.js --bundle --minify --platform=node --format=cjs --outfile=/out/htmlparser.js
# JSX/TSX : React + ReactDOMServer (rendu statique) + ReactDOMClient + act + happy-dom (rendu
# INTERACTIF : DOM, événements, état) + Babel standalone (transpilation JSX/TSX).
RUN printf "module.exports={React:require('react'),ReactDOMServer:require('react-dom/server'),ReactDOMClient:require('react-dom/client'),act:require('react-dom/test-utils').act,HappyDOM:require('happy-dom'),Babel:require('@babel/standalone')};" > react-entry.js \
 && npx esbuild react-entry.js --bundle --minify --platform=node --format=cjs --outfile=/out/react-runtime.js

# Build stage
FROM eclipse-temurin:25-jdk AS builder
WORKDIR /app
COPY gradlew ./
COPY gradle ./gradle
RUN apt-get update && apt-get install -y dos2unix && dos2unix gradlew && chmod +x gradlew
COPY build.gradle.kts settings.gradle.kts ./
RUN ./gradlew dependencies --no-daemon
COPY src ./src
RUN ./gradlew bootJar --no-daemon

# Run stage
FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=builder /app/build/libs/*.jar app.jar
COPY --from=jsvendor /out /app/vendor
# Runner JSX/TSX fixe (injecté tel quel par CodeAssembler).
COPY vendor/jsx-main.js /app/vendor/jsx-main.js
EXPOSE 8084
ENTRYPOINT ["java", "-jar", "app.jar"]
