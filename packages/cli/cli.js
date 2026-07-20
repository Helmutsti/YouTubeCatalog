import { select, confirm, input, search } from '@inquirer/prompts';
import * as core from '../../core/src/index.js';

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

async function addSourceFlow() {
  const url = await input({ message: 'URL della playlist YouTube:' });
  const result = await core.addSource(url);
  if (result.alreadyExists) {
    setMessage(`\nLa fonte "${result.name}" è già presente.\n`);
  } else if (result.newCount > 0) {
    setMessage(
      `\n✔ Aggiunta "${result.name}" — ${result.newCount} video trovati come novità.\n` +
        `  → Vai su "Rivedi novità" dal menu principale per deciderli (non serve "Sincronizza": è già stato fatto ora).\n`
    );
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
  const lines = [];
  for (const source of targets) {
    const result = await core.syncSource(source.id);
    lines.push(`${source.name}: ${result.newCount} novità, ${result.healedCount} auto-riparati.`);
  }
  setMessage('\n' + lines.join('\n') + '\n');
}

const REVIEW_STATUS_ICON = { new: '🆕', pending: '⬇️ ', excluded: '🗄️ ', failed: '⚠️ ' };
const REVIEW_STATUS_LABEL = { new: 'nuovo', pending: 'in coda', excluded: 'archiviato', failed: 'fallito' };

// Azioni valide per stato attuale: da new si decide, da pending/excluded/failed si
// può sia cambiare idea (tornare a "nuovo") sia spostarsi direttamente all'altro esito.
const REVIEW_ACTIONS_BY_STATUS = {
  new: [
    { name: 'Scarica', value: 'download' },
    { name: 'Archivia', value: 'exclude' }
  ],
  pending: [
    { name: 'Archivia', value: 'exclude' },
    { name: 'Rimetti tra le novità (annulla decisione)', value: 'undecided' }
  ],
  excluded: [
    { name: 'Scarica', value: 'download' },
    { name: 'Rimetti tra le novità (annulla decisione)', value: 'undecided' }
  ],
  failed: [
    { name: 'Riprova (rimette in coda)', value: 'download' },
    { name: 'Archivia', value: 'exclude' },
    { name: 'Rimetti tra le novità (annulla decisione)', value: 'undecided' }
  ]
};

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
// azioni valide per lo stato attuale di un video "in revisione" (new/pending/
// excluded/failed) e applica la decisione scelta.
async function applyReviewDecision(video) {
  if (video.status === 'failed' && video.error?.message) {
    console.log(`\n⚠️  Errore: ${video.error.message}\n`);
  }
  const decision = await select({
    message: `${video.title ?? video.id} (attuale: ${REVIEW_STATUS_LABEL[video.status]})`,
    choices: [...REVIEW_ACTIONS_BY_STATUS[video.status], { name: '← Torna alla lista', value: BACK }]
  });
  if (decision === BACK) return;

  await core.decideVideo(video.id, decision);
  const outcome = { download: 'in coda per il download', exclude: 'archiviato', undecided: 'rimesso tra le novità' }[decision];
  setMessage(`\n✔ "${video.title ?? video.id}" → ${outcome}.\n`);
}

async function runDownloadQueue() {
  const config = core.loadConfig();
  const maxAttempts = config.jobs.maxAttempts;
  const all = await core.listVideos();
  const queued = all.filter((v) => v.status === 'pending' || (v.status === 'failed' && v.attempts < maxAttempts));

  if (queued.length === 0) {
    setMessage('\nNessun video in coda.\n');
    return;
  }

  const proceed = await confirm({ message: `Scaricare ${queued.length} video ora?`, default: true });
  if (!proceed) return;

  const { jobId } = core.triggerJob('downloadPending', {});
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
  if (result.action === 'already-tracked') {
    setMessage(`\nQuesto video è già tracciato (stato: ${result.status}) tramite una fonte esistente — usa "Rivedi novità" per deciderlo.\n`);
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
    const maxAttempts = core.loadConfig().jobs.maxAttempts;
    const relevant = (await core.listVideos()).filter((v) => v.status in REVIEW_STATUS_ICON);
    // Stesso criterio di idoneità usato dal job downloadPending: un "failed" con
    // tentativi esauriti non parte da solo, ma resta comunque visibile/rivedibile
    // qui sopra (l'utente può comunque scegliere "Riprova" manualmente).
    const queuedCount = relevant.filter(
      (v) => v.status === 'pending' || (v.status === 'failed' && v.attempts < maxAttempts)
    ).length;

    if (relevant.length === 0) {
      setMessage('\nNessuna novità da rivedere e nessun video in coda al momento.\n');
      return;
    }

    const choice = await select({
      message: `Rivedi novità (${relevant.length})`,
      choices: [
        ...(queuedCount > 0 ? [{ name: `▶ Scarica in coda (${queuedCount})`, value: DOWNLOAD_QUEUE }] : []),
        ...relevant.map((v) => ({
          name: `${REVIEW_STATUS_ICON[v.status]} ${v.title ?? v.id} — ${v.channel?.name ?? 'canale sconosciuto'}`,
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
    message: video.title ?? video.id,
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
    const videos = await core.listVideosByChannel(channelKey, { status: 'downloaded' });
    if (videos.length === 0) return;

    const channelName = videos[0].channel?.name ?? 'Canale';
    const videoId = await select({
      message: channelName,
      choices: [
        ...videos.map((v) => ({
          name: `${v.title ?? v.id} — ${formatDuration(v.durationSeconds)} — ${v.uploadDate ?? 'data sconosciuta'}`,
          value: v.id
        })),
        { name: '← Torna ai canali', value: BACK }
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
    const channels = await core.listChannels({ status: 'downloaded' });
    if (channels.length === 0) {
      setMessage('\nNessun video scaricato ancora.\n');
      return;
    }

    const channelKey = await select({
      message: 'Guarda — scegli un canale',
      choices: [
        ...channels.map((c) => ({ name: `${c.name} (${c.count})`, value: c.key })),
        { name: '← Torna al menu principale', value: BACK }
      ]
    });
    if (channelKey === BACK) return;

    await watchChannelFlow(channelKey);
  }
}

const ALL_STATUS_ICON = { new: '🆕', pending: '⬇️ ', downloading: '⏳ ', downloaded: '✅ ', failed: '⚠️ ', excluded: '🗄️ ' };
const ALL_STATUS_LABEL_INLINE = {
  new: 'nuovo',
  pending: 'in coda',
  downloading: 'in download',
  downloaded: 'scaricato',
  failed: 'fallito',
  excluded: 'archiviato'
};

// Mostra le azioni disponibili per un video trovato dalla ricerca, a seconda
// del suo stato attuale: riusa le stesse funzioni di "Rivedi novità" (per
// new/pending/excluded/failed) e "Guarda" (per downloaded) — nessuna logica
// nuova, solo un punto d'accesso in più alle stesse azioni già testate.
async function presentSearchResultActions(videoId) {
  const video = await core.getVideo(videoId);
  if (video.status === 'downloaded') {
    await playVideoWithModeChoice(video);
  } else if (video.status in REVIEW_ACTIONS_BY_STATUS) {
    await applyReviewDecision(video);
  } else {
    setMessage(`\n"${video.title ?? video.id}" è attualmente in download: nessuna azione disponibile ora.\n`);
  }
}

async function searchFlow() {
  while (true) {
    clearScreen();
    const choice = await search({
      message: 'Cerca (titolo, canale, tag, descrizione)',
      source: async (term) => {
        if (!term) {
          return [{ name: '← Torna al menu principale (digita per cercare)', value: BACK }];
        }
        const results = await core.searchVideos(term);
        const choices = results.map((v) => ({
          name: `${ALL_STATUS_ICON[v.status] ?? ''}${v.title ?? v.id} — ${v.channel?.name ?? 'canale sconosciuto'} (${ALL_STATUS_LABEL_INLINE[v.status] ?? v.status})`,
          value: v.id
        }));
        choices.push({ name: '← Torna al menu principale', value: BACK });
        return choices;
      }
    });
    if (choice === BACK) return;

    await presentSearchResultActions(choice);
  }
}

const STATUS_LABELS = {
  __all__: 'Tutti',
  new: 'Nuovi',
  pending: 'In coda',
  downloading: 'In download',
  downloaded: 'Scaricati',
  failed: 'Falliti',
  excluded: 'Archiviati'
};

async function catalogFlow() {
  const statusKey = await select({
    message: 'Catalogo — filtra per stato',
    choices: [
      ...Object.entries(STATUS_LABELS).map(([value, name]) => ({ name, value })),
      { name: '← Torna', value: BACK }
    ]
  });
  if (statusKey === BACK) return;

  const videos = statusKey === '__all__' ? await core.listVideos() : await core.listVideos({ status: statusKey });
  if (videos.length === 0) {
    setMessage('\nNessun video in questo stato.\n');
    return;
  }
  const lines = videos.map((v) => `[${v.status}] ${v.title ?? v.id} — ${v.channel?.name ?? '?'}`);
  setMessage('\n' + lines.join('\n') + '\n');
}

const ACTIONS = {
  sources: manageSourcesFlow,
  singleDownload: singleDownloadFlow,
  sync: syncFlow,
  review: reviewFlow,
  search: searchFlow,
  watch: watchFlow,
  catalog: catalogFlow
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
