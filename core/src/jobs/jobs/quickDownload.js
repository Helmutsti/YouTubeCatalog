// M85 — un link incollato, dalla risoluzione al file in libreria, in UN job.
//
// È l'equivalente del "sentinel" del ramo Rust, e la ragione per cui esiste è il
// **parallelismo**: se incollare un link facesse partire prima una risoluzione
// bloccante e poi un job di download, ogni link terrebbe fermo chi l'ha
// incollato. Così invece `triggerJob('quickDownload', {url})` ritorna subito, il
// link occupa **un posto del pool**, e `jobs.parallel` decide quanti ne vanno
// insieme. È da qui che il download rapido prende il suo parallelismo.
//
// I passi sono due, e la differenza fra loro è tutta nel dove finisce l'errore:
//
//  1. **risoluzione** — il link non ha ancora un id, quindi non è un video:
//     vive in `catalog.queue`. Se fallisce qui, resta lì **col suo motivo**, e
//     ci si può riprovare sopra.
//  2. **download** — da qui in poi è un video come gli altri, con `state`,
//     `attempts` ed `error` suoi: la coda non c'entra più e il link ne esce.

import { dequeueLink, markLinkFailed } from '../../services/queueService.js';
import { prepareSingleVideoDownload } from '../../services/singleVideoService.js';
import { downloadSingleJob } from './downloadSingle.js';

const GIA_FATTO = {
  'already-downloaded': 'era già scaricato',
  'already-downloading': 'è già in download'
};

export async function quickDownloadJob(params, ctx) {
  const { url, maxHeight } = params;
  if (!url) throw new Error('quickDownload richiede il parametro "url"');
  const { log, note } = ctx;

  // M86 — le fasi che una schermata di avanzamento deve poter dire a parole
  // ("risolvendo", "recupero metadati", "scarico"), annotate sul job invece di
  // essere dedotte dalle righe di log: un testo di log è per gli umani, e
  // parsarlo vorrebbe dire legare la CLI alle parole esatte di un messaggio.
  note?.({ phase: 'resolve' });
  log(`Risoluzione del link… ${url}`);

  let resolved;
  try {
    // download:false — qui si vuole solo l'id in libreria; a scaricare ci pensa
    // il passo 2, che è lo stesso codice del download singolo (nessuna logica
    // duplicata fra i due percorsi).
    resolved = await prepareSingleVideoDownload(url, { download: false });
  } catch (err) {
    // Il link resta in coda col motivo: è la differenza fra "sparito" e
    // "fallito". Su un fallito si può riprovare, su uno sparito no.
    await markLinkFailed(url, err.message);
    throw err;
  }

  // Risolto: da adesso è un video, e la coda non è più il suo posto.
  await dequeueLink(url);

  if (resolved.action === 'already-downloaded' || resolved.action === 'already-downloading') {
    log(`"${resolved.title ?? resolved.videoId}" ${GIA_FATTO[resolved.action]}: niente da fare.`);
    return { videoId: resolved.videoId, action: resolved.action, downloaded: 0 };
  }

  // Risolto: da qui la riga di avanzamento può dire *chi* sta scaricando, non
  // solo il link incollato. La fase passa a "video" da sé, appena arriva la
  // prima percentuale da yt-dlp.
  note?.({ phase: 'metadata', videoId: resolved.videoId, title: resolved.title ?? null });
  log(`Risolto: "${resolved.title ?? resolved.videoId}". Scarico…`);

  // Stesso identico percorso del download singolo — compresa la presa in carico
  // atomica (M75), che è ciò che impedisce a due link uguali incollati insieme
  // di scaricare due volte lo stesso file.
  const esito = await downloadSingleJob({ videoId: resolved.videoId, maxHeight }, ctx);
  return { videoId: resolved.videoId, action: 'downloaded', ...esito };
}
