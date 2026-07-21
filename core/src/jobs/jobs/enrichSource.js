import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
import { PRESENCE, DOWNLOAD_STATE } from '../../catalog/catalogSchema.js';
import { fetchVideoMetadata } from '../../ytdlp/ytdlpWrapper.js';

// Seconda fase dell'ingest a due fasi (M26): dopo che addSource/syncSource hanno
// popolato la libreria con i metadati LEGGERI dell'enumerazione flat-playlist
// (istantanei), questo job arricchisce ogni video con i metadati COMPLETI
// (descrizione, tag, capitoli, risoluzione, statistiche) e ne cacha la copertina
// in locale — una chiamata yt-dlp per video, come un download ma senza scaricare
// il video. Emette avanzamento (i/total) sull'EventEmitter del job manager, che
// il web mostra come barra sul pulsante "Sync".
//
// params.sourceId: se presente, arricchisce solo i video di quella fonte;
// altrimenti tutti i video ancora non arricchiti. Salta i già scaricati/in
// download (hanno già metadati completi dal download) e i già arricchiti
// (enrichedAt valorizzato) → idempotente, un secondo Sync non rifà il lavoro.
export async function enrichSourceJob(params, { log, progress }) {
  const { sourceId } = params ?? {};
  const catalog = await readCatalog();

  const candidates = Object.values(catalog.videos).filter((v) =>
    (!sourceId || v.source?.sourceId === sourceId)
    && v.presence === PRESENCE.PRESENT
    && v.download !== DOWNLOAD_STATE.DOWNLOADED
    && v.download !== DOWNLOAD_STATE.DOWNLOADING
    && !v.enrichedAt
  );

  if (candidates.length === 0) {
    log('Nessun video da arricchire (già completi o già arricchiti).');
    progress(100);
    return { enriched: 0, failed: 0, total: 0 };
  }

  log(`${candidates.length} video da arricchire (metadati completi + copertina).`);

  let enriched = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const video = candidates[i];
    progress(Math.round((i / candidates.length) * 100));
    log(`--- (${i + 1}/${candidates.length}) ${video.id}: ${video.title ?? '(titolo sconosciuto)'} ---`);

    try {
      const fields = await fetchVideoMetadata(video.id, video.webpageUrl, { onLog: log });
      // Scarta l'oggetto `video` (nessun file scaricato): l'arricchimento tocca
      // solo i metadati e la copertina, mai lo stato di download.
      const { video: _ignore, ...meta } = fields;
      await updateCatalog((cat) => {
        const current = cat.videos[video.id];
        if (!current) return; // rimosso nel frattempo
        Object.assign(current, meta, {
          enrichedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      });
      enriched += 1;
      log(`✔ ${video.id} arricchito.`);
    } catch (err) {
      failed += 1;
      log(`✘ ${video.id} non arricchito: ${err.message}`);
    }
  }

  progress(100);
  log(`Completato: ${enriched} arricchiti, ${failed} falliti.`);
  return { enriched, failed, total: candidates.length };
}
