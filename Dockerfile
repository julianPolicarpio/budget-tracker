# Split — one container, one SQLite file (Spec §9, Tier A).
#
# The entire disaster-recovery plan is "copy split.db to the new box". Keeping
# that true is worth more than any managed platform's convenience, so this
# image stays deliberately boring: no runtime package installs, no entrypoint
# shell gymnastics, nothing that needs a network at start.

# ─── Build ────────────────────────────────────────────────────────────────
FROM node:26-slim AS build

# better-sqlite3 ships prebuilds for common platforms, but falls back to
# node-gyp. These are here so an unusual arch builds rather than dies, and they
# never reach the runtime image.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Reinstall without dev dependencies, so the runtime image carries only what
# it actually runs.
RUN npm ci --omit=dev

# ─── Runtime ──────────────────────────────────────────────────────────────
FROM node:26-slim AS runtime

ENV NODE_ENV=production \
	PORT=3000 \
	HOST=0.0.0.0 \
	DATABASE_URL=/app/data/split.db

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src

# The data directory is the only thing that matters. Mount it.
RUN mkdir -p /app/data/backups && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000

# HOST=0.0.0.0 is correct *inside* a container — the port publish on the host
# is what governs reach, and compose binds it to loopback. auth.ts refuses
# that same value on a bare host, where it would mean every interface.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/serve.js"]
