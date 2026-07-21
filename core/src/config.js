import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CORE_DIR = path.resolve(__dirname, '..');

const DEFAULT_CONFIG = {
  mediaRoot: './media',
  port: 3001,
  ytdlp: {
    binaryPath: './tools/yt-dlp.exe',
    format: 'bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]/b',
    mergeOutputFormat: 'mp4',
    maxHeight: null,
    cookiesFile: null
  },
  playback: {
    vlcPath: 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
  },
  jobs: {
    maxAttempts: 3
  }
};

function deepMerge(defaults, overrides) {
  if (Array.isArray(defaults) || Array.isArray(overrides)) {
    return overrides !== undefined ? overrides : defaults;
  }
  if (isPlainObject(defaults) && isPlainObject(overrides)) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    }
    return result;
  }
  return overrides !== undefined ? overrides : defaults;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'config.json');

let cachedConfig = null;

export function loadConfig() {
  if (cachedConfig) return cachedConfig;

  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

  let userConfig;
  if (existsSync(CONFIG_PATH)) {
    userConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } else {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
    userConfig = DEFAULT_CONFIG;
  }

  cachedConfig = deepMerge(DEFAULT_CONFIG, userConfig);
  return cachedConfig;
}

// Aggiorna data/config.json a runtime: legge le override utente dal file, vi
// applica `patch` (deep-merge), riscrive atomicamente (tmp+rename) e INVALIDA la
// cache in-memory così il prossimo loadConfig() rilegge da disco. Nota: per un
// processo già avviato (server) alcune cose sono fissate all'avvio (es. i mount
// express.static sui media), quindi resta comunque necessario un riavvio.
export function updateConfig(patch) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  let userConfig = {};
  if (existsSync(CONFIG_PATH)) {
    userConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  const updated = deepMerge(userConfig, patch);
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  renameSync(tmp, CONFIG_PATH);
  cachedConfig = null;
  return loadConfig();
}

// Imposta la posizione della cartella media (relocazione fuori dal progetto).
// Modalità "solo ripuntamento": NON sposta alcun file — l'utente sposta la
// cartella e poi indica il percorso, che qui viene solo validato e persistito.
// Regge sul fatto che i localPath nel catalogo sono relativi a mediaRoot.
export function setMediaRoot(newPath) {
  if (typeof newPath !== 'string' || !newPath.trim()) {
    throw new Error('Percorso non valido.');
  }
  const value = newPath.trim();
  const resolved = path.resolve(PROJECT_ROOT, value);
  if (!existsSync(resolved)) {
    throw new Error(
      `Il percorso non esiste: ${resolved}. Sposta prima la cartella media in questa posizione, poi imposta il percorso.`
    );
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Il percorso non è una cartella: ${resolved}.`);
  }
  updateConfig({ mediaRoot: value });
  // Avvisa (senza bloccare) se la nuova posizione non contiene i video: aiuta a
  // scoprire un percorso sbagliato o uno spostamento incompleto.
  const hasVideos = existsSync(path.join(resolved, 'videos'));
  return { mediaRoot: value, resolved, hasVideos, requiresRestart: true };
}

export function getPaths() {
  const config = loadConfig();
  const mediaRoot = path.resolve(PROJECT_ROOT, config.mediaRoot);
  const dataDir = path.join(PROJECT_ROOT, 'data');
  const videosDir = path.join(mediaRoot, 'videos');
  const thumbnailsDir = path.join(mediaRoot, 'thumbnails');
  const avatarsDir = path.join(mediaRoot, 'avatars');
  const jobsDir = path.join(dataDir, 'jobs');

  mkdirSync(videosDir, { recursive: true });
  mkdirSync(thumbnailsDir, { recursive: true });
  mkdirSync(avatarsDir, { recursive: true });
  // Nota: data/jobs/ (vecchio layout "un file per job") NON viene più creata —
  // lo storico vive in data/jobs.json (jobManager). Il path jobsDir resta
  // esposto solo per la migrazione una tantum dal vecchio layout, se presente.

  const defaultCookiesPath = path.join(CORE_DIR, 'cookies.txt');
  let cookiesPath = null;
  if (config.ytdlp.cookiesFile) {
    const explicit = path.resolve(PROJECT_ROOT, config.ytdlp.cookiesFile);
    if (existsSync(explicit)) cookiesPath = explicit;
  } else if (existsSync(defaultCookiesPath)) {
    cookiesPath = defaultCookiesPath;
  }

  return {
    projectRoot: PROJECT_ROOT,
    coreDir: CORE_DIR,
    mediaRoot,
    videosDir,
    thumbnailsDir,
    avatarsDir,
    dataDir,
    catalogPath: path.join(dataDir, 'catalog.json'),
    metadataPath: path.join(dataDir, 'metadata.json'),
    jobsDir,
    ytdlpBinaryPath: path.resolve(PROJECT_ROOT, config.ytdlp.binaryPath),
    downloadArchivePath: path.join(mediaRoot, '.ytdlp-archive.txt'),
    cookiesPath,
    vlcPath: config.playback.vlcPath
  };
}
