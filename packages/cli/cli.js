import { select, confirm, input, search } from '@inquirer/prompts';
import path from 'node:path';
import * as core from '../../core/src/index.js';

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
    const { jobId } = core.triggerJob('downloadSingle', { videoId: video.id });
    console.log('');
    const job = await runJobToCompletion(jobId);
    setMessage(job.status === 'failed' ? `\n✘ Download fallito: ${job.error?.message}\n` : `\n✔ "${displayTitle(video)}" scaricato.\n`);
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
    result = await core.prepareSingleVideoDownload(url);
  } catch (err) {
    setMessage(`\n✘ ${err.message}\n`);
    return;
  }

  if (result.action === 'already-downloaded') {
    setMessage(`\n"${result.title ?? result.videoId}" è già nell'archivio.\n`);
    return;
  }
  if (result.action === 'already-downloading') {
    setMessage(`\n"${result.title ?? result.videoId}" è già in download in questo momento.\n`);
    return;
  }

  const { jobId } = core.triggerJob('downloadSingle', { videoId: result.videoId });
  console.log('');
  const job = await runJobToCompletion(jobId);
  if (job.status === 'failed') {
    setMessage(`\n✘ Download fallito: ${job.error?.message}\n`);
  } else {
    setMessage(`\n✔ Video aggiunto all'archivio.\n`);
  }
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

// Estratta da watchChannelFlow per essere riusata anche da searchFlow.
async function playVideoWithModeChoice(video) {
  const mode = await select({
    message: displayTitle(video),
    choices: [
      { name: 'Video', value: 'video' },
      { name: 'Solo audio', value: 'audio' },
      { name: '← Annulla', value: BACK }
    ]
  });
  if (mode === BACK) return;

  await core.playVideo(video.id, { mode });
  setMessage('\n▶ VLC avviato.\n');
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
        ...channels.map((c) => ({ name: `${c.name} (${c.count})`, value: c.key })),
        { name: '← Torna al menu principale', value: BACK }
      ]
    });
    if (channelKey === BACK) return;

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

const ACTIONS = {
  sources: manageSourcesFlow,
  singleDownload: singleDownloadFlow,
  sync: syncFlow,
  review: reviewFlow,
  search: searchFlow,
  watch: watchFlow,
  catalog: catalogFlow,
  reorganize: reorganizeFlow
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
