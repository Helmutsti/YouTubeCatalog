// M91 — procura yt-dlp/ffmpeg/ffprobe in tools/. Era scripts/setup.mjs (M64),
// spostato qui perché serve da due punti di ingresso: lo script di sviluppo
// (npm run setup, dentro il monorepo) e il sotto-comando `ondo setup` del
// pacchetto standalone — un'installazione globale (npm install -g <tarball>)
// non ha un package.json locale da cui lanciare "npm run setup", ma un
// sotto-comando della CLI funziona comunque.
//
// Nessuna dipendenza npm: solo moduli node: nativi + readZip, il lettore ZIP
// già scritto a mano nel progetto per i backup (./lib/zip.js).

import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { readZip } from '../lib/zip.js';
import { expectedToolNames, getToolPaths } from '../config.js';

function human(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// Scarica in memoria mostrando l'avanzamento. I file più grandi sono ~90MB
// (ffmpeg): tenerli in RAM è accettabile per un'operazione una tantum, ed evita
// di dover gestire file temporanei parziali.
async function download(url, label, log) {
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

/**
 * Scarica yt-dlp, ffmpeg e ffprobe in tools/ (per il sistema corrente), se
 * mancanti. Riusata da scripts/setup.mjs e dal sotto-comando `ondo setup`.
 * @param {{force?: boolean}} [options]
 * @returns {Promise<{ok: boolean}>}
 */
export async function setupTools({ force = false } = {}) {
  const TOOLS_DIR = getToolPaths().toolsDir;
  const { platform, arch } = process;
  const NAMES = expectedToolNames(platform);

  const log = (msg) => console.log(msg);
  const step = (msg) => console.log(`\n▶ ${msg}`);

  // ── Sorgenti dei binari (URL verificati raggiungibili) ────────────────────
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

  // Scrittura atomica (tmp + rename), stesso pattern di catalogStore: se lo
  // script viene interrotto a metà, in tools/ non resta mai un binario
  // troncato — che fallirebbe in modo molto più confuso di un binario assente.
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

  // ── yt-dlp ────────────────────────────────────────────────────────────────
  async function setupYtdlp() {
    step(`yt-dlp → tools/${NAMES.ytdlp}`);

    if (!YTDLP_ASSET) {
      log(`  ✘ Piattaforma non riconosciuta (${platform}/${arch}): scarica yt-dlp a mano in tools/${NAMES.ytdlp}`);
      return false;
    }
    if (alreadyThere(NAMES.ytdlp) && !force) {
      log(`  già presente — riesegui con --force per aggiornarlo`);
      return true;
    }

    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;
    const data = await download(url, YTDLP_ASSET, log);
    writeBinary(NAMES.ytdlp, data);
    return true;
  }

  // ── ffmpeg + ffprobe ──────────────────────────────────────────────────────
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
    // Node non sa scompattare .xz (zlib copre solo gzip/deflate). Su
    // Linux/macOS `tar` è sempre presente e gestisce xz: lo usiamo invece di
    // aggiungere una dipendenza npm solo per questo. Estrazione in una
    // cartella temporanea.
    const tmpDir = path.join(os.tmpdir(), `ondo-ffmpeg-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    const archive = path.join(tmpDir, 'ffmpeg.tar.xz');
    try {
      writeFileSync(archive, buffer);
      const res = spawnSync('tar', ['-xf', archive, '-C', tmpDir], { stdio: 'inherit' });
      if (res.status !== 0) throw new Error("estrazione con `tar` fallita (tar è installato?)");

      // BtbN impacchetta dentro <nome-build>/bin/{ffmpeg,ffprobe}: si cercano
      // per nome invece di assumere il percorso, che cambia a ogni release.
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
    if (have && !force) {
      log('  già presenti in tools/ — riesegui con --force per aggiornarli');
      return true;
    }

    // Se ffmpeg è già nel PATH di sistema, non serve scaricare nulla:
    // getPaths() ricade sul PATH quando tools/ non contiene ffmpeg. Evita
    // ~90MB inutili.
    if (!force && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
      log('  ffmpeg già presente nel PATH di sistema — niente da scaricare.');
      log('  (per averlo comunque dentro il progetto: --force)');
      return true;
    }

    if (!FFMPEG_SOURCE) {
      log(`  ✘ Nessuna build automatica per ${platform}/${arch}. Installa ffmpeg a mano e mettilo nel PATH.`);
      return false;
    }

    let files;
    if (FFMPEG_SOURCE.kind === 'zip') {
      files = extractFromZip(await download(FFMPEG_SOURCE.url, 'ffmpeg (zip)', log));
    } else if (FFMPEG_SOURCE.kind === 'tar.xz') {
      files = extractFromTarXz(await download(FFMPEG_SOURCE.url, 'ffmpeg (tar.xz)', log));
    } else {
      // macOS: due archivi separati, uno per binario.
      files = new Map();
      for (const [name, url] of Object.entries(FFMPEG_SOURCE.urls)) {
        for (const [k, v] of extractFromZip(await download(url, name, log))) files.set(k, v);
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

  // ── Esito ─────────────────────────────────────────────────────────────────
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

  log('Ondo — preparazione degli strumenti esterni');
  log(`Sistema: ${platform}/${arch} · destinazione: tools/`);

  await setupYtdlp();
  await setupFfmpeg();

  const ok = verify();
  if (ok) {
    log('\n✔ Tutto pronto.\n');
  } else {
    log('\n✘ Qualcosa manca ancora — vedi i messaggi qui sopra.\n');
  }
  return { ok };
}
