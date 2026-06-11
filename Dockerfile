# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# DATABASE_URL is needed by `prisma generate` at build time (as a build ARG,
# available to RUN steps) but is intentionally NOT promoted to ENV — that would
# bake the DB credentials into the image config, recoverable via `docker inspect`.
# For a fully leak-free build, pass it as a BuildKit secret instead.
ARG DATABASE_URL

# Dépendances — layer en cache tant que package.json ne change pas
COPY package*.json ./
RUN npm ci

# Schémas Prisma — layer séparé pour ne régénérer que si les schémas changent
COPY prisma ./prisma/
COPY prisma-historical ./prisma-historical/
COPY prisma-content ./prisma-content/
COPY prisma-telegram ./prisma-telegram/
COPY prisma.config.ts ./
RUN npx prisma generate \
 && npx prisma generate --schema ./prisma-historical/schema.prisma \
 && npx prisma generate --schema ./prisma-content/schema.prisma \
 && npx prisma generate --schema ./prisma-telegram/schema.prisma

# Code source + build TypeScript
COPY . .
RUN npm run build

# Élagage des devDeps dans le même node_modules (évite une 2e install complète)
RUN npm prune --omit=dev

# ─── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# node_modules déjà élagués + clients Prisma générés — aucune install supplémentaire
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma/
COPY --from=builder /app/prisma-historical ./prisma-historical/
COPY --from=builder /app/prisma-content ./prisma-content/
COPY --from=builder /app/prisma-telegram ./prisma-telegram/
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/scripts ./scripts/

EXPOSE 3002

# Drop root: run as the unprivileged `node` user shipped in the base image.
USER node

CMD ["node", "dist/app.js"]
