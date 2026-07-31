// M86 — riproduzione con VLC. Traduzione di `ondo-core/src/playback.rs` e di
// `Library::play`.
//
// Vive nel core e non nella CLI perché è una regola del dominio ("un video si
// riproduce solo se è scaricato e il file c'è davvero"), non un dettaglio di
// interfaccia: in Rust era `Library::play`, non una funzione della CLI.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { getPaths, loadConfig } from '../config.js';
import { readCatalog } from '../catalog/catalogStore.js';
import { DOWNLOAD_STATE } from '../catalog/catalogSchema.js';

export const PLAYBACK_MODE = Object.freeze({ VIDEO: 'video', AUDIO: 'audio' });

/** Percorso assoluto del file di un video (i `localPath` sono relativi a videosDir). */
export function videoFilePath(video) {
  const rel = video?.video?.localPath;
  if (!rel) return null;
  return path.resolve(getPaths().videosDir, rel);
}

/**
 * Lancia VLC su un video già scaricato e **non aspetta**: parte come processo
 * indipendente e continua a suonare anche se la CLI viene chiusa.
 */
export async function playVideo(id, { mode = PLAYBACK_MODE.VIDEO } = {}) {
  const catalog = await readCatalog();
  const video = catalog.videos[id];
  if (!video) throw new Error(`nessun video con id ${id}`);
  if (video.download !== DOWNLOAD_STATE.DOWNLOADED) {
    throw new Error(`«${video.title}» non è ancora scaricato`);
  }

  const vlc = loadConfig().playback?.vlcPath || null;
  if (!vlc) {
    throw new Error('VLC non è configurato: impostalo dalle impostazioni (`playback.vlcPath` in data/config.json)');
  }
  if (!existsSync(vlc)) {
    throw new Error(`VLC non è in ${vlc}: correggi il percorso dalle impostazioni`);
  }

  const file = videoFilePath(video);
  if (!file || !existsSync(file)) {
    throw new Error(`il file non c'è: ${file ?? '(percorso non registrato)'}`);
  }

  const args = mode === PLAYBACK_MODE.AUDIO ? ['--no-video', file] : [file];
  try {
    spawn(vlc, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    throw new Error(`VLC non avviabile (${vlc}): ${err.message}`);
  }
  return { id, mode, file };
}
