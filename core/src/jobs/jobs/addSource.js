import { addSource } from '../../services/sourceService.js';
import { enrichSourceJob } from './enrichSource.js';

// Aggiunta "istantanea" di una fonte (playlist) dalla pagina Sorgenti: l'intera
// operazione — risoluzione della playlist via yt-dlp, registrazione, ingest
// flat, arricchimento metadati completi + copertine (fase 2, riusa
// enrichSourceJob) — gira come UN SOLO job in coda, così triggerJob() ritorna
// subito (il campo si libera all'istante) e il lavoro vero parte in differita,
// in ordine, mai in parallelo con altri job (il jobManager è single-worker).
// Non scarica MAI il video: solo metadati + copertina, come enrichSourceJob.
export async function addSourceJob({ url }, { log, progress }) {
  if (!url) throw new Error('addSource richiede il parametro "url"');

  log('Risoluzione playlist…');
  const result = await addSource(url);

  if (result.alreadyExists) {
    log(`Fonte già presente: "${result.name}".`);
    progress(100);
    return { alreadyExists: true, sourceId: result.sourceId, name: result.name };
  }

  log(`Fonte "${result.name}" registrata — ${result.newCount} video trovati.`);
  const enrich = await enrichSourceJob({ sourceId: result.sourceId }, { log, progress });

  return {
    alreadyExists: false,
    sourceId: result.sourceId,
    name: result.name,
    newCount: result.newCount,
    enriched: enrich.enriched,
    failed: enrich.failed,
    removed: enrich.removed
  };
}
