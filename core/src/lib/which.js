// M94 — ricerca di un eseguibile nel PATH. Estratto da preflight.js perché ora
// serve anche a config.js (risoluzione di yt-dlp: tools/ → PATH), e config.js
// non può importare preflight.js — è preflight a importare config, non il
// contrario. preflight continua a esportare `inPath` da qui, quindi per chi lo
// consuma dall'esterno (il menu, via core/index.js) nulla cambia.

import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Cerca un eseguibile nel PATH restituendo il percorso **assoluto**.
 * Serve perché "il nome nudo funziona, tanto ci pensa il sistema" non si può
 * verificare: un percorso che esiste si controlla, un nome nudo no.
 *
 * Su Windows aggiunge `.exe`, ma solo se il nome non lo ha già — chi passa
 * `expectedToolNames().ytdlp` passa `yt-dlp.exe`, e cercare `yt-dlp.exe.exe`
 * non troverebbe mai nulla.
 */
export function inPath(name) {
  const isWin = process.platform === 'win32';
  const file = isWin && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// M95 — VLC si cerca, non si configura. Prima il suo percorso era un campo di
// data/config.json (`playback.vlcPath`), con un default hardcoded a
// "C:\Program Files (x86)\VideoLAN\VLC\vlc.exe" che era giusto su una macchina
// e sbagliato su tutte le altre: un percorso di sistema in un file che vuole
// descrivere il *catalogo* non ha senso, perché cambia col computer e non con
// l'archivio. L'installer di VLC non si mette nel PATH su Windows, quindi il
// PATH da solo non basta: servono anche le posizioni standard.
function vlcCandidates() {
  if (process.platform === 'win32') {
    // Da %ProgramFiles% e non da "C:\..." hardcoded: su un sistema con Windows
    // installato altrove, o in una lingua che rinomina la cartella, il percorso
    // fisso non esiste.
    return [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['ProgramW6432']]
      .filter(Boolean)
      .map((base) => path.join(base, 'VideoLAN', 'VLC', 'vlc.exe'));
  }
  if (process.platform === 'darwin') {
    return ['/Applications/VLC.app/Contents/MacOS/VLC'];
  }
  // Linux: i gestori di pacchetti mettono sempre vlc nel PATH, coperto sotto.
  return [];
}

/** Percorso assoluto di VLC, o null se non è installato dove sappiamo guardare. */
export function findVlc() {
  const fromPath = inPath('vlc');
  if (fromPath) return fromPath;
  for (const candidate of vlcCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
