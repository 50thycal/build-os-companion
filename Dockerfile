# The Companion is a single Node process with a SQLite file beside it.
#
# The database is the whole application state, so the one thing this image gets wrong if you
# ignore it is the volume: without a persistent mount at /data, every restart is a first sync,
# the read cursor is lost, and "what changed since I last checked" resets to "everything".

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

# State lives here. Mount it.
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/cli/serve.ts"]
