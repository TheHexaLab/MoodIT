# syntax=docker/dockerfile:1

# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Flag vocal fige au BUILD (Vite statique) : true => l'UI vocale est incluse dans le bundle.
# Passe par build.args du compose (depuis VOICE_ENABLED de .env.docker). false par defaut.
ARG VITE_VOICE_ENABLED=false
ENV VITE_VOICE_ENABLED=$VITE_VOICE_ENABLED
RUN npm run build

# Run stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html

# Config nginx (statiques + reverse proxy vers le gateway) écrite inline.
# "gateway" = nom du service docker-compose, joignable sur le réseau "internal".
COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 5173;

    # index.html (et fallback SPA) : TOUJOURS revalide. Sans Cache-Control, le navigateur le
    # garde en cache selon son heuristique et charge le bundle d'un ANCIEN deploiement
    # (constate dans Edge : salons vocaux absents tant qu'on ne rafraichit pas).
    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
    }

    # Assets Vite : nom hache par contenu → immuables, cache long sans risque. =404 (et NON le
    # fallback index.html) : sinon un chunk manquant renverrait du HTML mis en cache 1 an.
    location /assets/ {
        root /usr/share/nginx/html;
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location /api/ {
        proxy_pass http://gateway:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /mcp/ {
        proxy_pass http://gateway:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /exec/ {
        proxy_pass http://gateway:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /auth/ {
        proxy_pass http://gateway:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /gateway/ {
        proxy_pass http://gateway:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Sans slash final : le client se connecte sur /ws (path exact, + ?token=...).
    # Un "location /ws/" ne matcherait pas /ws et tomberait dans le SPA (catch-all).
    location /ws {
        proxy_pass http://gateway:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        # Sans ça, nginx ferme une WebSocket inactive au bout de 60 s (défaut) → reconnexion
        # + resync → la vue quiz se recharge toute seule (« stutter »). On tolère de longues
        # périodes sans message (un quiz ouvert et inactif est normal).
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF

EXPOSE 5173
CMD ["nginx", "-g", "daemon off;"]
