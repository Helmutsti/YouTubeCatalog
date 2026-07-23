import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { createNewVideoStub, DOWNLOAD_STATE, PRESENCE } from '../catalog/catalogSchema.js';
import { listEntries } from '../sourceProviders/playlistProvider.js';
import { removeFromDownloadArchive } from './libraryService.js';

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
// Sync consecutive in cui un video deve risultare assente PRIMA di essere
// marcato "rimosso": un paio di tentativi di grazia, per non etichettare a causa
// di un glitch temporaneo di YouTube (una playlist che "perde" un video per una
// sync). Marcato removed quando missCount raggiunge questa soglia.
const REMOVED_MISS_THRESHOLD = 2;

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

    // Ritrovato: azzera il contatore di assenze. Se era già stato marcato
    // "rimosso", ripristina la presenza (reversibilità).
    existing.missCount = 0;
    if (existing.presence === PRESENCE.REMOVED) {
      existing.presence = PRESENCE.PRESENT;
      existing.removedAt = null;
      existing.updatedAt = now();
      restoredCount += 1;
    }

    // Riuso in questa fonte (M41): un video già a catalogo (arrivato da
    // un'altra fonte, o singolo) trovato anche negli entries di QUESTA fonte
    // porta la sua etichetta, invece di essere ignorato dal dedup senza
    // lasciare traccia del collegamento.
    if (!existing.sources.some((s) => s.sourceId === sourceMeta.id)) {
      existing.sources.push({ sourceId: sourceMeta.id, name: sourceMeta.name ?? null });
      existing.updatedAt = now();
    }

    if (existing.download === DOWNLOAD_STATE.DOWNLOADED) {
      const filePath = existing.video?.localPath ? path.join(paths.videosDir, existing.video.localPath) : null;
      if (!filePath || !existsSync(filePath)) {
        // File sparito dal disco: torna scaricabile (auto-guarigione). Va
        // tolto anche dall'archivio yt-dlp (stesso bug di deleteVideoFile —
        // altrimenti il prossimo download viene saltato "già fatto" senza
        // scrivere nulla).
        existing.download = DOWNLOAD_STATE.NONE;
        existing.updatedAt = now();
        healedCount += 1;
        removeFromDownloadArchive(paths, existing.id);
      }
    }
    // altri stati di download (none/downloading/failed) e il flag hidden:
    // lasciati invariati dalla sync
  }

  // Sweep dei possibili rimossi: video di questa fonte non più tra gli entries.
  // Si conta l'assenza (missCount) e si marca "removed" solo dopo alcune sync
  // consecutive di assenza (periodo di grazia). Non cancella mai nulla.
  for (const video of Object.values(catalog.videos)) {
    if (
      video.sources?.some((s) => s.sourceId === sourceMeta.id) &&
      !foundIds.has(video.id) &&
      video.presence === PRESENCE.PRESENT
    ) {
      video.missCount = (video.missCount ?? 0) + 1;
      video.updatedAt = now();
      if (video.missCount >= REMOVED_MISS_THRESHOLD) {
        video.presence = PRESENCE.REMOVED;
        video.removedAt = now();
        removedCount += 1;
      }
    }
  }

  return { newCount, healedCount, removedCount, restoredCount };
}

// Copertura dell'enumerazione (backlog #4): confronta i video realmente
// enumerati col totale dichiarato da YouTube. `missingCount > 0` = alcuni video
// della playlist non erano visibili in questa estrazione (privati/rimossi/glitch
// temporaneo). Il conteggio non è infallibile (a volte i privati compaiono come
// entry-segnaposto), quindi va presentato come indizio, non come verità assoluta.
export function playlistCoverage(declaredCount, enumeratedCount) {
  return {
    declaredCount: declaredCount ?? null,
    enumeratedCount,
    missingCount: declaredCount != null ? Math.max(0, declaredCount - enumeratedCount) : 0
  };
}

export async function syncSource(sourceId) {
  const catalog = await readCatalog();
  const sourceMeta = catalog.sources[sourceId];
  if (!sourceMeta) {
    throw new Error(`Fonte non trovata: "${sourceId}" — aggiungila prima da "Gestisci fonti"`);
  }

  const { entries, declaredCount } = await listEntries(sourceMeta);
  const paths = getPaths();

  let result;
  await updateCatalog((cat) => {
    const meta = cat.sources[sourceId];
    if (!meta) throw new Error(`Fonte rimossa durante la sincronizzazione: "${sourceId}"`);
    result = ingestPlaylistEntries(cat, meta, entries, paths);
    meta.lastCheckedAt = new Date().toISOString();
  });

  return { ...result, ...playlistCoverage(declaredCount, entries.length) };
}
