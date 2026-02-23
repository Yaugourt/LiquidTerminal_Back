# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20.19.0-alpine AS builder

WORKDIR /app

ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

# Dépendances — layer en cache tant que package.json ne change pas
COPY package*.json ./
RUN npm ci

# Schémas Prisma — layer séparé pour ne régénérer que si les schémas changent
COPY prisma ./prisma/
COPY prisma-historical ./prisma-historical/
COPY prisma.config.ts ./
RUN npx prisma generate && npx prisma generate --schema ./prisma-historical/schema.prisma

# Code source + build TypeScript
COPY . .
RUN npm run build

# Élagage des devDeps dans le même node_modules (évite une 2e install complète)
RUN npm prune --omit=dev

# ─── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:20.19.0-alpine AS production

WORKDIR /app

# node_modules déjà élagués + clients Prisma générés — aucune install supplémentaire
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma/
COPY --from=builder /app/prisma-historical ./prisma-historical/
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

EXPOSE 3002

CMD ["sh", "-c", "node node_modules/.bin/prisma migrate deploy && node node_modules/.bin/prisma migrate deploy --schema ./prisma-historical/schema.prisma --config ./prisma-historical/prisma.config.ts && node dist/app.js"]
