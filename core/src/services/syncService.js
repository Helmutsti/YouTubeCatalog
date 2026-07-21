import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { createNewVideoStub, DOWNLOAD_STATE, PRESENCE } from '../catalog/catalogSchema.js';
import { listEntries } from '../sourceProviders/playlistProvider.js';

export function extractPlaylistId(url) {
  try {
    return new URL(url).searchParams.get('list');
  } catch {
    return null;
  }
}

// Trasforma gli entries grezzi di una playlist in mutazioni sul catalogo:
//  - nuove entry (present/none);
//  - auto-guarigione dei "downloaded" il cui file è sparito (→ none);
//  - detection "Rimosso" (M27): i video di QUESTA fonte non più presenti tra gli
//    entries vengono marcati presence:'removed' (+ removedAt), MAI cancellati
//    (file/metadati intatti); se un video prima rimosso ricompare, torna
//    presence:'present' (reversibile).
// Usata sia da syncSource (fonte già registrata) sia da sourceService.addSource
// (primo ingest: nessun video preesistente della fonte, quindi la detection è
// un no-op lì) per non duplicare la logica.
export function ingestPlaylistEntries(catalog, sourceMeta, entries, paths) {
  let newCount = 0;
  let healedCount = 0;
  let removedCount = 0;
  let restoredCount = 0;
  const now = () => new Date().toISOString();
  const foundIds = new Set(entries.map((e) => e.id));

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

    // Ricomparso: era stato marcato "rimosso" in una sync precedente ma ora è di
    // nuovo nella fonte → ripristina la presenza (reversibilità).
    if (existing.presence === PRESENCE.REMOVED) {
      existing.presence = PRESENCE.PRESENT;
      existing.removedAt = null;
      existing.updatedAt = now();
      restoredCount += 1;
    }

    if (existing.download === DOWNLOAD_STATE.DOWNLOADED) {
      const filePath = existing.video?.localPath ? path.join(paths.videosDir, existing.video.localPath) : null;
      if (!filePath || !existsSync(filePath)) {
        // File sparito dal disco: torna scaricabile (auto-guarigione).
        existing.download = DOWNLOAD_STATE.NONE;
        existing.updatedAt = now();
        healedCount += 1;
      }
    }
    // altri stati di download (none/downloading/failed) e il flag hidden:
    // lasciati invariati dalla sync
  }

  // Sweep dei rimossi: video di questa fonte non più tra gli entries. Non
  // cancella nulla — solo il flag presence, reversibile al prossimo ritrovamento.
  for (const video of Object.values(catalog.videos)) {
    if (
      video.source?.sourceId === sourceMeta.id &&
      !foundIds.has(video.id) &&
      video.presence === PRESENCE.PRESENT
    ) {
      video.presence = PRESENCE.REMOVED;
      video.removedAt = now();
      video.updatedAt = now();
      removedCount += 1;
    }
  }

  return { newCount, healedCount, removedCount, restoredCount };
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
