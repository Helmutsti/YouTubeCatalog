#!/usr/bin/env node
// M64 — `npm run setup`: procura yt-dlp, ffmpeg e ffprobe in tools/.
//
// Perché uno script che SCARICA invece di binari committati nel repo (decisione
// presa con l'utente): (a) i binari peserebbero ~100-190MB per ogni aggiornamento
// nella history di git, che non li deltifica; (b) soprattutto, un yt-dlp pinnato
// smette di funzionare quando YouTube cambia (settimane/mesi) e l'utente si
// ritrova download falliti senza capire perché. Rilanciare questo script aggiorna.
//
// Nessuna dipendenza npm: solo moduli node: nativi + readZip, il lettore ZIP già
// scritto a mano nel progetto per i backup (core/src/lib/zip.js).
//
// Uso:
//   npm run setup              installa ciò che manca
//   npm run setup -- --force   riscarica tutto, anche se già presente

import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readZip } from '../core/src/lib/zip.js';
import { expectedToolNames } from '../core/src/config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = path.join(PROJECT_ROOT, 'tools');
const FORCE = process.argv.includes('--force');

const { platform, arch } = process;
const NAMES = expectedToolNames(platform);

// ── Sorgenti dei binari (URL verificati raggiungibili) ──────────────────────
// yt-dlp: release ufficiali. Su Linux ARM l'asset ha un nome diverso ma va
// salvato come `yt-dlp_linux`, che è ciò che il codice cerca a runtime.
const YTDLP_ASSET = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}[platform];

// ffmpeg: build STATICHE (non si portano dietro DLL sparse).
// BtbN per Windows/Linux; evermeet per macOS (BtbN non pubblica build macOS).
const FFMPEG_SOURCE = (() => {
  const btbn = (name) => `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${name}`;
  if (platform === 'win32') return { kind: 'zip', url: btbn('ffmpeg-master-latest-win64-gpl.zip') };
  if (platform === 'linux') {
    return {
      kind: 'tar.xz',
      url: btbn(arch === 'arm64' ? 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz' : 'ffmpeg-master-latest-linux64-gpl.tar.xz')
    };
  }
  if (platform === 'darwin') {
    return {
      kind: 'zip-pair',
      urls: {
        [NAMES.ffmpeg]: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
        [NAMES.ffprobe]: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip'
      }
    };
  }
  return null;
})();

// ── Utilità ─────────────────────────────────────────────────────────────────
const log = (msg) => console.log(msg);
const step = (msg) => console.log(`\n▶ ${msg}`);

function human(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// Scarica in memoria mostrando l'avanzamento. I file più grandi sono ~90MB
// (ffmpeg): tenerli in RAM è accettabile per un'operazione una tantum, ed evita
// di dover gestire file temporanei parziali.
async function download(url, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);

  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  let lastShown = 0;

  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
    // Aggiorna al massimo ogni 5%: su un terminale non-TTY (log rediretto,
    // Docker build) un \r per chunk produrrebbe migliaia di righe.
    const pct = total ? Math.floor((received / total) * 100) : 0;
    if (total && pct >= lastShown + 5) {
      lastShown = pct;
      process.stdout.write(process.stdout.isTTY ? `\r  ${label}: ${pct}% (${human(received)})   ` : `  ${label}: ${pct}%\n`);
    }
  }
  if (process.stdout.isTTY) process.stdout.write(`\r  ${label}: scaricato (${human(received)})            \n`);
  else log(`  ${label}: scaricato (${human(received)})`);

  return Buffer.concat(chunks);
}

// Scrittura atomica (tmp + rename), stesso pattern di catalogStore: se lo script
// viene interrotto a metà, in tools/ non resta mai un binario troncato — che
// fallirebbe in modo molto più confuso di un binario assente.
function writeBinary(name, data) {
  mkdirSync(TOOLS_DIR, { recursive: true });
  const dest = path.join(TOOLS_DIR, name);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, data);
  if (platform !== 'win32') chmodSync(tmp, 0o755); // i binari scaricati non hanno il bit di esecuzione
  renameSync(tmp, dest);
  log(`  ✔ tools/${name} (${human(data.length)})`);
}

function alreadyThere(name) {
  const p = path.join(TOOLS_DIR, name);
  return existsSync(p) && statSync(p).size > 0;
}

// ── yt-dlp ──────────────────────────────────────────────────────────────────
async function setupYtdlp() {
  step(`yt-dlp → tools/${NAMES.ytdlp}`);

  if (!YTDLP_ASSET) {
    log(`  ✘ Piattaforma non riconosciuta (${platform}/${arch}): scarica yt-dlp a mano in tools/${NAMES.ytdlp}`);
    return false;
  }
  if (alreadyThere(NAMES.ytdlp) && !FORCE) {
    log(`  già presente — riesegui con  npm run setup -- --force  per aggiornarlo`);
    return true;
  }

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;
  const data = await download(url, YTDLP_ASSET);
  writeBinary(NAMES.ytdlp, data);
  return true;
}

// ── ffmpeg + ffprobe ────────────────────────────────────────────────────────
// Estrae dall'archivio i due soli binari che servono, ignorando il resto
// (documentazione, librerie, altri eseguibili): in tools/ finiscono 2 file.
function extractFromZip(buffer) {
  const wanted = new Map();
  for (const entry of readZip(buffer)) {
    const base = path.posix.basename(entry.name.replace(/\\/g, '/'));
    if (base === NAMES.ffmpeg || base === NAMES.ffprobe) wanted.set(base, entry.data);
  }
  return wanted;
}

function extractFromTarXz(buffer) {
  // Node non sa scompattare .xz (zlib copre solo gzip/deflate). Su Linux/macOS
  // `tar` è sempre presente e gestisce xz: lo usiamo invece di aggiungere una
  // dipendenza npm solo per questo. Estrazione in una cartella temporanea.
  const tmpDir = path.join(os.tmpdir(), `ondo-ffmpeg-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const archive = path.join(tmpDir, 'ffmpeg.tar.xz');
  try {
    writeFileSync(archive, buffer);
    const res = spawnSync('tar', ['-xf', archive, '-C', tmpDir], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error("estrazione con `tar` fallita (tar è installato?)");

    // BtbN impacchetta dentro <nome-build>/bin/{ffmpeg,ffprobe}: si cercano per
    // nome invece di assumere il percorso, che cambia a ogni release.
    const found = new Map();
    const walk = (dir) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name === NAMES.ffmpeg || name.name === NAMES.ffprobe) found.set(name.name, readFileSync(full));
      }
    };
    walk(tmpDir);
    return found;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function setupFfmpeg() {
  step(`ffmpeg + ffprobe → tools/`);

  const have = alreadyThere(NAMES.ffmpeg) && alreadyThere(NAMES.ffprobe);
  if (have && !FORCE) {
    log('  già presenti in tools/ — riesegui con --force per aggiornarli');
    return true;
  }

  // Se ffmpeg è già nel PATH di sistema, non serve scaricare nulla: getPaths()
  // ricade sul PATH quando tools/ non contiene ffmpeg. Evita ~90MB inutili.
  if (!FORCE && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
    log('  ffmpeg già presente nel PATH di sistema — niente da scaricare.');
    log('  (per averlo comunque dentro il progetto: npm run setup -- --force)');
    return true;
  }

  if (!FFMPEG_SOURCE) {
    log(`  ✘ Nessuna build automatica per ${platform}/${arch}. Installa ffmpeg a mano e mettilo nel PATH.`);
    return false;
  }

  let files;
  if (FFMPEG_SOURCE.kind === 'zip') {
    files = extractFromZip(await download(FFMPEG_SOURCE.url, 'ffmpeg (zip)'));
  } else if (FFMPEG_SOURCE.kind === 'tar.xz') {
    files = extractFromTarXz(await download(FFMPEG_SOURCE.url, 'ffmpeg (tar.xz)'));
  } else {
    // macOS: due archivi separati, uno per binario.
    files = new Map();
    for (const [name, url] of Object.entries(FFMPEG_SOURCE.urls)) {
      for (const [k, v] of extractFromZip(await download(url, name))) files.set(k, v);
    }
  }

  for (const name of [NAMES.ffmpeg, NAMES.ffprobe]) {
    if (!files.has(name)) {
      log(`  ✘ ${name} non trovato dentro l'archivio scaricato — struttura cambiata?`);
      return false;
    }
    writeBinary(name, files.get(name));
  }
  return true;
}

// ── Esito ───────────────────────────────────────────────────────────────────
function verify() {
  step('Verifica');
  const ytdlp = path.join(TOOLS_DIR, NAMES.ytdlp);
  let ok = true;

  if (existsSync(ytdlp)) {
    const res = spawnSync(ytdlp, ['--version'], { encoding: 'utf-8' });
    if (res.status === 0) log(`  ✔ yt-dlp ${res.stdout.trim()}`);
    else { log('  ✘ yt-dlp non eseguibile'); ok = false; }
  } else { log('  ✘ yt-dlp assente'); ok = false; }

  const ffmpegLocal = path.join(TOOLS_DIR, NAMES.ffmpeg);
  const ffmpegCmd = existsSync(ffmpegLocal) ? ffmpegLocal : 'ffmpeg';
  const res = spawnSync(ffmpegCmd, ['-version'], { encoding: 'utf-8' });
  if (res.status === 0) {
    log(`  ✔ ${res.stdout.split('\n')[0].trim()}`);
    log(`      (da ${existsSync(ffmpegLocal) ? 'tools/' : 'PATH di sistema'})`);
  } else { log('  ✘ ffmpeg non utilizzabile'); ok = false; }

  return ok;
}

async function main() {
  log('Ondo — preparazione degli strumenti esterni');
  log(`Sistema: ${platform}/${arch} · destinazione: tools/`);

  await setupYtdlp();
  await setupFfmpeg();

  if (verify()) {
    log('\n✔ Tutto pronto. Avvia con:  npm run serve   (poi apri http://localhost:3001)\n');
  } else {
    log('\n✘ Qualcosa manca ancora — vedi i messaggi qui sopra.\n');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n✘ Setup fallito: ${err.message}`);
  console.error('\n  Se il problema è di rete, puoi scaricare i file a mano e metterli in tools/:');
  console.error(`    • ${NAMES.ytdlp}  →  https://github.com/yt-dlp/yt-dlp/releases/latest`);
  console.error(`    • ${NAMES.ffmpeg} + ${NAMES.ffprobe}  →  build statica (https://ffmpeg.org/download.html)\n`);
  process.exitCode = 1;
});
