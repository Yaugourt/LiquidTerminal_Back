# Stage 1: Build
FROM node:20.19.0-alpine AS builder

WORKDIR /app

# Deps layer cached as long as package.json is unchanged
COPY package*.json ./
RUN npm ci

# Prisma schemas in a dedicated layer so codegen only re-runs on schema changes
COPY prisma ./prisma/
COPY prisma-historical ./prisma-historical/
COPY prisma-content ./prisma-content/
COPY prisma-telegram ./prisma-telegram/
COPY prisma.config.ts ./

# prisma.config.ts (Prisma 7+) resolves env() at load time, so DATABASE_URL must
# be set even for `prisma generate`. A dummy value is enough at build time; the
# real one is injected by Railway as a runtime env var.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=$DATABASE_URL

RUN npx prisma generate \
 && npx prisma generate --schema ./prisma-historical/schema.prisma \
 && npx prisma generate --schema ./prisma-content/schema.prisma \
 && npx prisma generate --schema ./prisma-telegram/schema.prisma

# Source code + TypeScript build
COPY . .
RUN npm run build

# Prune devDeps in place to avoid a second full install
RUN npm prune --omit=dev

# Stage 2: Production
FROM node:20.19.0-alpine AS production

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/prisma ./prisma/
COPY --from=builder --chown=node:node /app/prisma-historical ./prisma-historical/
COPY --from=builder --chown=node:node /app/prisma-content ./prisma-content/
COPY --from=builder --chown=node:node /app/prisma-telegram ./prisma-telegram/
COPY --from=builder --chown=node:node /app/prisma.config.ts ./
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/scripts ./scripts/

USER node

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3002/api/health/ready || exit 1

CMD ["node", "dist/app.js"]
