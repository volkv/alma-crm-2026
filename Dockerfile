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
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node scripts ./scripts
# Файлы шаблонов документов читаются с диска на первом обращении к шаблону,
# поэтому каталог обязан быть в образе рядом с рабочим каталогом процесса.
COPY --chown=node:node templates ./templates

# Uploaded and generated files live outside the image, on a volume mounted here.
# The directory is created in the image so the app can write to it even when the
# volume is missing — Docker would otherwise create the mount point as root.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
	CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Migrate, then hand PID 1 to the server so it receives stop signals directly.
CMD ["sh", "-c", "node scripts/migrate.ts && exec node build/index.js"]
