import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { DOWNLOAD_STATE } from '../catalog/catalogSchema.js';
import { deleteMetadata } from '../catalog/metadataStore.js';

// yt-dlp non ricontrolla mai se il file esiste ancora: `--download-archive`
// (il ledger ridondante di dedup, vedi PIANO.md) resta valorizzato per sempre
// una volta scritto. Se si cancella solo il file locale senza toglierlo da lì,
// un ri-download successivo viene SALTATO da yt-dlp (crede sia già scaricato),
// che chiude comunque con successo ma senza scrivere alcun file — da cui
// l'errore "Download completato ma file mancanti" (bug reale riscontrato
// dall'utente su pEhoILkfG8w). Righe nel formato "<extractor> <id>".
export function removeFromDownloadArchive(paths, videoId) {
  const file = paths.downloadArchivePath;
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf-8').split('\n');
  const filtered = lines.filter((line) => line.trim().split(/\s+/)[1] !== videoId);
  if (filtered.length !== lines.length) {
    writeFileSync(file, filtered.join('\n'));
  }
}

// Cancella SOLO il file video scaricato dal disco (M30), riportando il video a
// download:'none'. NON cancella l'entry di catalogo, i metadati grezzi né la
// copertina: il video resta in libreria, ri-scaricabile — coerente con "i
// record non si perdono mai". Rimuove anche la cartella del creator se rimasta
// vuota. È il ramo "No, non tenere il file" della domanda "Vuoi tenere il video?".
export async function deleteVideoFile(id) {
  const paths = getPaths();
  return updateCatalog((catalog) => {
    const video = catalog.videos[id];
    if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
    if (video.download !== DOWNLOAD_STATE.DOWNLOADED) {
      throw new Error(`Il video "${id}" non ha un file scaricato da cancellare (stato download: "${video.download}")`);
    }

    const rel = video.video?.localPath;
    if (rel) {
      const abs = path.join(paths.videosDir, rel);
      if (existsSync(abs)) unlinkSync(abs);
      const dir = path.dirname(abs);
      // rimuove la sottocartella creator se ora vuota (non la root videosDir)
      if (dir !== paths.videosDir && existsSync(dir) && readdirSync(dir).length === 0) {
        rmdirSync(dir);
      }
    }
    removeFromDownloadArchive(paths, id);

    // Reset dei soli campi legati al file fisico; metadati curati, thumbnail e
    // grezzo (data/metadata.json) restano intatti.
    video.download = DOWNLOAD_STATE.NONE;
    video.video = {
      localPath: null, formatId: null, container: null, videoCodec: null, audioCodec: null,
      bitrateKbps: null, sizeBytes: null, sha256: null, downloadedAt: null, ytdlpVersion: null,
      // M55: azzera anche l'eventuale nota di qualità ridotta del download precedente.
      qualityNote: null
    };
    video.updatedAt = new Date().toISOString();
    return video;
  });
}

// Cancellazione TOTALE e irreversibile (punto 11 del backlog, promossa a
// funzionalità): richiedibile SOLO su un video già archiviato (hidden) — un
// gate a due passi deliberato (prima archivia, poi eventualmente cancella per
// sempre), lo stesso spirito del pulsante "Cancella" mostrato solo in
// Archiviati. A differenza di deleteVideoFile qui sparisce anche la SCHEDA dal
// catalogo (file video + copertina + entry di catalogo + metadati grezzi in
// data/metadata.json), non solo il file fisico. Se il video appartiene ancora
// a una fonte attiva su YouTube, la prossima sync la ricrea da zero (nuovo
// stub, poi ri-arricchito) — non è un blocklist permanente, è "come se non
// l'avessimo mai catalogato". Tolto anche dall'archivio yt-dlp
// (--download-archive), stesso motivo di removeFromDownloadArchive sopra.
export async function deleteVideoCompletely(id) {
  const paths = getPaths();
  await updateCatalog(async (catalog) => {
    const video = catalog.videos[id];
    if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
    if (!video.hidden) {
      throw new Error(`Il video "${id}" va prima archiviato prima di poterlo cancellare definitivamente.`);
    }

    const videoRel = video.video?.localPath;
    if (videoRel) {
      const abs = path.join(paths.videosDir, videoRel);
      if (existsSync(abs)) unlinkSync(abs);
      const dir = path.dirname(abs);
      if (dir !== paths.videosDir && existsSync(dir) && readdirSync(dir).length === 0) {
        rmdirSync(dir);
      }
    }
    const thumbRel = video.thumbnail?.localPath;
    if (thumbRel) {
      const thumbAbs = path.join(paths.thumbnailsDir, thumbRel);
      if (existsSync(thumbAbs)) unlinkSync(thumbAbs);
    }
    removeFromDownloadArchive(paths, id);
    await deleteMetadata(id);
    delete catalog.videos[id];
  });
}

// Nomi riservati di Windows (case-insensitive): non possono essere usati come
// nome di file/cartella nemmeno con estensione.
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
]);

// Caratteri non ammessi nei nomi file Windows (< > : " / \ | ? *) piu' i
// caratteri di controllo. Costruita da un elenco esplicito per evitare ambiguita'
// di escaping nel sorgente.
const INVALID_CHARS = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', 'g');

// Titolo troppo lungo -> path oltre il limite di Windows. Il suffisso " [<id>]"
// e l'estensione restano SEMPRE interi (servono per il lookup per id): si taglia
// solo la parte di titolo.
const MAX_TITLE_LEN = 150;

// Rende una stringa sicura come singolo segmento di path su Windows. Non deve
// essere identica alla sanitizzazione di yt-dlp: i lookup dei file avvengono per
// marker "[<id>]", non per nome, quindi basta che sia valida e leggibile.
export function sanitizeName(name, fallback = 'Sconosciuto') {
  if (name === null || name === undefined) return fallback;
  let s = String(name)
    .replace(INVALID_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // niente spazi/punti finali (Windows li scarta)
  if (!s) return fallback;
  if (WINDOWS_RESERVED.has(s.toUpperCase())) s = `_${s}`;
  return s;
}

function extFromVideo(video) {
  if (video.video?.container) return video.video.container;
  if (video.video?.localPath) {
    const e = path.extname(video.video.localPath).replace('.', '');
    if (e) return e;
  }
  return 'mp4';
}

// Percorso canonico (relativo a videosDir, separatori "/") di un video:
// "<Creator>/<Titolo> [<id>].<ext>". L'id finale e' SEMPRE presente (come il
// default di yt-dlp): garantisce univocita' anche tra video con lo stesso titolo
// nello stesso canale, quindi nessuna gestione speciale delle collisioni serve.
export function targetRelPath(video) {
  const creator = sanitizeName(video.channel?.name, 'Sconosciuto');
  let title = sanitizeName(video.title, video.id);
  if (title.length > MAX_TITLE_LEN) title = title.slice(0, MAX_TITLE_LEN).trim();
  return `${creator}/${title} [${video.id}].${extFromVideo(video)}`;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// Trova il file video attuale di un'entry, ovunque si trovi dentro videosDir:
// prima prova il localPath registrato; se manca/non esiste, cerca ricorsivamente
// un file video il cui basename e' "<id>.<ext>" (vecchio layout piatto) oppure
// contiene "[<id>]" (gia' nel nuovo layout). Ritorna { abs, rel } o null.
function locateCurrentFile(paths, video) {
  const isVideo = (f) => /\.(mp4|mkv|webm)$/i.test(f);

  if (video.video?.localPath) {
    const abs = path.join(paths.videosDir, video.video.localPath);
    if (existsSync(abs)) return { abs, rel: video.video.localPath };
  }

  if (!existsSync(paths.videosDir)) return null;
  const id = video.id;
  const match = walkFiles(paths.videosDir).find((f) => {
    const base = path.basename(f);
    if (!isVideo(base)) return false;
    return base.startsWith(`${id}.`) || base.includes(`[${id}]`);
  });
  if (!match) return null;
  return { abs: match, rel: path.relative(paths.videosDir, match).split(path.sep).join('/') };
}

// Un file e' "gia' organizzato" se si trova in una sottocartella (creator) e il
// nome contiene il marker "[<id>]" - non serve che coincida carattere per
// carattere con targetRelPath(). yt-dlp sanifica i titoli a modo suo (es. "|"
// diventa "｜", pipe a tutta larghezza, non lo spazio scelto da sanitizeName())
// e quel nome, gia' assegnato da yt-dlp al momento del download, resta buono
// per sempre: non va "corretto" solo per farlo combaciare col nostro
// sanitizzatore. targetRelPath() resta il nome di ripiego per i file ancora
// piatti nella radice (vecchio layout) che vanno organizzati da zero.
function isAlreadyOrganized(current, videoId) {
  const hasSubfolder = current.rel.includes('/');
  const hasIdMarker = path.basename(current.rel).includes(`[${videoId}]`);
  return hasSubfolder && hasIdMarker;
}

// Rimuove le sottocartelle vuote rimaste sotto videosDir dopo gli spostamenti
// (la root videosDir stessa non viene mai rimossa).
function pruneEmptyDirs(dir, root) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name), root);
  }
  if (path.resolve(dir) !== path.resolve(root) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
  }
}

// Riorganizza l'archivio nel layout canonico per creator. Idempotente: i video
// gia' al posto giusto vengono saltati. Con dryRun non tocca nulla, ritorna solo
// il piano degli spostamenti.
export async function reorganizeLibrary({ dryRun = false } = {}) {
  const paths = getPaths();
  const catalog = await readCatalog();

  const moves = [];
  const missing = [];
  let alreadyOk = 0;

  for (const video of Object.values(catalog.videos)) {
    if (video.download !== DOWNLOAD_STATE.DOWNLOADED) continue;
    const current = locateCurrentFile(paths, video);
    if (!current) {
      missing.push(video.id);
      continue;
    }
    if (isAlreadyOrganized(current, video.id)) {
      // Il file e' gia' in un posto valido (creator/... [id].ext); allinea
      // comunque il localPath se era diverso (es. registrato con separatori
      // o forma diversa) ma non lo si rinomina mai per farlo combaciare con
      // targetRelPath().
      if (video.video.localPath !== current.rel && !dryRun) {
        await updateCatalog((cat) => {
          const v = cat.videos[video.id];
          if (v) {
            v.video.localPath = current.rel;
            v.updatedAt = new Date().toISOString();
          }
        });
      }
      alreadyOk++;
      continue;
    }
    const toRel = targetRelPath(video);
    const toAbs = path.join(paths.videosDir, toRel);
    moves.push({ id: video.id, from: current.rel, to: toRel, fromAbs: current.abs, toAbs });
  }

  if (dryRun) {
    return {
      dryRun: true,
      moved: 0,
      planned: moves.map(({ id, from, to }) => ({ id, from, to })),
      alreadyOk,
      missing
    };
  }

  let moved = 0;
  for (const m of moves) {
    mkdirSync(path.dirname(m.toAbs), { recursive: true });
    // L'id univoco nel nome rende una collisione con un file DIVERSO impossibile
    // in pratica; se il target esiste gia' (rerun interrotto), lo si considera
    // gia' a posto e si aggiorna solo il catalogo.
    if (!existsSync(m.toAbs)) {
      renameSync(m.fromAbs, m.toAbs);
    }
    await updateCatalog((cat) => {
      const v = cat.videos[m.id];
      if (v) {
        v.video.localPath = m.to;
        v.updatedAt = new Date().toISOString();
      }
    });
    moved++;
  }

  pruneEmptyDirs(paths.videosDir, paths.videosDir);

  return { dryRun: false, moved, planned: moves.length, alreadyOk, missing };
}
