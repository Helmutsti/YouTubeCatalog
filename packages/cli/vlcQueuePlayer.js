import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getPaths } from '../../core/src/index.js';

// Lancio di VLC per il CLI (M52). Prima viveva in core come
// `services/playbackService.js#playVideo()`: analizzando la milestone è
// emerso che "lanciare un processo su questa specifica macchina" non è una
// capacità di dominio condivisa (core non dovrebbe lanciare nulla), è un
// dettaglio dell'adapter CLI — quindi ora vive solo qui, locale, non
// esportato da core né condiviso col server (la route server equivalente era
// codice morto ed è stata rimossa insieme).
//
// Estesa per accettare una LISTA di file invece di uno solo: VLC accoda
// nativamente più file passati sulla riga di comando (li mette in coda da
// sé), quindi non serve scrivere nessuna logica di sequenziamento qui.

// Dato un video del catalogo, risolve il percorso assoluto del file
// scaricato (o lancia se manca su disco/non ancora scaricato).
export function resolveVideoPath(video) {
  if (video.download !== 'downloaded' || !video.video?.localPath) {
    throw new Error(`Il video "${video.id}" non è ancora stato scaricato (stato download: "${video.download}")`);
  }
  const paths = getPaths();
  const filePath = path.join(paths.videosDir, video.video.localPath);
  if (!existsSync(filePath)) {
    throw new Error(`File video mancante su disco: ${filePath}`);
  }
  return filePath;
}

// Lancia VLC con una lista di file già risolti (percorsi assoluti). mode:
// 'video' (default) o 'audio' (--no-video, come nel vecchio playVideo).
export function playFiles(filePaths, { mode = 'video' } = {}) {
  if (!filePaths.length) {
    throw new Error('Nessun file da riprodurre.');
  }
  const paths = getPaths();
  if (!existsSync(paths.vlcPath)) {
    throw new Error(`VLC non trovato in "${paths.vlcPath}": imposta playback.vlcPath in data/config.json`);
  }
  const args = mode === 'audio' ? ['--no-video', ...filePaths] : [...filePaths];
  const child = spawn(paths.vlcPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
}
