import { select, confirm, input, search } from '@inquirer/prompts';
import path from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as core from '../../core/src/index.js';
import { resolveVideoPath, playFiles } from './vlcQueuePlayer.js';

// Titolo da mostrare per un video: normalmente quello originale scaricato da
// YouTube (video.title). Se manca, si ricava dal nome file già scelto da
// yt-dlp sul disco (localPath) invece di mostrare il solo id — coerente con
// "teniamo il titolo di yt-dlp come titolo di ripiego, mai una riscrittura
// forzata". Il nome file ha forma "<Titolo> [<id>].<ext>": si toglie
// l'estensione e il suffisso " [<id>]".
function displayTitle(video) {
  if (video.title) return video.title;
  const localPath = video.video?.localPath;
  if (localPath) {
    const base = path.basename(localPath, path.extname(localPath));
    const derived = base.replace(new RegExp(`\\s*\\[${video.id}\\]$`), '').trim();
    if (derived) return derived;
  }
  return video.id;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '?';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function formatDate(iso) {
  return iso ? iso.slice(0, 10) : 'mai';
}

const BACK = '__back__';

// --- Coda di riproduzione effimera (M52) -------------------------------------
// Lista in memoria per la durata del processo CLI (nessuna persistenza, niente
// playlist nominate — scelta esplicita dell'utente, vedi PIANO.md M52). Tiene
// solo {id, title}: la risoluzione del percorso file avviene al momento di
// "Guarda", così un video scaricato nel frattempo viene comunque trovato.
const queue = [];

function isQueued(id) {
  return queue.some((q) => q.id === id);
}

function enqueueVideo(video) {
  if (isQueued(video.id)) {
    setMessage(`\n"${displayTitle(video)}" è già in coda.\n`);
    return;
  }
  queue.push({ id: video.id, title: displayTitle(video) });
  setMessage(`\n✔ "${displayTitle(video)}" aggiunto alla coda (${queue.length} in coda).\n`);
}

// --- Reset schermata + messaggio in sospeso ---------------------------------
// I menu (@inquirer/prompts dentro cicli while(true)) non puliscono mai il
// terminale: senza reset, ogni vecchia versione di un elenco resta stampata
// sopra le nuove. clearScreen() pulisce (solo in un TTY) come prima istruzione
// di ogni ciclo di menu; setMessage() mette in coda un output "da leggere"
// (conferme, riepiloghi, elenchi informativi) che sopravvive esattamente a una
// pulizia — ristampato una volta dopo il clear e poi scartato. Sicuro con una
// singola variabile globale perché il CLI è bloccante: un solo flusso
// interattivo alla volta.
let pendingMessage = null;

function setMessage(text) {
  pendingMessage = text;
}

function clearScreen() {
  if (process.stdout.isTTY) console.clear();
  if (pendingMessage !== null) {
    console.log(pendingMessage);
    pendingMessage = null;
  }
}

// Fase 2 dell'ingest (M26): arricchisce i metadati completi + copertine in
// background via il job enrichSource, mostrando il log live. Riusa
// runJobToCompletion (hoisted). sourceId omesso => arricchisce tutti i pendenti.
async function enrichAfterIngest(sourceId) {
  const { jobId } = core.triggerJob('enrichSource', sourceId ? { sourceId } : {});
  console.log('\nArricchimento metadati e copertine...\n');
  const job = await runJobToCompletion(jobId);
  const s = job.summary ?? {};
  setMessage(`\n✔ Arricchimento: ${s.enriched ?? 0} completati${s.failed ? `, ${s.failed} falliti` : ''}.\n`);
}

async function addSourceFlow() {
  const url = await input({ message: 'URL della playlist YouTube:' });
  const result = await core.addSource(url);
  if (result.alreadyExists) {
    setMessage(`\nLa fonte "${result.name}" è già presente.\n`);
    return;
  }
  if (result.missingCount > 0) {
    // backlog #4: YouTube dichiara più video di quanti enumerati (alcuni non
    // visibili ora: privati/rimossi/glitch — riprova la sync più tardi).
    console.log(`⚠ Enumerati ${result.enumeratedCount} su ${result.declaredCount} dichiarati — ${result.missingCount} non visibili ora.`);
  }
  if (result.newCount > 0) {
    console.log(`\n✔ Aggiunta "${result.name}" — ${result.newCount} video trovati.`);
    await enrichAfterIngest(result.sourceId);
  } else {
    setMessage(`\n✔ Aggiunta "${result.name}" — nessun video trovato nella playlist.\n`);
  }
}

async function listSourcesFlow() {
  const sources = await core.listSources();
  if (sources.length === 0) {
    setMessage('\nNessuna fonte configurata.\n');
    return;
  }
  const lines = sources.map(
    (s) => `- ${s.name} (${s.videoCount} video) — ultima sync: ${formatDate(s.lastCheckedAt)}`
  );
  setMessage('\n' + lines.join('\n') + '\n');
}

async function removeSourceFlow() {
  const sources = await core.listSources();
  if (sources.length === 0) {
    setMessage('\nNessuna fonte da rimuovere.\n');
    return;
  }
  const choice = await select({
    message: 'Quale fonte vuoi rimuovere?',
    choices: [
      ...sources.map((s) => ({ name: `${s.name} (${s.videoCount} video)`, value: s.id })),
      { name: '← Annulla', value: BACK }
    ]
  });
  if (choice === BACK) return;

  const source = sources.find((s) => s.id === choice);
  const confirmed = await confirm({
    message: `Rimuovere "${source.name}"? I video già scaricati non verranno toccati.`,
    default: false
  });
  if (!confirmed) return;

  await core.removeSource(choice);
  setMessage(`\n✔ Fonte "${source.name}" rimossa.\n`);
}

async function manageSourcesFlow() {
  while (true) {
    clearScreen();
    const choice = await select({
      message: 'Gestisci fonti',
      choices: [
        { name: 'Aggiungi fonte', value: 'add' },
        { name: 'Elenca fonti', value: 'list' },
        { name: 'Rimuovi fonte', value: 'remove' },
        { name: '← Torna al menu principale', value: BACK }
      ]
    });
    if (choice === BACK) return;
    if (choice === 'add') await addSourceFlow();
    if (choice === 'list') await listSourcesFlow();
    if (choice === 'remove') await removeSourceFlow();
  }
}

async function syncFlow() {
  const sources = await core.listSources();
  if (sources.length === 0) {
    setMessage('\nNessuna fonte configurata. Aggiungine una da "Gestisci fonti".\n');
    return;
  }

  const choice = await select({
    message: 'Sincronizza quale fonte?',
    choices: [
      { name: 'Tutte le fonti', value: '__all__' },
      ...sources.map((s) => ({ name: s.name, value: s.id })),
      { name: '← Torna', value: BACK }
    ]
  });
  if (choice === BACK) return;

  const targets = choice === '__all__' ? sources : sources.filter((s) => s.id === choice);
  for (const source of targets) {
    const result = await core.syncSource(source.id);
    console.log(`${source.name}: ${result.newCount} novità, ${result.removedCount} rimossi, ${result.restoredCount} ricomparsi, ${result.healedCount} riparati.`);
    // backlog #4: avviso se qualche video dichiarato non è stato enumerato.
    if (result.missingCount > 0) {
      console.log(`  ⚠ enumerati ${result.enumeratedCount} su ${result.declaredCount} — ${result.missingCount} non visibili ora (riprova la sync).`);
    }
  }
  // Fase 2: arricchimento (tutti i pendenti se "tutte le fonti", altrimenti la singola).
  await enrichAfterIngest(choice === '__all__' ? null : choice);
}

// Modello a flag ortogonali (M25): la categoria a una dimensione arriva dal
// core (core.videoCategory), qui si mappano solo icona ed etichetta testuale.
const CATEGORY_ICON = { available: '🆕', downloading: '⏳ ', downloaded: '✅ ', failed: '⚠️ ', hidden: '🗄️ ', removed: '❌ ' };
const CATEGORY_LABEL = { available: 'su YouTube', downloading: 'in download', downloaded: 'scaricato', failed: 'fallito', hidden: 'nascosto', removed: 'rimosso' };

// Categorie che compaiono nella vista di revisione/gestione: tutto ciò che non è
// già scaricato o in download (quindi su cui ha senso agire: scaricare/nascondere).
const REVIEW_CATEGORIES = new Set(['available', 'failed', 'hidden', 'removed']);

// Azioni per-video derivate dai flag (equivalente CLI di lib/reviewActions.js del
// web): scaricare se non già scaricato/in corso; nascondere o mostrare.
function cliActions(video) {
  const actions = [];
  if (video.download !== 'downloaded' && video.download !== 'downloading') {
    actions.push({ name: video.download === 'failed' ? 'Riprova (scarica)' : 'Scarica', value: 'download' });
  }
  actions.push(video.hidden ? { name: 'Mostra', value: 'unhide' } : { name: 'Nascondi', value: 'hide' });
  return actions;
}

const DOWNLOAD_QUEUE = '__download_queue__';
const PLAY_QUEUE = '__play_queue__';
const CLEAR_QUEUE = '__clear_queue__';

// Stampa le righe di log di un job in tempo reale e si risolve al termine
// (successo o fallimento), ritornando il job completo. Condiviso da
// runDownloadQueue e singleDownloadFlow.
async function runJobToCompletion(jobId) {
  await new Promise((resolve) => {
    core.onJobLog(jobId, (line) => console.log(line));
    core.onJobStatus(jobId, (status) => {
      if (status === 'success' || status === 'failed') resolve();
    });
  });
  return core.getJob(jobId);
}

// M55 — Avvio "consapevole" di un download di singolo video, condiviso da tutti
// i punti del CLI che scaricano un video (link incollato + azione
// "Scarica/Riprova" su un video già in catalogo). Prima di lanciare il job usa
// l'analisi dei formati (già risolta dal core: prepareSingleVideoDownload o
// analyzeVideoDownload) per due decisioni che hanno senso solo qui, davanti
// all'utente:
//  (a) se il video è GIÀ scaricato, si chiede se eliminarlo e ri-scaricarlo
//      (unico modo per riprovare una qualità più alta) — no = non si fa nulla;
//  (b) se i flussi migliori sono separati (needsAudioChoice), si fa scegliere
//      tra risoluzione combinata (audio+video insieme) e video ad alta
//      risoluzione unito a un audio inferiore → diventa l'audioStrategy del job.
// `analysis` ha la stessa forma nei due casi d'uso, quindi qui non serve sapere
// da dove arriva. Ritorna false se l'utente annulla, true se un job è partito.
async function startAnalyzedDownload(analysis) {
  const { videoId } = analysis;
  const title = analysis.title ?? videoId;

  // (a) Già scaricato: eliminare la copia e ri-scaricare, o non fare nulla.
  if (analysis.alreadyDownloaded) {
    const redownload = await confirm({
      message: 'Il video è già scaricato. Eliminare la copia attuale e ri-scaricare?',
      default: false
    });
    if (!redownload) return false;
    // deleteVideoFile riporta il catalogo a download:'none', così il job può
    // ripartire da zero come per un video mai scaricato.
    await core.deleteVideoFile(videoId);
  }

  // (a2) M56: scelta della risoluzione. La più alta è "(massima)" → maxHeight
  // null (nessun cap, prende il meglio); le altre cappano a quell'altezza.
  let maxHeight;
  const heights = analysis.availableHeights ?? [];
  if (heights.length > 0) {
    const picked = await select({
      message: 'A quale risoluzione scaricare?',
      choices: [
        ...heights.map((h, i) => ({ name: i === 0 ? `${h}p (massima)` : `${h}p`, value: h })),
        { name: '← Annulla', value: BACK }
      ]
    });
    if (picked === BACK) return false;
    maxHeight = picked === heights[0] ? null : picked;
  }

  // (b) Scelta audio quando i flussi migliori sono separati.
  let audioStrategy;
  if (analysis.needsAudioChoice) {
    const strategy = await select({
      message: 'Come vuoi scaricare questo video?',
      choices: [
        { name: `Scarica a ${analysis.maxCombinedHeight}p (audio e video insieme)`, value: 'combined' },
        { name: `Video ${analysis.maxVideoHeight}p + audio ${analysis.maxCombinedHeight}p (video nitido, audio inferiore)`, value: 'merged' },
        { name: '← Annulla', value: BACK }
      ]
    });
    if (strategy === BACK) return false;
    audioStrategy = strategy;
  }

  const { jobId } = core.triggerJob('downloadSingle', { videoId, audioStrategy, maxHeight });
  console.log('');
  const job = await runJobToCompletion(jobId);
  if (job.status === 'failed') {
    setMessage(`\n✘ Download fallito: ${job.error?.message}\n`);
    return true;
  }

  // Avviso di qualità ridotta: il core registra qualityNote quando ha dovuto
  // ripiegare su una risoluzione più bassa di quella disponibile. L'avviso
  // sostituisce il messaggio di successo semplice (implica comunque il successo).
  const note = (await core.getVideo(videoId)).video?.qualityNote;
  if (note) {
    setMessage(`\n⚠ Qualità ridotta: scaricato a ${note.downloadedHeight}p (disponibili fino a ${note.maxAvailableHeight}p). Puoi ri-scaricare per riprovare l'alta qualità.\n`);
  } else {
    setMessage(`\n✔ "${title}" scaricato.\n`);
  }
  return true;
}

// Estratta da reviewFlow per essere riusata anche da searchFlow: mostra le
// azioni derivate dai flag del video (scarica / nascondi / mostra) e le applica.
async function applyReviewDecision(video) {
  if (video.download === 'failed' && video.error?.message) {
    console.log(`\n⚠️  Errore: ${video.error.message}\n`);
  }
  const decision = await select({
    message: `${displayTitle(video)} (attuale: ${CATEGORY_LABEL[core.videoCategory(video)]})`,
    choices: [...cliActions(video), { name: '← Torna alla lista', value: BACK }]
  });
  if (decision === BACK) return;

  if (decision === 'download') {
    // M55: si analizzano i formati attuali (per id, il video è già in catalogo)
    // e si passa tutto al flusso condiviso, che gestisce ri-download ed
    // eventuale scelta audio. displayTitle è più robusto del title grezzo.
    console.log('\nAnalisi formati in corso…');
    const analysis = await core.analyzeVideoDownload(video.id);
    await startAnalyzedDownload({ ...analysis, title: displayTitle(video) });
    return;
  }

  if (decision === 'hide') {
    // M30: nascondere un video scaricato chiede se tenere il file su disco.
    let deletedFile = false;
    if (video.download === 'downloaded') {
      const keep = await confirm({ message: 'Vuoi tenere il video? (No = cancella il file dal disco; la scheda resta in libreria)', default: true });
      if (!keep) {
        await core.deleteVideoFile(video.id);
        deletedFile = true;
      }
    }
    await core.setVideoHidden(video.id, true);
    setMessage(`\n✔ "${displayTitle(video)}" → nascosto${deletedFile ? ' (file cancellato dal disco)' : ''}.\n`);
    return;
  }

  // unhide
  await core.setVideoHidden(video.id, false);
  setMessage(`\n✔ "${displayTitle(video)}" → mostrato.\n`);
}

// Scarica in blocco tutti i video "disponibili" o "falliti" (non ancora
// scaricati): raccoglie gli id e li passa al job downloadPending, che ora opera
// su una lista esplicita invece che sul vecchio stato "pending".
async function runDownloadQueue() {
  const all = await core.listVideos();
  const queued = all.filter((v) => {
    const c = core.videoCategory(v);
    return c === 'available' || c === 'failed';
  });

  if (queued.length === 0) {
    setMessage('\nNessun video da scaricare.\n');
    return;
  }

  const proceed = await confirm({ message: `Scaricare ${queued.length} video ora?`, default: true });
  if (!proceed) return;

  const { jobId } = core.triggerJob('downloadPending', { videoIds: queued.map((v) => v.id) });
  console.log('');
  const job = await runJobToCompletion(jobId);
  if (job.status === 'failed') {
    setMessage(`\n✘ Job fallito: ${job.error?.message}\n`);
  } else {
    setMessage('\n✔ Download completato.\n');
  }
}

async function singleDownloadFlow() {
  const url = await input({ message: 'URL (o id) del video YouTube:' });

  let result;
  try {
    console.log('\nAnalisi formati in corso…');
    result = await core.prepareSingleVideoDownload(url);
  } catch (err) {
    setMessage(`\n✘ ${err.message}\n`);
    return;
  }

  // Un video già in download non si tocca (nessun abort disponibile).
  if (result.action === 'already-downloading') {
    setMessage(`\n"${result.title ?? result.videoId}" è già in download in questo momento.\n`);
    return;
  }

  // Per action 'already-downloaded' (offre ri-download) e 'download' (video
  // nuovo appena aggiunto, o già in libreria non scaricato) il risultato porta
  // già i campi di analisi (alreadyDownloaded/needsAudioChoice/altezze): lo si
  // passa direttamente al flusso condiviso, senza una seconda risoluzione.
  await startAnalyzedDownload(result);
}

// Vista unica: novità da decidere + già decise (in coda/archiviate) + il download
// stesso, nidificato qui invece che come voce separata del menu principale.
async function reviewFlow() {
  while (true) {
    clearScreen();
    const relevant = (await core.listVideos()).filter((v) => REVIEW_CATEGORIES.has(core.videoCategory(v)));
    // Video scaricabili in blocco: disponibili o falliti (non ancora scaricati).
    const queuedCount = relevant.filter((v) => {
      const c = core.videoCategory(v);
      return c === 'available' || c === 'failed';
    }).length;

    if (relevant.length === 0) {
      setMessage('\nNessun video da rivedere al momento.\n');
      return;
    }

    const choice = await select({
      message: `Rivedi novità (${relevant.length})`,
      choices: [
        ...(queuedCount > 0 ? [{ name: `▶ Scarica in blocco (${queuedCount})`, value: DOWNLOAD_QUEUE }] : []),
        ...relevant.map((v) => ({
          name: `${CATEGORY_ICON[core.videoCategory(v)]} ${displayTitle(v)} — ${v.channel?.name ?? 'creator sconosciuto'}`,
          value: v.id
        })),
        { name: '← Torna al menu principale', value: BACK }
      ]
    });
    if (choice === BACK) return;

    if (choice === DOWNLOAD_QUEUE) {
      await runDownloadQueue();
      continue;
    }

    const video = relevant.find((v) => v.id === choice);
    await applyReviewDecision(video);
  }
}

// Estratta da watchChannelFlow per essere riusata anche da searchFlow. Oltre
// alla riproduzione immediata (invariata), offre "Aggiungi alla coda" (M52):
// non lancia nulla, si limita a mettere il video nella coda in memoria, da
// riprodurre tutta insieme più tardi con "▶ Riproduci coda" in watchFlow.
async function playVideoWithModeChoice(video) {
  const mode = await select({
    message: displayTitle(video),
    choices: [
      { name: 'Video', value: 'video' },
      { name: 'Solo audio', value: 'audio' },
      { name: isQueued(video.id) ? 'Aggiungi alla coda (già in coda)' : 'Aggiungi alla coda', value: 'queue' },
      { name: '← Annulla', value: BACK }
    ]
  });
  if (mode === BACK) return;

  if (mode === 'queue') {
    enqueueVideo(video);
    return;
  }

  playFiles([resolveVideoPath(video)], { mode });
  setMessage('\n▶ VLC avviato.\n');
}

// Riproduce l'intera coda con un solo VLC (M52): VLC accoda nativamente più
// file sulla riga di comando, nessuna logica di sequenziamento da scrivere.
// Risolve i percorsi al momento (non quando erano stati accodati), così un
// video nel frattempo scaricato/spostato/cancellato viene gestito qui invece
// che al momento dell'aggiunta.
async function playQueueFlow() {
  if (queue.length === 0) {
    setMessage('\nLa coda è vuota.\n');
    return;
  }

  const resolved = [];
  const skipped = [];
  for (const item of queue) {
    try {
      const video = await core.getVideo(item.id);
      resolved.push(resolveVideoPath(video));
    } catch (err) {
      skipped.push(item.title);
    }
  }

  if (resolved.length === 0) {
    setMessage(`\n✘ Nessun video della coda è riproducibile ora (${skipped.length} scartati).\n`);
    return;
  }

  const mode = await select({
    message: `Riprodurre la coda (${resolved.length} video pronti${skipped.length ? `, ${skipped.length} scartati` : ''})`,
    choices: [
      { name: 'Video', value: 'video' },
      { name: 'Solo audio', value: 'audio' },
      { name: '← Annulla', value: BACK }
    ]
  });
  if (mode === BACK) return;

  playFiles(resolved, { mode });
  setMessage(`\n▶ VLC avviato con ${resolved.length} video in coda${skipped.length ? ` (${skipped.length} scartati: non più riproducibili)` : ''}.\n`);
}

async function watchChannelFlow(channelKey) {
  while (true) {
    clearScreen();
    const videos = await core.listVideosByChannel(channelKey, { download: 'downloaded' });
    if (videos.length === 0) return;

    const channelName = videos[0].channel?.name ?? 'Creator';
    const videoId = await select({
      message: channelName,
      choices: [
        ...videos.map((v) => ({
          name: `${displayTitle(v)} — ${formatDuration(v.durationSeconds)} — ${v.uploadDate ?? 'data sconosciuta'}`,
          value: v.id
        })),
        { name: '← Torna ai creator', value: BACK }
      ]
    });
    if (videoId === BACK) return;

    const video = videos.find((v) => v.id === videoId);
    await playVideoWithModeChoice(video);
  }
}

async function watchFlow() {
  while (true) {
    clearScreen();
    const channels = await core.listChannels({ download: 'downloaded' });
    if (channels.length === 0) {
      setMessage('\nNessun video scaricato ancora.\n');
      return;
    }

    const channelKey = await select({
      message: 'Guarda — scegli un creator',
      choices: [
        // Coda di riproduzione (M52): compare solo quando c'è qualcosa da
        // riprodurre, accodato scegliendo "Aggiungi alla coda" su un video.
        ...(queue.length > 0
          ? [
              { name: `▶ Riproduci coda (${queue.length})`, value: PLAY_QUEUE },
              { name: `Svuota coda (${queue.length})`, value: CLEAR_QUEUE }
            ]
          : []),
        ...channels.map((c) => ({ name: `${c.name} (${c.count})`, value: c.key })),
        { name: '← Torna al menu principale', value: BACK }
      ]
    });
    if (channelKey === BACK) return;

    if (channelKey === PLAY_QUEUE) {
      await playQueueFlow();
      continue;
    }
    if (channelKey === CLEAR_QUEUE) {
      queue.length = 0;
      setMessage('\n✔ Coda svuotata.\n');
      continue;
    }

    await watchChannelFlow(channelKey);
  }
}

// Mostra le azioni disponibili per un video trovato dalla ricerca, a seconda
// dei suoi flag: riusa "Guarda" (per gli scaricati) e la revisione (per gli
// altri) — nessuna logica nuova, solo un punto d'accesso in più.
async function presentSearchResultActions(videoId) {
  const video = await core.getVideo(videoId);
  if (video.download === 'downloaded') {
    await playVideoWithModeChoice(video);
  } else if (video.download === 'downloading') {
    setMessage(`\n"${displayTitle(video)}" è attualmente in download: nessuna azione disponibile ora.\n`);
  } else {
    await applyReviewDecision(video);
  }
}

async function searchFlow() {
  while (true) {
    clearScreen();
    const choice = await search({
      message: 'Cerca (titolo, creator, tag, descrizione)',
      source: async (term) => {
        if (!term) {
          return [{ name: '← Torna al menu principale (digita per cercare)', value: BACK }];
        }
        const results = await core.searchVideos(term);
        const choices = results.map((v) => {
          const c = core.videoCategory(v);
          return {
            name: `${CATEGORY_ICON[c] ?? ''}${displayTitle(v)} — ${v.channel?.name ?? 'creator sconosciuto'} (${CATEGORY_LABEL[c] ?? c})`,
            value: v.id
          };
        });
        choices.push({ name: '← Torna al menu principale', value: BACK });
        return choices;
      }
    });
    if (choice === BACK) return;

    await presentSearchResultActions(choice);
  }
}

const CATEGORY_LABELS_PLURAL = {
  __all__: 'Tutti',
  available: 'Su YouTube',
  downloading: 'In download',
  downloaded: 'Scaricati',
  failed: 'Falliti',
  hidden: 'Nascosti',
  removed: 'Rimossi'
};

async function catalogFlow() {
  const categoryKey = await select({
    message: 'Catalogo — filtra per categoria',
    choices: [
      ...Object.entries(CATEGORY_LABELS_PLURAL).map(([value, name]) => ({ name, value })),
      { name: '← Torna', value: BACK }
    ]
  });
  if (categoryKey === BACK) return;

  const all = await core.listVideos();
  const videos = categoryKey === '__all__' ? all : all.filter((v) => core.videoCategory(v) === categoryKey);
  if (videos.length === 0) {
    setMessage('\nNessun video in questa categoria.\n');
    return;
  }
  const lines = videos.map((v) => `[${core.videoCategory(v)}] ${displayTitle(v)} — ${v.channel?.name ?? '?'}`);
  setMessage('\n' + lines.join('\n') + '\n');
}

// Riorganizza l'archivio nel layout canonico per creator: prima un dry-run che
// mostra gli spostamenti previsti, poi conferma, poi l'esecuzione reale. Gli
// spostamenti previsti sono contesto immediato della conferma → console.log
// diretto; solo il riepilogo finale passa da setMessage (design clearScreen).
async function reorganizeFlow() {
  const plan = await core.reorganizeLibrary({ dryRun: true });

  if (plan.planned.length === 0) {
    const parts = ['\nLibreria già organizzata: nessun file da spostare.'];
    if (plan.alreadyOk) parts.push(`${plan.alreadyOk} già al posto giusto.`);
    if (plan.missing.length) parts.push(`${plan.missing.length} scaricati ma senza file su disco.`);
    setMessage(parts.join(' ') + '\n');
    return;
  }

  console.log('\nRiorganizzazione in media/videos/<Creator>/<Titolo> [id].<ext>:\n');
  for (const m of plan.planned.slice(0, 20)) {
    console.log(`  ${m.from}  →  ${m.to}`);
  }
  if (plan.planned.length > 20) console.log(`  … e altri ${plan.planned.length - 20}`);
  if (plan.missing.length) console.log(`\n⚠️  ${plan.missing.length} video scaricati senza file su disco (saltati).`);
  console.log('');

  const proceed = await confirm({ message: `Spostare ${plan.planned.length} file ora?`, default: true });
  if (!proceed) {
    setMessage('\nOperazione annullata.\n');
    return;
  }

  const res = await core.reorganizeLibrary();
  const extra = res.missing.length ? ` ${res.missing.length} senza file su disco (saltati).` : '';
  setMessage(`\n✔ Riorganizzati ${res.moved} file per creator.${extra}\n`);
}

// --- Backup / Ripristino (M36) ---------------------------------------------
// Salva/legge un archivio .zip con catalogo + metadati + storico job (niente
// media, niente config/cookie). Il ripristino sostituisce i file dopo una copia
// di sicurezza e richiede il riavvio del processo (stato in memoria).
async function saveBackupFlow() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dest = await input({
    message: 'Percorso del file .zip da creare:',
    default: path.resolve(process.cwd(), `ondo-backup-${stamp}.zip`)
  });
  const zip = core.createBackup();
  writeFileSync(dest, zip);
  setMessage(`\n✔ Backup salvato in ${dest} (${(zip.length / 1024).toFixed(0)} KB).\n`);
}

async function restoreBackupFlow() {
  const src = await input({ message: 'Percorso del backup .zip da ripristinare:' });
  if (!src || !existsSync(src)) {
    setMessage('\n✘ File non trovato.\n');
    return;
  }
  const confirmed = await confirm({
    message:
      'Il ripristino sostituisce catalogo, metadati e storico job attuali (viene salvata una copia di sicurezza). Continuare?',
    default: false
  });
  if (!confirmed) return;
  const result = core.restoreBackup(readFileSync(src));
  setMessage(
    `\n✔ Ripristinati: ${result.restored.join(', ')}.\n` +
      `  Copia di sicurezza: ${result.safetyDir}\n` +
      `  ⚠ Riavvia il server/CLI per applicare le modifiche.\n`
  );
}

async function backupFlow() {
  while (true) {
    clearScreen();
    const choice = await select({
      message: 'Backup / Ripristino',
      choices: [
        { name: 'Salva backup su file…', value: 'save' },
        { name: 'Ripristina da file…', value: 'restore' },
        { name: '← Torna', value: BACK }
      ]
    });
    if (choice === BACK) return;
    try {
      if (choice === 'save') await saveBackupFlow();
      else await restoreBackupFlow();
    } catch (err) {
      if (err?.name === 'ExitPromptError') throw err;
      setMessage(`\n✘ ${err.message}\n`);
    }
  }
}

// --- Impostazioni (M37) -----------------------------------------------------
// Posizione della cartella media: solo ripuntamento, nessuno spostamento di
// file (l'utente sposta la cartella e poi indica il percorso). Richiede riavvio.
async function mediaRootFlow() {
  const current = core.loadConfig().mediaRoot;
  const resolved = core.getPaths().mediaRoot;
  console.log(`\nCartella media attuale: ${current}${resolved !== current ? ` → ${resolved}` : ''}\n`);
  const newPath = await input({ message: 'Nuovo percorso della cartella media:', default: current });
  if (!newPath || newPath.trim() === current) {
    setMessage('\nNessuna modifica.\n');
    return;
  }
  const res = core.setMediaRoot(newPath);
  setMessage(
    `\n✔ Cartella media impostata su ${res.resolved}.` +
      (res.hasVideos ? '' : '\n  ⚠ Nessuna sottocartella videos/ trovata qui.') +
      '\n  ⚠ Riavvia il server/CLI per applicare.\n'
  );
}

async function videosRootFlow() {
  const current = core.loadConfig().videosRoot;
  const resolved = core.getPaths().videosDir;
  console.log(`\nCartella video attuale: ${current ?? '(default: sotto la cartella media)'} → ${resolved}\n`);
  const newPath = await input({ message: 'Nuovo percorso della cartella video:', default: current ?? '' });
  if (!newPath || newPath.trim() === (current ?? '')) {
    setMessage('\nNessuna modifica.\n');
    return;
  }
  const res = core.setVideosRoot(newPath);
  setMessage(`\n✔ Cartella video impostata su ${res.resolved}.\n  ⚠ Riavvia il server/CLI per applicare.\n`);
}

async function settingsFlow() {
  while (true) {
    clearScreen();
    const choice = await select({
      message: 'Impostazioni',
      choices: [
        { name: 'Posizione cartella video…', value: 'videos' },
        { name: 'Posizione cartella media (copertine/avatar)…', value: 'media' },
        { name: '← Torna', value: BACK }
      ]
    });
    if (choice === BACK) return;
    try {
      if (choice === 'media') await mediaRootFlow();
      else if (choice === 'videos') await videosRootFlow();
    } catch (err) {
      if (err?.name === 'ExitPromptError') throw err;
      setMessage(`\n✘ ${err.message}\n`);
    }
  }
}

const ACTIONS = {
  sources: manageSourcesFlow,
  singleDownload: singleDownloadFlow,
  sync: syncFlow,
  review: reviewFlow,
  search: searchFlow,
  watch: watchFlow,
  catalog: catalogFlow,
  reorganize: reorganizeFlow,
  backup: backupFlow,
  settings: settingsFlow
};

async function mainMenu() {
  while (true) {
    clearScreen();
    const choice = await select({
      message: 'Cosa vuoi fare?',
      choices: [
        { name: 'Gestisci fonti', value: 'sources' },
        { name: 'Scarica video singolo', value: 'singleDownload' },
        { name: 'Sincronizza', value: 'sync' },
        { name: 'Rivedi novità', value: 'review' },
        { name: 'Cerca', value: 'search' },
        { name: 'Guarda', value: 'watch' },
        { name: 'Catalogo', value: 'catalog' },
        { name: 'Riorganizza libreria (per creator)', value: 'reorganize' },
        { name: 'Backup / Ripristino', value: 'backup' },
        { name: 'Impostazioni', value: 'settings' },
        { name: 'Esci', value: 'exit' }
      ]
    });

    if (choice === 'exit') return;

    try {
      await ACTIONS[choice]();
    } catch (err) {
      if (err?.name === 'ExitPromptError') throw err;
      setMessage(`\n✘ ${err.message}\n`);
    }
  }
}

mainMenu()
  .then(() => {
    console.log('Ciao!');
    process.exit(0);
  })
  .catch((err) => {
    if (err?.name === 'ExitPromptError') {
      console.log('\nCiao!');
      process.exit(0);
    }
    console.error('Errore inatteso:', err);
    process.exit(1);
  });
