# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
USER app
EXPOSE 8787
# SIGTERM chega direto no node (sem shell no meio) → drenagem funciona.
CMD ["node", "dist/server.js"]
