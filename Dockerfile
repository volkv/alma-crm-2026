# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Full dependency tree, needed to build the app.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Runtime dependency tree, needed by scripts/migrate.ts inside the final image.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
# Молодое поколение кучи побольше: под пятьюдесятью пользователями сборка мусора
# занимала пятую часть основного потока, с флагом p95 падает вдвое
# (docs/performance.md, «Куда уходит время на пятидесяти»).
ENV NODE_OPTIONS=--max-semi-space-size=32
WORKDIR /app

# Базовый образ пересобирают реже, чем Alpine выпускает исправления, поэтому
# пакеты обновляются на сборке: иначе в образе остаются известные дыры openssl,
# на которые справедливо ругается сканирование. Заодно из образа убирается npm:
# контейнер запускает только `node` (см. CMD), а npm везёт с собой свой
# собственный набор зависимостей и их уязвимости.
RUN apk upgrade --no-cache && \
	rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node drizzle ./drizzle
# Из `scripts/` в образ едет только то, что запускают в контейнере: миграции,
# сид и снимок карточек для нагрузочного прогона (`docker compose exec app node
# scripts/load/fixture.ts`). Каталог целиком сюда не копируется — в нём лежат
# сценарии k6, съёмка README и файл окружения нагрузочного стенда, которым в
# рантайме делать нечего, а последнему — тем более (`.dockerignore`).
COPY --chown=node:node scripts/migrate.ts ./scripts/
COPY --chown=node:node scripts/seed ./scripts/seed
COPY --chown=node:node scripts/load/fixture.ts ./scripts/load/
# Миграции и начальные данные заливает обычный процесс Node, а не приложение:
# `scripts/migrate.ts` берёт отсюда схему базы и каталог прав, сид — ещё и
# контракты, процесс и генерацию документов. Исходниками, потому что в `build/`
# они попадают только внутри бандла, откуда их не импортировать.
COPY --chown=node:node src/lib ./src/lib
# Файлы шаблонов документов читаются с диска на первом обращении к шаблону,
# поэтому каталог обязан быть в образе рядом с рабочим каталогом процесса.
COPY --chown=node:node templates ./templates

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
	CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Migrate, fill the demo stand (only when DEMO_MODE=true — that is what
# `--if-demo` checks), then hand PID 1 to the server so it receives stop
# signals directly. A failure at any step stops the container instead of
# starting the app on a half-prepared database.
CMD ["sh", "-c", "node scripts/migrate.ts && node scripts/seed/index.ts --if-demo && exec node build/index.js"]
