# Dockerfile pour Railway - Force Node 20.19.0 (compatible Prisma 7)
FROM node:20.19.0-alpine

WORKDIR /app

# Build arg pour DATABASE_URL (nécessaire pour prisma generate)
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

# Copie des fichiers de dépendances
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Installation de TOUTES les dépendances (y compris devDeps pour prisma CLI + tsc)
RUN npm ci

# Génération du client Prisma
RUN npx prisma generate

# Copie du reste du code
COPY . .

# Build TypeScript
RUN npm run build

# Suppression des devDependencies pour alléger l'image finale
RUN npm prune --omit=dev

# Expose le port (Railway injecte PORT automatiquement)
EXPOSE 3002

# Commande de démarrage (applique les migrations puis lance le serveur)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/app.js"]
