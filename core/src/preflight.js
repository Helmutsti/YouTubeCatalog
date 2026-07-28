// M64 — controllo dei prerequisiti esterni (yt-dlp, ffmpeg) all'avvio.
//
// Perché esiste: senza questo controllo, un'installazione incompleta non si
// manifesta all'avvio ma molto più tardi, come `spawn ENOENT` in mezzo a un
// download — un errore che non dice all'utente né cosa manca né cosa fare.
// Qui il problema si scopre subito e il messaggio dice il comando da eseguire.
//
// Vive nel core (non in cli.js/server) perché è una regola del dominio
// "l'app sa di cosa ha bisogno per funzionare": CLI e server la consumano.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getPaths, expectedToolNames } from './config.js';

// ffmpeg è risolvibile in tre modi, in ordine di precedenza (stessa scala di
// getPaths): percorso esplicito in config → binario in tools/ → PATH di sistema.
// Il terzo caso è legittimo (Homebrew, apt, immagine Docker) e NON va segnalato
// come errore: per questo il controllo non si limita a esistsSync su tools/.
function ffmpegOnPath() {
  try {
    // -version è istantaneo e non tocca nulla; stdio ignorato per non sporcare.
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Verifica i binari esterni necessari.
 * @returns {{ok: boolean, ytdlp: {ok: boolean, path: string}, ffmpeg: {ok: boolean, source: string|null}, messages: string[]}}
 */
export function checkTools() {
  const paths = getPaths();
  const names = expectedToolNames();
  const messages = [];

  const ytdlpOk = existsSync(paths.ytdlpBinaryPath);
  if (!ytdlpOk) {
    messages.push(
      `yt-dlp non trovato in ${paths.ytdlpBinaryPath}\n` +
      `  Serve il file "${names.ytdlp}" nella cartella tools/.`
    );
  }

  // ffmpegLocation è già la risoluzione fatta da getPaths (config o tools/);
  // se è null resta il PATH di sistema, che qui verifichiamo davvero.
  let ffmpegSource = null;
  if (paths.ffmpegLocation) {
    ffmpegSource = paths.ffmpegLocation;
  } else if (ffmpegOnPath()) {
    ffmpegSource = 'PATH di sistema';
  } else {
    messages.push(
      `ffmpeg non trovato (né in ${paths.toolsDir} né nel PATH di sistema).\n` +
      `  Serve per unire video e audio: senza, i download falliscono.`
    );
  }

  // ffprobe accompagna sempre ffmpeg: yt-dlp lo usa per ispezionare i flussi
  // prima della fusione. Controllato solo quando ffmpeg viene da tools/ — se
  // ffmpeg è nel PATH, ffprobe lo è praticamente sempre (stesso pacchetto).
  if (paths.ffmpegLocation && !existsSync(path.join(paths.ffmpegLocation, names.ffprobe))) {
    messages.push(
      `${names.ffprobe} manca accanto a ffmpeg in ${paths.ffmpegLocation}\n` +
      `  yt-dlp ne ha bisogno insieme a ffmpeg: servono entrambi i file.`
    );
  }

  return {
    ok: messages.length === 0,
    ytdlp: { ok: ytdlpOk, path: paths.ytdlpBinaryPath },
    ffmpeg: { ok: ffmpegSource !== null, source: ffmpegSource },
    messages
  };
}

/**
 * Stampa l'esito su console quando qualcosa manca, con il rimedio.
 * Non termina il processo: server e CLI restano usabili per tutto ciò che non
 * scarica (sfogliare il catalogo, riprodurre i video già presenti, backup).
 * @returns {boolean} true se è tutto a posto
 */
export function reportToolsOnStartup() {
  const result = checkTools();
  if (result.ok) return true;

  console.warn('\n⚠  Installazione incompleta — i download NON funzioneranno.\n');
  for (const message of result.messages) console.warn(`  • ${message}\n`);
  console.warn('  Rimedio: esegui  npm run setup\n');
  return false;
}
