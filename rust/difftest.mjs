// Banco differenziale JS ↔ Rust (docs/rust-core.md §7).
//
// Esegue le stesse operazioni sullo stesso `data/catalog.json` con l'implementazione
// JavaScript (core/src) e con quella Rust (ondo-core), e **diffa** i due JSON.
// È l'attrezzo che rende sicura la migrazione: distingue un bug di porting da un
// cambio voluto, cosa che nessun test unitario può fare.
//
// Uso:
//   node rust/difftest.mjs                 usa il data/catalog.json esistente
//   node rust/difftest.mjs --fixture       genera un catalogo di prova, verifica, ripulisce
//
// La modalità --fixture crea un catalogo con i casi che hanno storia nel progetto:
// emoji e accenti nei titoli (il rischio Unicode di §8), titoli lunghissimi, nomi
// riservati di Windows, video legacy col vecchio `status`/`source` da migrare.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'data', 'catalog.json');
const FIXTURE_MODE = process.argv.includes('--fixture');

// Le stesse query, nello stesso ordine, del lato Rust (examples/dump.rs).
const QUERIES = [
  'asmr',
  'asmr sleep',
  'sampuma',
  'bel gramar',
  'zzzz nessuna corrispondenza',
  'créatôr',
  '🎧',
  'study with me'
];

// ── Fixture ─────────────────────────────────────────────────────────────────

function makeVideo(over) {
  return {
    id: over.id,
    title: over.title ?? null,
    description: over.description ?? '',
    webpageUrl: `https://www.youtube.com/watch?v=${over.id}`,
    originalUrl: null,
    extractor: 'youtube',
    channel: { id: over.channelId ?? null, name: over.channelName ?? null, url: null, uploaderId: null, uploaderUrl: null, subscriberCountAtDownload: null },
    uploadDate: null, releaseTimestamp: null, durationSeconds: over.duration ?? 600,
    categories: [], tags: over.tags ?? [], language: null, ageLimit: null,
    availability: null, license: null, isLive: false, wasLive: false,
    statsAtDownload: { viewCount: null, likeCount: null, commentCount: null, averageRating: null },
    resolution: { width: null, height: null, fps: null, dynamicRange: null },
    thumbnails: [], thumbnail: { sourceUrl: null, localPath: null },
    chapters: [], subtitleLanguagesAvailable: [],
    video: { localPath: over.localPath ?? null, formatId: null, container: over.container ?? null, videoCodec: null, audioCodec: null, bitrateKbps: null, sizeBytes: null, sha256: null, downloadedAt: null, ytdlpVersion: null },
    presence: over.presence ?? 'present',
    removedAt: null, missCount: 0,
    download: over.download ?? 'none',
    hidden: over.hidden ?? false,
    favorite: over.favorite ?? false,
    enrichedAt: null,
    sources: over.sources ?? [],
    addedAt: over.addedAt, updatedAt: over.addedAt, attempts: 0, error: null
  };
}

function buildFixture() {
  const videos = [
    makeVideo({ id: 'aaaaaaaaaaa', title: '[ASMR] Relaxing tapping sounds', channelName: 'Sampurna ASMR', channelId: 'UC_sampurna', download: 'downloaded', container: 'mp4', localPath: 'Sampurna ASMR/[ASMR] Relaxing tapping sounds [aaaaaaaaaaa].mp4', tags: ['asmr', 'tapping'], addedAt: '2026-01-01T00:00:00.000Z' }),
    makeVideo({ id: 'bbbbbbbbbbb', title: 'Miss Bell Teaches A Grammar Lesson', channelName: 'Miss Bell', channelId: 'UC_bell', download: 'downloaded', container: 'mkv', addedAt: '2026-02-01T00:00:00.000Z', favorite: true }),
    // Emoji + accenti: il rischio Unicode di §8, sia nel titolo sia nel canale.
    makeVideo({ id: 'ccccccccccc', title: '🎧 Créatôr sleep ambience 💤', channelName: 'Créatôr 🎧 ASMR', channelId: 'UC_creator', download: 'downloaded', container: 'mp4', addedAt: '2026-03-01T00:00:00.000Z' }),
    // Caratteri invalidi per Windows nel titolo e nel nome canale.
    makeVideo({ id: 'ddddddddddd', title: 'ASMR | Study: with me? *finally*', channelName: 'A/B\\C Studio', download: 'none', addedAt: '2026-04-01T00:00:00.000Z' }),
    // Nome riservato di Windows come nome canale.
    makeVideo({ id: 'eeeeeeeeeee', title: 'CON', channelName: 'CON', download: 'downloaded', container: 'mp4', addedAt: '2026-05-01T00:00:00.000Z' }),
    // Titolo lunghissimo → troncamento a 150.
    makeVideo({ id: 'fffffffffff', title: 'x'.repeat(400), channelName: 'Lungo', download: 'downloaded', container: 'mp4', addedAt: '2026-06-01T00:00:00.000Z' }),
    // Titolo assente → display title dal nome file, e fallback su id.
    makeVideo({ id: 'ggggggggggg', title: null, channelName: 'Senza titolo', download: 'downloaded', container: 'mp4', localPath: 'Senza titolo/Dedotto dal file [ggggggggggg].mp4', addedAt: '2026-07-01T00:00:00.000Z' }),
    // Assi ortogonali che coesistono: rimosso E scaricato; nascosto E scaricato.
    makeVideo({ id: 'hhhhhhhhhhh', title: 'Rimosso ma scaricato', channelName: 'Sampurna ASMR', channelId: 'UC_sampurna', presence: 'removed', download: 'downloaded', container: 'mp4', addedAt: '2026-07-02T00:00:00.000Z' }),
    makeVideo({ id: 'iiiiiiiiiii', title: 'Nascosto ma scaricato', channelName: 'Miss Bell', channelId: 'UC_bell', hidden: true, download: 'downloaded', container: 'mp4', addedAt: '2026-07-03T00:00:00.000Z' }),
    makeVideo({ id: 'jjjjjjjjjjj', title: 'Fallito', channelName: 'Miss Bell', channelId: 'UC_bell', download: 'failed', addedAt: '2026-07-04T00:00:00.000Z' }),
    // Canale senza id: la chiave deve ricadere sul nome.
    makeVideo({ id: 'kkkkkkkkkkk', title: 'Senza channel id', channelName: 'Solo Nome', download: 'downloaded', container: 'mp4', addedAt: '2026-07-05T00:00:00.000Z' }),
    // Descrizione lunga: deve matchare solo per sottostringa esatta, non fuzzy.
    makeVideo({ id: 'lllllllllll', title: 'Niente', channelName: 'Niente', description: 'una descrizione lunga con parole dentro study with me e altro testo di riempimento', download: 'none', addedAt: '2026-07-06T00:00:00.000Z' })
  ];

  const map = {};
  for (const v of videos) map[v.id] = v;

  // Due entry nel formato LEGACY, per verificare che le migrazioni (M25 status →
  // flag ortogonali, M41 source → sources) producano lo stesso risultato nelle
  // due implementazioni.
  map['legacy00001'] = {
    id: 'legacy00001', title: 'Legacy excluded', description: '',
    webpageUrl: 'https://www.youtube.com/watch?v=legacy00001', extractor: 'youtube',
    channel: { id: 'UC_legacy', name: 'Legacy Channel' },
    durationSeconds: 100, tags: [],
    video: { localPath: null, container: null },
    status: 'excluded', decidedAt: '2026-01-01T00:00:00.000Z',
    source: { sourceId: 'PL_old', type: 'playlist' },
    addedAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z', attempts: 0, error: null
  };
  map['legacy00002'] = {
    id: 'legacy00002', title: 'Legacy downloaded', description: '',
    webpageUrl: 'https://www.youtube.com/watch?v=legacy00002', extractor: 'youtube',
    channel: { id: 'UC_legacy', name: 'Legacy Channel' },
    durationSeconds: 100, tags: [],
    video: { localPath: 'Legacy Channel/Legacy downloaded [legacy00002].mp4', container: 'mp4' },
    status: 'downloaded',
    source: { sourceId: 'PL_old', type: 'playlist' },
    addedAt: '2025-12-02T00:00:00.000Z', updatedAt: '2025-12-02T00:00:00.000Z', attempts: 1, error: null
  };

  return {
    version: 1,
    videos: map,
    sources: { PL_old: { type: 'playlist', id: 'PL_old', name: 'Vecchia playlist', url: '', lastCheckedAt: null } },
    meta: { lastUpdated: '2026-07-01T00:00:00.000Z' }
  };
}

// ── Lato JavaScript ─────────────────────────────────────────────────────────

async function dumpJs() {
  const core = await import(new URL('../core/src/index.js', import.meta.url).href);
  const { targetRelPath, sanitizeName } = await import(
    new URL('../core/src/services/libraryService.js', import.meta.url).href
  );
  const { videoCategory } = core;

  const all = await core.listVideos({});
  const videos = all.map((v) => ({
    id: v.id,
    category: videoCategory(v),
    presence: v.presence,
    download: v.download,
    hidden: !!v.hidden,
    favorite: !!v.favorite,
    displayTitle: displayTitle(v),
    targetRelPath: targetRelPath(v)
  }));

  const ids = (list) => list.map((v) => v.id);
  const filtered = {
    downloaded: ids(await core.listVideos({ download: 'downloaded' })),
    hidden: ids(await core.listVideos({ hidden: true })),
    favorite: ids(await core.listVideos({ favorite: true }))
  };

  const chan = (list) => list.map((c) => ({ key: c.key, name: c.name, count: c.count }));
  const channels = chan(await core.listChannels({}));
  const channelsDownloaded = chan(await core.listChannels({ download: 'downloaded' }));

  const search = {};
  for (const q of QUERIES) {
    search[q] = (await core.searchVideos(q, { limit: 50 })).map((v) => v.id);
  }

  const sanitizeCases = [
    'normale', 'a<b>c:d"e/f\\g|h?i*j', '  molti   spazi  ', 'punti...',
    'spazio e punto . ', 'CON', 'com1', 'CONSOLE', 'Créatôr 🎧 ASMR', '', '///',
    'ASMR | Relaxing'
  ];
  const sanitize = sanitizeCases.map((c) => ({ in: c, out: sanitizeName(c, 'Sconosciuto') }));

  return { videos, filtered, channels, channelsDownloaded, search, sanitize };
}

// Replica di `displayTitle()` del CLI JS: vive in packages/cli/cli.js e non è
// esportato, quindi va ricostruito qui per poterlo confrontare.
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

// ── Lato Rust ───────────────────────────────────────────────────────────────

function dumpRust() {
  const cargo = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin', 'cargo');
  const out = execFileSync(cargo, ['run', '-q', '-p', 'ondo-core', '--example', 'dump'], {
    cwd: path.join(ROOT, 'rust'),
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ONDO_ROOT: ROOT }
  });
  return JSON.parse(out);
}

// ── Diff ────────────────────────────────────────────────────────────────────

function diff(a, b, trail = '') {
  const problems = [];
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    problems.push(`${trail}: tipi diversi (js=${typeName(a)} rust=${typeName(b)})`);
    return problems;
  }
  if (a === null || typeof a !== 'object') {
    if (a !== b) problems.push(`${trail}: js=${JSON.stringify(a)}  rust=${JSON.stringify(b)}`);
    return problems;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      problems.push(`${trail}: lunghezze diverse (js=${a.length} rust=${b.length})`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      problems.push(...diff(a[i], b[i], `${trail}[${i}]`));
    }
    return problems;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) { problems.push(`${trail}.${k}: assente in js`); continue; }
    if (!(k in b)) { problems.push(`${trail}.${k}: assente in rust`); continue; }
    problems.push(...diff(a[k], b[k], `${trail}.${k}`));
  }
  return problems;
}

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// ── Main ────────────────────────────────────────────────────────────────────

let backup = null;
try {
  if (FIXTURE_MODE) {
    if (existsSync(CATALOG)) {
      backup = `${CATALOG}.difftest-backup`;
      renameSync(CATALOG, backup);
      console.log(`catalogo esistente messo da parte in ${path.basename(backup)}`);
    }
    writeFileSync(CATALOG, JSON.stringify(buildFixture(), null, 2), 'utf-8');
    console.log('fixture scritta in data/catalog.json');
  } else if (!existsSync(CATALOG)) {
    console.error('data/catalog.json non esiste. Usa --fixture per generarne uno di prova.');
    process.exit(2);
  }

  // JS per primo: applica le migrazioni una tantum e riscrive il file. Rust deve
  // poi trovare un catalogo già migrato e non cambiare più nulla — che è di per sé
  // una verifica di idempotenza incrociata.
  console.log('\n→ esecuzione lato JavaScript…');
  const js = await dumpJs();
  const afterJs = readFileSync(CATALOG, 'utf-8');

  console.log('→ esecuzione lato Rust…');
  const rust = dumpRust();
  const afterRust = readFileSync(CATALOG, 'utf-8');

  const problems = diff(js, rust, '');

  console.log('\n' + '─'.repeat(70));
  if (problems.length === 0) {
    const n = js.videos.length;
    console.log(`✔ NESSUNA DIFFERENZA — ${n} video, ${js.channels.length} canali, ${QUERIES.length} query`);
  } else {
    console.log(`✘ ${problems.length} DIFFERENZE:\n`);
    for (const p of problems.slice(0, 60)) console.log('  ' + p);
    if (problems.length > 60) console.log(`  … e altre ${problems.length - 60}`);
  }

  if (afterJs !== afterRust) {
    console.log('\n✘ Il file catalog.json è stato MODIFICATO da Rust dopo il passaggio JS');
    console.log('  (violazione della Regola 2: il formato su disco non deve cambiare)');
    process.exitCode = 1;
  } else {
    console.log('✔ catalog.json byte-identico dopo entrambi i passaggi');
  }
  console.log('─'.repeat(70) + '\n');

  if (problems.length) process.exitCode = 1;
} finally {
  if (FIXTURE_MODE) {
    rmSync(CATALOG, { force: true });
    if (backup) {
      renameSync(backup, CATALOG);
      console.log('catalogo originale ripristinato');
    } else {
      console.log('fixture rimossa (data/catalog.json era assente)');
    }
  }
}
