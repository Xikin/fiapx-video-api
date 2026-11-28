# syntax=docker/dockerfile:1
FROM node:26-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

FROM deps AS builder
COPY tsconfig*.json ./
COPY src ./src
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp CHECKPOINT_DISABLE=1
# UID/GID fixos: o Kubernetes (runAsNonRoot) só confirma que não é root com um usuário numérico.
# npm, corepack e yarn vêm na imagem base mas não são usados em execução: removê-los tira do
# contêiner as vulnerabilidades das dependências deles (apontadas pelo Trivy) e reduz a superfície.
RUN apk add --no-cache openssl \
    && addgroup -S -g 10001 app && adduser -S -u 10001 -G app app \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/package.json ./
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["wget", "-q", "--spider", "http://localhost:3000/health"]
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/server.js"]
