import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { acquireDataLock } from './lock.js';
import { inPath, findVlc } from './lib/which.js';
import { INSTALL_ROOT, CORE_DIR } from './lib/installRoot.js';
import { deepMerge } from './lib/deepMerge.js';
import { loadAppConfig } from './appConfig.js';
import { DATA_DIR_NAME, CATALOG_FILE_NAME, LIBRARY_CONFIG_FILE_NAME, libraryRoot, toolsRoot } from './library.js';

// M96 — il file di configurazione della LIBRERIA contiene UNA cosa sola: dove
// stanno i video. Tutto il resto (qualità, parallelismo, formato, porta, VLC) è
// passato nel file dell'APPLICAZIONE, vedi appConfig.js — che spiega anche la
// regola per decidere dove va un campo.
//
// Perché i video sono l'unica eccezione: sono la sola cosa che la libreria non
// può dedurre. Sono grandi, vivono spesso su un altro disco, e nessuna
// convenzione può indovinare quale. Tutto ciò che è deducibile (data/, media/)
// o che è proprietà della macchina (i binari, VLC) non ha motivo di stare qui.
const DEFAULT_CONFIG = {
  // Cartella dei soli file video (con sottocartelle per creator dentro).
  // null = la cartella `videos/` DENTRO la libreria: è il caso autoportante, in
  // cui libreria e video si spostano insieme senza aggiornare nulla.
  // Altrimenti un percorso ASSOLUTO, per i video su un disco dedicato.
  // Copertine e avatar vivono comunque in `thumbnails/` e `avatars/` dentro la
  // libreria e non sono spostabili: sono piccoli e sono stato della libreria.
  // I video no — per questo sono gli unici con un percorso proprio.
  videosRoot: null
};

// Il file della libreria ATTIVA: dipende da quale libreria si sta usando
// (M98: la cartella corrente), quindi è una funzione e non una costante.
function configPath() {
  return path.join(libraryRoot(), DATA_DIR_NAME, LIBRARY_CONFIG_FILE_NAME);
}

let cachedConfig = null;

/**
 * Le impostazioni della LIBRERIA attiva (solo `videosRoot`).
 *
 * M98 — se il file non c'è si usano i default **in memoria**, senza scriverlo.
 * Prima lo creava, e con la libreria presa dalla cartella corrente quello
 * basterebbe a seminare `data/conf.json` in giro. Il file lo scrive
 * `initLibrary()`, oppure `updateLibraryConfig()` quando l'utente cambia
 * davvero qualcosa.
 */
export function loadLibraryConfig() {
  if (cachedConfig) return cachedConfig;

  const file = configPath();
  const userConfig = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};

  cachedConfig = deepMerge(DEFAULT_CONFIG, userConfig);
  return cachedConfig;
}

// Aggiorna il config della libreria: legge le override utente dal file, vi
// applica `patch` (deep-merge), riscrive atomicamente (tmp+rename) e INVALIDA la
// cache in-memory così il prossimo load rilegge da disco. Nota: per un
// processo già avviato (server) alcune cose sono fissate all'avvio (es. i mount
// express.static sui media), quindi resta comunque necessario un riavvio.
//
// M92 — lettura e scrittura dentro il lock (data/): già rileggeva da disco a
// ogni chiamata invece di fidarsi della cache, quindi qui il rischio non era
// la staleness ma la sovrapposizione fisica di due scritture (server e CLI che
// aggiornano le impostazioni nello stesso istante); il lock copre quello.
// Il file dell'applicazione non passa da qui e non usa il lock: è di un solo
// programma, mentre questo file è nella libreria, condivisa.
export function updateLibraryConfig(patch) {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireDataLock();
  try {
    let userConfig = {};
    if (existsSync(file)) {
      userConfig = JSON.parse(readFileSync(file, 'utf-8'));
    }
    const updated = deepMerge(userConfig, patch);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    renameSync(tmp, file);
  } finally {
    release();
  }
  cachedConfig = null;
  return loadLibraryConfig();
}

// Imposta la posizione della cartella dei VIDEO (videosRoot), la sola
// spostabile — copertine e avatar restano dentro la libreria. Modalità
// "solo ripuntamento": NON sposta alcun file — l'utente sposta la cartella e
// poi indica il percorso, che qui viene solo validato e persistito. Le
// sottocartelle per creator vivono direttamente dentro questa cartella.
export function setVideosRoot(newPath) {
  if (typeof newPath !== 'string' || !newPath.trim()) {
    throw new Error('Percorso non valido.');
  }
  const value = newPath.trim();
  // M95 — solo percorsi ASSOLUTI. Un percorso relativo è ambiguo appena il
  // catalogo viene letto da un altro punto d'ingresso: "videos" significa una
  // cartella diversa per la CLI del repo, per il pacchetto installato
  // globalmente e per il container. L'unico relativo che ha un senso univoco è
  // "dentro il catalogo", e quello si esprime con null (vedi DEFAULT_CONFIG),
  // non con una stringa.
  // I valori relativi già presenti in un conf.json continuano a essere
  // risolti da getPaths (retrocompatibilità): qui si impedisce solo di
  // scriverne di nuovi.
  if (!path.isAbsolute(value)) {
    throw new Error(
      `Serve un percorso assoluto (es. ${process.platform === 'win32' ? 'D:\\YouTube\\Video' : '/mnt/media/video'}); ` +
      'per tenere i video dentro il catalogo, azzera invece la cartella con clearVideosRoot.'
    );
  }
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) {
    throw new Error(
      `Il percorso non esiste: ${resolved}. Crea o sposta prima la cartella dei video in questa posizione, poi imposta il percorso.`
    );
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Il percorso non è una cartella: ${resolved}.`);
  }
  updateLibraryConfig({ videosRoot: value });
  return { videosRoot: value, resolved, requiresRestart: true };
}

// M95 — rimette i video DENTRO il catalogo (`videosRoot: null`), che è il caso
// autoportante. Serve come contrario esplicito di setVideosRoot: da quando i
// percorsi relativi non si accettano più, "torna al default" non è più
// esprimibile passando una stringa.
// Come setVideosRoot NON sposta alcun file: cambia solo dove si guarda.
export function clearVideosRoot() {
  updateLibraryConfig({ videosRoot: null });
  return { videosRoot: null, resolved: path.join(libraryRoot(), 'videos'), requiresRestart: true };
}

// Cookie per YouTube (video privati/non listati/con limite d'età) — file
// Netscape cookie-jar esportato dal browser, path fisso `core/cookies.txt`
// (mai in git, vedi .gitignore). getPaths() lo rileva da solo a ogni chiamata
// (existsSync su questo stesso percorso): niente riavvio dopo un
// upload/cancellazione, il prossimo comando yt-dlp lo vede già.
const DEFAULT_COOKIES_PATH = path.join(CORE_DIR, 'cookies.txt');

export function getCookiesStatus() {
  if (!existsSync(DEFAULT_COOKIES_PATH)) return { present: false, updatedAt: null };
  return { present: true, updatedAt: statSync(DEFAULT_COOKIES_PATH).mtime.toISOString() };
}

export function saveCookiesFile(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('File cookie vuoto o non valido.');
  }
  const tmp = `${DEFAULT_COOKIES_PATH}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, DEFAULT_COOKIES_PATH);
  return getCookiesStatus();
}

export function deleteCookiesFile() {
  if (existsSync(DEFAULT_COOKIES_PATH)) unlinkSync(DEFAULT_COOKIES_PATH);
  return getCookiesStatus();
}

// Nomi attesi dei binari in tools/, per sistema operativo. FONTE UNICA: la usano
// sia getPaths() (per risolverli) sia scripts/setup.mjs (per scaricarli col nome
// giusto) sia preflight.js (per il messaggio d'errore) — se la convenzione
// cambiasse in un solo posto, i tre pezzi divergerebbero silenziosamente.
// I nomi di yt-dlp sono quelli delle release ufficiali; su Linux ARM l'asset si
// chiama `yt-dlp_linux_aarch64` ma va SALVATO come `yt-dlp_linux` (qui sotto),
// perché è quello che il codice cerca a runtime, a prescindere dall'architettura.
export function expectedToolNames(platform = process.platform) {
  return {
    ytdlp:
      platform === 'win32' ? 'yt-dlp.exe' :
      platform === 'darwin' ? 'yt-dlp_macos' :
      'yt-dlp_linux',
    ffmpeg: platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    ffprobe: platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  };
}

export function getPaths() {
  const config = loadLibraryConfig();
  // M96 — data/ e i video seguono la LIBRERIA (che può stare altrove);
  // tools/ e i cookie seguono l'INSTALLAZIONE (dove sta il codice). Nel caso
  // normale le due radici coincidono.
  const LIBRARY_ROOT = libraryRoot();
  // M97 — il layout della libreria, quattro cartelle in cima e i file
  // funzionali dentro data/:
  //
  //   <libreria>/videos/          i file video (o altrove: vedi videosRoot)
  //   <libreria>/thumbnails/      le copertine
  //   <libreria>/avatars/         le foto profilo dei canali
  //   <libreria>/data/            libreria.json (il catalogo), conf.json,
  //                               metadata.json, jobs.json, il lock, l'archivio
  //
  // Copertine e avatar stavano dentro data/media/: ora sono in cima, alla pari
  // dei video. `data/` resta per ciò che è funzionale — il catalogo e i file di
  // servizio — e non contiene più immagini.
  const dataDir = path.join(LIBRARY_ROOT, DATA_DIR_NAME);
  // I video sono l'unica cartella spostabile: sono grandi e spesso su un disco
  // dedicato, ed è l'unica cosa che conf.json contiene. Se videosRoot non è
  // impostato si ricade su <libreria>/videos. video.localPath resta relativo a
  // questa cartella (videosDir), qualunque sia la sua posizione.
  const videosDir = config.videosRoot
    ? path.resolve(LIBRARY_ROOT, config.videosRoot)
    : path.join(LIBRARY_ROOT, 'videos');
  const thumbnailsDir = path.join(LIBRARY_ROOT, 'thumbnails');
  const avatarsDir = path.join(LIBRARY_ROOT, 'avatars');
  const jobsDir = path.join(dataDir, 'jobs');

  // M98 — qui NON si crea più niente. Prima queste tre righe facevano
  // `mkdirSync` su videos/thumbnails/avatars: comodo quando la libreria era una
  // sola e in un posto noto, ma da quando è «quella in cui ti trovi» significa
  // fabbricare una libreria in qualunque cartella da cui si lanci un comando.
  // Creare è compito di `initLibrary()` (core/src/library.js), e solo suo.
  // Nota: data/jobs/ (vecchio layout "un file per job") NON viene più creata —
  // lo storico vive in data/jobs.json (jobManager). Il path jobsDir resta
  // esposto solo per la migrazione una tantum dal vecchio layout, se presente.

  return {
    // M96 — due radici distinte, prima erano la stessa cosa (`projectRoot`).
    libraryRoot: LIBRARY_ROOT,
    installRoot: INSTALL_ROOT,
    coreDir: CORE_DIR,
    videosDir,
    thumbnailsDir,
    avatarsDir,
    dataDir,
    // M97 — il catalogo si chiama `libreria.json` (era catalog.json), e
    // l'archivio di yt-dlp è passato da data/media/ a data/: è un file
    // funzionale, non un'immagine.
    catalogPath: path.join(dataDir, CATALOG_FILE_NAME),
    metadataPath: path.join(dataDir, 'metadata.json'),
    jobsDir,
    downloadArchivePath: path.join(dataDir, '.ytdlp-archive.txt'),
    ...getToolPaths()
  };
}

/**
 * I percorsi che appartengono all'INSTALLAZIONE: binari esterni, cookie, VLC.
 *
 * Separati da getPaths() (M98) perché **non richiedono una libreria**, e per un
 * motivo concreto: `ondo setup` scarica i binari e deve funzionare da qualunque
 * cartella, anche prima che una libreria esista. Se passasse da getPaths(),
 * lanciare `ondo setup` fuori da una libreria fallirebbe — e sarebbe assurdo,
 * perché i binari non hanno niente a che vedere con l'archivio. Vale anche per
 * `checkTools()`, che dice se l'installazione è completa.
 */
export function getToolPaths() {
  // Cookie: percorso fisso (M95 — non più configurabile). Il file lo si mette
  // qui a mano o lo si carica dalla web app / dal menu: in entrambi i casi
  // finisce sempre in questo punto, quindi un campo che ne indicasse un altro
  // era un modo per avere due sorgenti di verità e nessuna certezza su quale
  // valesse.
  const defaultCookiesPath = path.join(CORE_DIR, 'cookies.txt');
  const cookiesPath = existsSync(defaultCookiesPath) ? defaultCookiesPath : null;

  // Binari esterni (M95): due soli posti, in ordine — la cartella tools/
  // dell'INSTALLAZIONE (dove scrive `setup`), poi il PATH di sistema (Homebrew,
  // apt, /opt/ondo/bin nell'immagine Docker). Il nome cercato dipende dal
  // sistema operativo: così la stessa libreria gira su Windows/Linux/macOS
  // senza portarsi dietro percorsi di nessuno dei tre.
  //
  // M96/M98 — tools/ segue l'installazione, non la libreria: i binari sono del
  // computer, dieci librerie condividono lo stesso yt-dlp, e una libreria su un
  // disco esterno non deve pretendere di avere i binari accanto ai video.
  const toolNames = expectedToolNames();
  const ytdlpDefaultName = toolNames.ytdlp;
  const toolsDir = toolsRoot();
  const ytdlpInTools = path.join(toolsDir, ytdlpDefaultName);
  const ytdlpBinaryPath = existsSync(ytdlpInTools)
    ? ytdlpInTools
    // Se non c'è da nessuna parte si restituisce comunque il percorso in tools/:
    // è il posto dove DOVREBBE stare, ed è quello che preflight mostra nel
    // messaggio d'errore — più utile di un null o di un nome nudo.
    : (inPath(ytdlpDefaultName) ?? inPath('yt-dlp') ?? ytdlpInTools);

  // ffmpeg (usato da yt-dlp per fondere video+audio e convertire le copertine in
  // jpg): se sta in tools/, si passa quella cartella a yt-dlp via
  // --ffmpeg-location — così l'app funziona senza ffmpeg installato nel sistema.
  // Se resta null, yt-dlp lo cerca nel PATH, dove sta negli altri casi.
  const ffmpegName = toolNames.ffmpeg;
  const ffmpegLocation = existsSync(path.join(toolsDir, ffmpegName)) ? toolsDir : null;

  return {
    toolsDir,
    ytdlpBinaryPath,
    cookiesPath,
    ffmpegLocation,
    // VLC: un percorso nel file dell'applicazione lo impone (M96, per chi lo
    // tiene in un posto non standard); altrimenti lo si cerca (M95). null =
    // non installato.
    vlcPath: loadAppConfig().vlcPath || findVlc()
  };
}
