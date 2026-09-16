# syntax=docker/dockerfile:1

# Imitators of the customer's systems for the stand. One image for both: the
# code is shared and only the entry point differs, so a second Dockerfile would
# be a copy that drifts.
#
# No build step and no dependency install: Node 24 runs the TypeScript sources
# as they are, and the imitators use nothing but the standard library. The base
# image is the one the app is built on, so the stand pulls a single Node image.
FROM node:24-alpine

# Which of the two this image runs, and on which port. Compose passes both; the
# defaults make a bare `docker build ./mocks` produce the CMS imitator.
ARG SERVICE=cms
ARG PORT=8081
ENV MOCK_SERVICE=${SERVICE}
ENV PORT=${PORT}
ENV NODE_ENV=production

WORKDIR /app

# `type: module` for the sources below; there are no dependencies to install.
COPY --chown=node:node package.json ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node mock-cms ./mock-cms
COPY --chown=node:node mock-lms ./mock-lms

USER node
EXPOSE ${PORT}

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=6 \
	CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/__state').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# `exec` hands PID 1 to Node, so the container stops on a signal instead of
# waiting for the kill timeout.
CMD ["sh", "-c", "exec node mock-$MOCK_SERVICE/index.ts"]
