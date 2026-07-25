# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# M63 — Immagine Docker per QNAP: API + Web GUI in un unico container.
#
# Base Debian/glibc (NON Alpine/musl): il binario ufficiale yt-dlp_linux è un
# eseguibile PyInstaller costruito su glibc e non gira su Alpine. ffmpeg arriva
# da apt (finisce nel PATH); yt-dlp NON è nell'immagine — arriva da un volume
# montato in /app/tools, così si aggiorna sostituendo il file senza rebuild.
# Target: x86_64 (caso comune sui QNAP). Per ARM vedi docs/DOCKER.md.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build della Web GUI (Vite) ─────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Prima i soli manifest, per sfruttare la cache dei layer di npm ci.
COPY package.json package-lock.json ./
COPY core/package.json ./core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN npm ci

# Sorgenti e build della web (produce packages/web/dist).
COPY core ./core
COPY packages ./packages
RUN npm run build --workspace=@catalog/web

# Elimina i devDependencies (vite, rollup, plugin di build): non servono a
# runtime, la web è ormai statica in packages/web/dist.
RUN npm prune --omit=dev

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production

# ffmpeg: usato da yt-dlp per fondere video+audio e convertire le copertine.
# getPaths() ricade su "ffmpeg nel PATH" quando tools/ non contiene ffmpeg,
# quindi basta averlo installato qui. ca-certificates per le connessioni TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia l'albero già installato e buildato dallo stage builder (node_modules con
# i symlink dei workspace, così @catalog/core resta risolvibile; packages/web/dist).
COPY --from=builder /app ./

# L'API ascolta sulla porta di data/config.json (default 3001).
EXPOSE 3001

# Verifica che il server risponda (root → index.html quando la web è servita).
# Porta 3001 = default di data/config.json; se la cambi lì, aggiorna anche qui.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/src/index.js"]
