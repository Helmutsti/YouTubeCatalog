import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { VIDEO_STATUS } from '../catalog/catalogSchema.js';
import { fetchMetadata, hashFileSha256, getYtdlpVersion, mapInfoJsonToVideoFields } from '../ytdlp/ytdlpWrapper.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm']);
// Un id video YouTube è sempre esattamente 11 caratteri [A-Za-z0-9_-]. Senza
// questo controllo, un file con nome descrittivo (es. "023 - Titolo.mkv", non
// ancora rinominato) verrebbe trattato come un id valido ma inventato.
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Elenca i file video presenti in media/videos/ il cui nome (senza estensione)
// è un id YouTube valido e che non risultano già "downloaded" nel catalogo —
// candidati per importLocalVideo(). Il nome file DEVE essere "<id>.<ext>".
export async function scanImportable() {
  const paths = getPaths();
  const catalog = await readCatalog();
  const files = readdirSync(paths.videosDir);

  const results = [];
  for (const file of files) {
    const ext = path.extname(file);
    if (!VIDEO_EXTENSIONS.has(ext.toLowerCase())) continue;
    const id = path.basename(file, ext);
    if (!YOUTUBE_ID_PATTERN.test(id)) continue;

    const existing = catalog.videos[id];
    if (existing && existing.status === VIDEO_STATUS.DOWNLOADED) continue;

    results.push({ id, file, knownTitle: existing?.title ?? null });
  }

  return results;
}

// Importa un video il cui file è già presente in media/videos/<id>.<ext>: NON lo
// scarica, recupera solo i metadati completi via yt-dlp (--skip-download) e
// calcola sha256/size dal file locale già presente, poi marca "downloaded".
export async function importLocalVideo(id, { onLog = () => {} } = {}) {
  const paths = getPaths();
  const localFile = readdirSync(paths.videosDir).find(
    (f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()) && path.basename(f, path.extname(f)) === id
  );
  if (!localFile) {
    throw new Error(`Nessun file video trovato per "${id}" in media/videos/ (atteso: ${id}.mp4, .mkv o .webm)`);
  }

  onLog(`Recupero metadati per ${id}...`);
  const { info, thumbnailFile } = await fetchMetadata(id);

  onLog('Calcolo sha256 dal file locale...');
  const sizeBytes = statSync(path.join(paths.videosDir, localFile)).size;
  const sha256 = await hashFileSha256(path.join(paths.videosDir, localFile));
  const ytdlpVersion = await getYtdlpVersion();

  const fields = mapInfoJsonToVideoFields(info, {
    videoFile: localFile,
    thumbnailFile,
    sizeBytes,
    sha256,
    ytdlpVersion
  });

  await updateCatalog((catalog) => {
    const now = new Date().toISOString();
    const existing = catalog.videos[id];
    if (existing) {
      Object.assign(existing, fields, {
        status: VIDEO_STATUS.DOWNLOADED,
        updatedAt: now,
        decidedAt: existing.decidedAt ?? now,
        error: null
      });
    } else {
      catalog.videos[id] = {
        id,
        ...fields,
        status: VIDEO_STATUS.DOWNLOADED,
        source: { sourceId: null, type: null },
        addedAt: now,
        updatedAt: now,
        decidedAt: now,
        attempts: 0,
        error: null
      };
    }
  });

  onLog(`✔ ${id} importato come "downloaded".`);
  return fields;
}
