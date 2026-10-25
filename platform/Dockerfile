# CHIAKI 平台正式映像（多階段、非 root、Node 22 LTS）
#   建置：docker build -t chiaki-platform .           （建置脈絡＝platform/ 目錄）
#   網站：docker run --env-file .env -p 3000:3000 chiaki-platform
#   工作：docker run --env-file .env chiaki-platform node dist/worker.mjs
#   遷移：docker run --env-file .env chiaki-platform node dist/migrate.mjs
# 執行期資料存取使用 postgres.js（不需要 Prisma Client）；prisma generate 只用來驗證 schema 鏡像，可用 --build-arg PRISMA_GENERATE=0 略過。

ARG NODE_IMAGE=node:22-bookworm-slim

# ── 1. 相依套件 ─────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

# ── 2. 建置 ─────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG PRISMA_GENERATE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN if [ "$PRISMA_GENERATE" = "1" ]; then npx prisma generate; else echo "skip prisma generate"; fi
# next build（含型別檢查）＋ 把營運腳本打包成 dist/*.mjs（正式映像不需要 tsx）
RUN mkdir -p public \
 && npx next build \
 && node scripts/bundle-scripts.mjs

# ── 3. 執行 ─────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# 官方 node 映像內建非 root 使用者 node（uid 1000）
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma/migrations ./prisma/migrations

USER node
EXPOSE 3000
# liveness：不依賴資料庫（readiness 請讓平台檢查 /api/ready）
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
