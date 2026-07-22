import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
import { PRESENCE, DOWNLOAD_STATE } from '../../catalog/catalogSchema.js';
import { fetchVideoMetadata, isVideoGoneError } from '../../ytdlp/ytdlpWrapper.js';
import { syncChannelAvatars } from '../../services/channelAvatarService.js';
import { markVideoRemoved } from '../../services/metadataService.js';

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
    (!sourceId || v.sources?.some((s) => s.sourceId === sourceId))
    && v.presence === PRESENCE.PRESENT
    && v.download !== DOWNLOAD_STATE.DOWNLOADED
    && v.download !== DOWNLOAD_STATE.DOWNLOADING
    && !v.enrichedAt
  );

  let enriched = 0;
  let failed = 0;
  let removed = 0;

  if (candidates.length === 0) {
    log('Nessun video da arricchire (già completi o già arricchiti).');
  } else {
  log(`${candidates.length} video da arricchire (metadati completi + copertina).`);

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
      if (isVideoGoneError(err)) {
        await markVideoRemoved(video.id);
        removed += 1;
        log(`⊘ ${video.id} è privato — segnato come "Rimosso".`);
      } else {
        failed += 1;
        log(`✘ ${video.id} non arricchito: ${err.message}`);
      }
    }
  }
  log(`Arricchimento completato: ${enriched} arricchiti, ${failed} falliti${removed ? `, ${removed} privati (segnati "Rimosso")` : ''}.`);
  }

  progress(100);

  // Foto profilo dei creator (M14): a fine sync scarica quelle mancanti, così un
  // creator appena aggiunto ottiene l'avatar senza un'azione manuale separata
  // (force:false → salta i creator che ce l'hanno già). Non blocca il job.
  try {
    log('Aggiornamento foto profilo dei creator…');
    const a = await syncChannelAvatars({ force: false });
    log(`Foto creator: ${a.fetchedCount} scaricate, ${a.skippedCount} già presenti${a.failedCount ? `, ${a.failedCount} non trovate` : ''}.`);
  } catch (err) {
    log(`Foto creator non aggiornate: ${err.message}`);
  }

  return { enriched, failed, removed, total: candidates.length };
}
