# The Companion is a single Node process with a SQLite file beside it.
#
# The database is the whole application state, so the one thing to get right when running this
# image is the mount at /data: without a persistent one, every restart is a first sync, the read
# cursor is lost, and "what changed since I last checked" resets to "everything".
#
# The mount is declared by the platform, never here:
#
#   Railway   Service -> Data -> add a volume with mount path /data
#   Docker    docker run -v companion-data:/data ...
#
# There is deliberately no `VOLUME` instruction. Railway rejects a Dockerfile containing one
# outright ("docker VOLUME is not supported, use Railway Volumes"), and it buys nothing here:
# `VOLUME` only declares an *anonymous* volume as the default, which for this application is
# actively worse -- a fresh unnamed volume per container that nobody knows to preserve or back
# up. The explicit `-v` flag is what creates a mount worth keeping.

FROM node:22-slim

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY contracts ./contracts
COPY tsconfig.json companion.config.json ./

ENV NODE_ENV=production \
    COMPANION_DB=/data/companion.db \
    PORT=8787 \
    HOST=0.0.0.0

EXPOSE 8787

# Reads $PORT rather than hardcoding it: Railway and similar hosts assign the port at runtime,
# and a probe pinned to 8787 reports a perfectly healthy container as failing.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/cli/serve.ts"]
