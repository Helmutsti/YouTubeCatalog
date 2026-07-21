import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { createNewVideoStub, DOWNLOAD_STATE } from '../catalog/catalogSchema.js';
import { listEntries } from '../sourceProviders/playlistProvider.js';

export function extractPlaylistId(url) {
  try {
    return new URL(url).searchParams.get('list');
  } catch {
    return null;
  }
}

// Trasforma gli entries grezzi di una playlist in mutazioni sul catalogo (nuove
// entry "new" + auto-guarigione dei "downloaded" il cui file è sparito). Usata
// sia da syncSource (fonte già registrata) sia da sourceService.addSource
// (registrazione + primo ingest in un solo passaggio) per non duplicare la logica.
export function ingestPlaylistEntries(catalog, sourceMeta, entries, paths) {
  let newCount = 0;
  let healedCount = 0;

  for (const entry of entries) {
    const existing = catalog.videos[entry.id];

    if (!existing) {
      catalog.videos[entry.id] = createNewVideoStub({
        id: entry.id,
        title: entry.title,
        channelName: entry.channelName,
        durationSeconds: entry.durationSeconds,
        playlistIndex: entry.playlistIndex,
        playlistId: sourceMeta.id,
        playlistTitle: sourceMeta.name,
        sourceId: sourceMeta.id
      });
      newCount += 1;
      continue;
    }

    if (existing.download === DOWNLOAD_STATE.DOWNLOADED) {
      const filePath = existing.video?.localPath ? path.join(paths.videosDir, existing.video.localPath) : null;
      if (!filePath || !existsSync(filePath)) {
        // File sparito dal disco: torna scaricabile (auto-guarigione).
        existing.download = DOWNLOAD_STATE.NONE;
        existing.updatedAt = new Date().toISOString();
        healedCount += 1;
      }
    }
    // altri stati di download (none/downloading/failed) e il flag hidden:
    // lasciati invariati dalla sync
  }

  return { newCount, healedCount };
}

export async function syncSource(sourceId) {
  const catalog = await readCatalog();
  const sourceMeta = catalog.sources[sourceId];
  if (!sourceMeta) {
    throw new Error(`Fonte non trovata: "${sourceId}" — aggiungila prima da "Gestisci fonti"`);
  }

  const { entries } = await listEntries(sourceMeta);
  const paths = getPaths();

  let result;
  await updateCatalog((cat) => {
    const meta = cat.sources[sourceId];
    if (!meta) throw new Error(`Fonte rimossa durante la sincronizzazione: "${sourceId}"`);
    result = ingestPlaylistEntries(cat, meta, entries, paths);
    meta.lastCheckedAt = new Date().toISOString();
  });

  return result;
}
