#!/usr/bin/env node
// Costruisce un pacchetto standalone dei soli sotto-comandi `ondo-cli`
// (video/author/source/setup), senza il menu interattivo (@catalog/cli) né il
// resto del monorepo — pensato per essere impacchettato in un .tgz e allegato
// a una GitHub Release (installabile con `npm install -g <url>.tgz`).
//
// `core/` va copiato *fisicamente* come sibling di bin/ (non dentro
// node_modules/@catalog/core): PROJECT_ROOT in core/src/config.js è calcolato
// come due cartelle sopra la posizione fisica di config.js, quindi core/ deve
// stare esattamente un livello sotto la root del pacchetto, come nel repo —
// altrimenti data/media/tools finirebbero dentro node_modules/.
//
// Uso:
//   node scripts/package-ondo-cli.mjs <versione>
//   npm run package:ondo-cli -- 1.2.3

import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE_DIR = path.join(PROJECT_ROOT, 'dist', 'ondo-cli');

// Il tag della release (es. "v1.0.1") arriva con la "v" davanti: il campo
// "version" di package.json deve invece essere semver puro ("1.0.1").
const version = (process.argv[2] || '0.0.0-dev').replace(/^v/, '');

function step(msg) {
  console.log(`\n▶ ${msg}`);
}

function rewriteCoreImport(filePath, relativePath) {
  const content = readFileSync(filePath, 'utf-8');
  const updated = content.replace(/from '@catalog\/core'/g, `from '${relativePath}'`);
  if (updated === content) {
    throw new Error(`Nessun import '@catalog/core' trovato da riscrivere in ${filePath} — atteso almeno uno.`);
  }
  writeFileSync(filePath, updated, 'utf-8');
}

function main() {
  step(`Pulizia staging (${STAGE_DIR})`);
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });

  step('Copia core/');
  cpSync(path.join(PROJECT_ROOT, 'core'), path.join(STAGE_DIR, 'core'), {
    recursive: true,
    filter: (src) => !src.endsWith('cookies.txt') && !src.includes(`${path.sep}node_modules${path.sep}`)
  });

  step('Copia bin/ e src/ di ondo-cli');
  cpSync(path.join(PROJECT_ROOT, 'packages/ondo-cli/bin'), path.join(STAGE_DIR, 'bin'), { recursive: true });
  cpSync(path.join(PROJECT_ROOT, 'packages/ondo-cli/src'), path.join(STAGE_DIR, 'src'), { recursive: true });

  step("Riscrittura import '@catalog/core' → path relativi");
  rewriteCoreImport(path.join(STAGE_DIR, 'bin/ondo.js'), '../core/src/index.js');
  for (const name of ['video.js', 'author.js', 'source.js', 'setup.js']) {
    rewriteCoreImport(path.join(STAGE_DIR, `src/commands/${name}`), '../../core/src/index.js');
  }

  step('Scrittura package.json');
  const pkg = {
    name: '@catalog/ondo-cli',
    version,
    private: true,
    type: 'module',
    bin: { ondo: './bin/ondo.js' },
    dependencies: { commander: '^12.1.0' }
  };
  writeFileSync(path.join(STAGE_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

  step('Scrittura README.md');
  const readme = `# Ondo CLI

Sotto-comandi da terminale per il catalogo video Ondo: \`video\`, \`author\`, \`source\`.
Non include il menu interattivo a frecce.

Serve **Node.js 20 o superiore**.

## Installazione — un solo comando

\`\`\`bash
npm install -g https://github.com/Helmutsti/YouTubeCatalog/releases/download/<tag>/ondo-cli-<tag>.tgz
ondo setup   # scarica yt-dlp + ffmpeg + ffprobe in tools/ (per il tuo sistema)
\`\`\`

(sostituisci \`<tag>\` con la versione della release che vuoi, es. \`v1.0.0\`)

Per disinstallarlo:

\`\`\`bash
npm uninstall -g @catalog/ondo-cli
\`\`\`

## Installazione — dal sorgente estratto

Se hai scaricato ed estratto questo pacchetto invece di installarlo con l'URL:

\`\`\`bash
npm install      # dipendenze (solo commander)
npm link         # rende disponibile il comando "ondo" nel terminale
ondo setup       # scarica yt-dlp + ffmpeg + ffprobe in tools/
\`\`\`

## Uso

\`\`\`bash
ondo --help
ondo video --help
ondo author --help
ondo source --help
ondo setup --help
\`\`\`
`;
  writeFileSync(path.join(STAGE_DIR, 'README.md'), readme, 'utf-8');

  step('npm install --omit=dev (dentro lo staging)');
  // Su Windows i binari npm sono .cmd: spawnSync li richiede via shell (altrimenti
  // EINVAL). Nessun input utente qui dentro — comando fisso, nessun rischio di
  // injection nel passarlo come stringa singola a shell:true.
  const res = spawnSync('npm install --omit=dev', { cwd: STAGE_DIR, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    throw new Error('npm install nello staging è fallito.');
  }

  console.log(`\n✔ Pacchetto pronto in ${STAGE_DIR}`);
}

main();
