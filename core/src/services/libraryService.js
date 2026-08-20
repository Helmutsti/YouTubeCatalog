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
      removeDirIfEmpty(dir, paths.videosDir);
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
      removeDirIfEmpty(dir, paths.videosDir);
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

// M86 — «Togli dalla libreria». Traduzione di `Library::remove(id, delete_files)`
// dal ramo Rust, ed è **un'altra cosa** da deleteVideoCompletely qui sopra:
//   - nessun gate "prima archivialo": chi chiama ha già chiesto conferma (la CLI
//     chiede due volte, la seconda solo per i file);
//   - i file si cancellano **su richiesta**, non sempre: togliere la scheda
//     tenendo il file è il caso normale di chi vuole solo pulire l'elenco.
// Ritorna `false` se quell'id non c'era, come l'originale.
export async function removeVideoFromLibrary(id, { deleteFiles = false } = {}) {
  const paths = getPaths();
  return updateCatalog(async (catalog) => {
    const video = catalog.videos[id];
    if (!video) return false;

    if (deleteFiles) {
      const videoRel = video.video?.localPath;
      if (videoRel) {
        const abs = path.join(paths.videosDir, videoRel);
        if (existsSync(abs)) unlinkSync(abs);
        const dir = path.dirname(abs);
        // La sottocartella del creator si rimuove solo se resta vuota.
        removeDirIfEmpty(dir, paths.videosDir);
      }
      const thumbRel = video.thumbnail?.localPath;
      if (thumbRel) {
        const thumbAbs = path.join(paths.thumbnailsDir, thumbRel);
        if (existsSync(thumbAbs)) unlinkSync(thumbAbs);
      }
      removeFromDownloadArchive(paths, id);
      await deleteMetadata(id);
    }

    delete catalog.videos[id];
    return true;
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

// Rimuove `dir` se e' rimasta vuota, senza fidarsi di existsSync come guardia:
// su un bridge di condivisione file (Docker Desktop + disco esterno, ExFAT,
// verificato) existsSync/stat su un path con una normalizzazione Unicode (NFC)
// diversa da quella con cui la cartella e' scritta sul disco (NFD, es. "Olivé"
// con la é composta da lettera + accento separato) risultano vere per un
// falso positivo, ma readdirSync sullo stesso path lancia ENOENT: existsSync
// non basta, va intercettato l'errore della lettura vera e propria.
function removeDirIfEmpty(dir, root) {
  if (dir === root) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (entries.length === 0) rmdirSync(dir);
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

const isVideoFile = (f) => /\.(mp4|mkv|webm)$/i.test(f);

// Id di un video dal basename del suo file: "[<id>].<ext>" (nuovo layout) o
// "<id>.<ext>" (vecchio layout piatto, l'id e' l'intero nome senza estensione).
function extractVideoId(base) {
  const bracket = base.match(/\[([^[\]]+)\]\.[^.]+$/);
  if (bracket) return bracket[1];
  const dot = base.indexOf('.');
  return dot > 0 ? base.slice(0, dot) : null;
}

// Indice id -> path assoluto di tutti i file video sotto videosDir, con UNA
// sola scansione ricorsiva. reconcileWithDisk (M92) chiama locateCurrentFile
// per OGNI video del catalogo a ogni caricamento/scrittura: senza indice,
// ciascun video privo di localPath valido (non ancora scaricato, o con path
// registrato ma non piu' trovato) rifaceva da capo l'intera scansione
// dell'archivio — con centinaia di video e videosDir su un disco esterno
// condiviso via Docker Desktop, questo significava migliaia di letture di
// cartella per un solo caricamento, abbastanza da incappare quasi sempre in
// un ENOENT transitorio del bridge di condivisione file (verificato: la
// stessa scansione, ripetuta, a volte fallisce e a volte no sullo stesso
// identico percorso — non e' un problema di normalizzazione Unicode del nome,
// e' proprio instabilita' del mount).
export function buildVideoFileIndex(videosDir) {
  const index = new Map();
  if (!existsSync(videosDir)) return index;

  // Anche con una sola scansione, un mount instabile puo' far fallire proprio
  // questa: un paio di tentativi immediati bastano quasi sempre a scavalcare
  // il blip (verificato: la stessa identica scansione, ripetuta subito dopo,
  // di norma riesce).
  let files;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      files = walkFiles(videosDir);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;

  for (const abs of files) {
    const base = path.basename(abs);
    if (!isVideoFile(base)) continue;
    const id = extractVideoId(base);
    if (id && !index.has(id)) index.set(id, abs); // primo trovato vince (come il .find() di prima)
  }
  return index;
}

// Trova il file video attuale di un'entry, ovunque si trovi dentro videosDir:
// prima prova il localPath registrato; se manca/non esiste, guarda nell'indice
// per id. Ritorna { abs, rel } o null.
//
// `fileIndex` e' opzionale (da buildVideoFileIndex, vedi sopra) e va sempre
// passato quando si chiama questa funzione in un ciclo su piu' video, per non
// tornare alla scansione ripetuta per ciascuno; se assente si ripiega su una
// scansione singola, comoda solo per una chiamata isolata su un solo video.
//
// Esportata (oltre che usata da reorganizeLibrary qui sotto) perche' e'
// anche il modo in cui catalogStore.reconcileOnLoad stabilisce se un video e'
// davvero scaricato: il disco fa fede, non il flag `download` nel catalogo
// (un file puo' sparire senza passare da qui, o esistere senza che il
// catalogo lo sapesse ancora — es. un'istanza appena puntata su un archivio
// video preesistente).
export function locateCurrentFile(paths, video, fileIndex = null) {
  if (video.video?.localPath) {
    const abs = path.join(paths.videosDir, video.video.localPath);
    if (existsSync(abs)) return { abs, rel: video.video.localPath };
  }

  const id = video.id;
  const match = fileIndex
    ? fileIndex.get(id) ?? null
    : buildVideoFileIndex(paths.videosDir).get(id) ?? null;
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
// (la root videosDir stessa non viene mai rimossa). Best-effort: su un mount
// che ogni tanto restituisce ENOENT transitorio (vedi buildVideoFileIndex)
// una lettura fallita qui non deve far fallire tutto reorganizeLibrary — si
// salta semplicemente quella sottocartella, riprovabile a un giro successivo.
function pruneEmptyDirs(dir, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name), root);
  }
  removeDirIfEmpty(dir, root);
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
  const fileIndex = buildVideoFileIndex(paths.videosDir);

  for (const video of Object.values(catalog.videos)) {
    if (video.download !== DOWNLOAD_STATE.DOWNLOADED) continue;
    const current = locateCurrentFile(paths, video, fileIndex);
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
