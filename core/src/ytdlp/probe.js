// M78 — la risoluzione si misura sul file, non si deduce dai metadati.
//
// Perché esiste: i metadati di yt-dlp (`-J`) descrivono il **miglior formato
// disponibile**, non quello che abbiamo scaricato. Con il tetto di risoluzione
// (M56) il catalogo registrava `3840×2160` per un file che su disco è
// `1280×720`. Non è un'approssimazione: è un dato falso, e si propaga in ogni
// posto che lo mostra o ci filtra sopra.
//
// ffprobe è già in `tools/` — lo procura `npm run setup`, lo verifica il
// preflight — e finora lo usavamo solo per controllare che ci fosse.
//
// Nota: qui si misura **il file finale**, quindi va chiamata dopo la fusione
// video+audio, non prima.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPaths, expectedToolNames } from '../config.js';

// Stessa scala di precedenza di getPaths/preflight: ffprobe accanto a ffmpeg
// (tools/ o percorso in config) → altrimenti il nome nudo, che il sistema
// risolve nel PATH. Il terzo caso è legittimo (Homebrew, apt, Docker).
function ffprobeCommand() {
  const { ffmpegLocation } = getPaths();
  const { ffprobe } = expectedToolNames();
  if (ffmpegLocation) {
    const candidate = path.join(ffmpegLocation, ffprobe);
    if (existsSync(candidate)) return candidate;
  }
  return ffprobe;
}

// `avg_frame_rate` arriva come frazione ("30000/1001", a volte "0/0" per i
// flussi a fps variabile): si riduce a un numero, arrotondato come fa yt-dlp
// nei metadati, così i due valori restano confrontabili.
function parseFrameRate(raw) {
  if (typeof raw !== 'string') return null;
  const [num, den] = raw.split('/').map((n) => Number.parseFloat(n));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return null;
  return Math.round((num / den) * 100) / 100;
}

/**
 * Misura larghezza/altezza/fps del primo flusso video di un file.
 *
 * **Non lancia mai**: se ffprobe non è risolvibile, non parte, esce male o
 * risponde qualcosa che non si capisce, ritorna `null` e chi chiama tiene i
 * numeri dei metadati — approssimativi, ma meglio di niente e, soprattutto,
 * meglio che far fallire un download da 600MB già completato per una misura.
 *
 * @param {string} filePath percorso assoluto del file video
 * @returns {Promise<{width: number|null, height: number|null, fps: number|null}|null>}
 */
export async function probeResolution(filePath) {
  if (!filePath || !existsSync(filePath)) return null;

  const args = [
    '-v', 'error',
    // Il primo flusso video: un file può avere più tracce (audio, sottotitoli,
    // copertina incorporata — che è anch'essa un "video stream" di un fotogramma,
    // motivo per cui si prende v:0 e non "il primo stream").
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate',
    '-of', 'json',
    filePath
  ];

  const output = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffprobeCommand(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // ENOENT (ffprobe assente) arriva qui, non come throw dello spawn.
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout : null));
  });

  if (!output) return null;

  try {
    const stream = JSON.parse(output)?.streams?.[0];
    if (!stream) return null;
    const width = Number.isFinite(stream.width) ? stream.width : null;
    const height = Number.isFinite(stream.height) ? stream.height : null;
    // Se non si è cavato nemmeno un numero utile, si dichiara il fallimento
    // invece di restituire un oggetto di soli null che sovrascriverebbe i
    // metadati con "non lo so".
    if (width === null && height === null) return null;
    return { width, height, fps: parseFrameRate(stream.avg_frame_rate) };
  } catch {
    return null;
  }
}
