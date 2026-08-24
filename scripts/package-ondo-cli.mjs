#!/usr/bin/env node
// Costruisce il pacchetto standalone della CLI `ondo`: i sotto-comandi E il menu
// interattivo a frecce (M98: un solo programma), senza il
// resto del monorepo — pensato per essere impacchettato in un .tgz e allegato
// a una GitHub Release (installabile con `npm install -g <url>.tgz`).
//
// `core/` va copiato *fisicamente* come sibling di bin/ (non dentro
// node_modules/@catalog/core): PROJECT_ROOT in core/src/config.js è calcolato
// come due cartelle sopra la posizione fisica di config.js, quindi core/ deve
// stare esattamente un livello sotto la root del pacchetto, come nel repo —
// altrimenti config/ e tools/ finirebbero dentro node_modules/.
//
// Uso:
//   node scripts/package-ondo-cli.mjs <versione>
//   npm run ondo:package -- 1.2.3

import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
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

/**
 * Riscrive gli import di '@catalog/core' in un percorso relativo.
 * @returns {boolean} true se il file conteneva almeno un import da riscrivere.
 *
 * Non lancia più quando non trova niente: percorrendo l'albero (M98) la maggior
 * parte dei file non importa il core, e va benissimo. Il controllo "ne ho
 * trovato almeno uno in tutto" sta nel chiamante, dove ha senso.
 */
function rewriteCoreImport(filePath, relativePath) {
  const content = readFileSync(filePath, 'utf-8');
  const updated = content.replace(/from '@catalog\/core'/g, `from '${relativePath}'`);
  if (updated === content) return false;
  writeFileSync(filePath, updated, 'utf-8');
  return true;
}

/** Tutti i .js sotto `dir`, ricorsivamente. */
function* walkJs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // core/ è copiato tal quale: dentro usa già percorsi relativi suoi e non
    // contiene import di '@catalog/core' (sarebbe un import di sé stesso).
    if (entry.isDirectory()) {
      if (entry.name === 'core' && path.dirname(full) === STAGE_DIR) continue;
      yield* walkJs(full);
    } else if (entry.name.endsWith('.js')) {
      yield full;
    }
  }
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
  // M98 — si percorre l'albero staged invece di elencare i file a mano. La
  // lista fissa che stava qui (video/author/source/setup) si è stantita al primo
  // comando nuovo: `library.js`, aggiunto dopo, non c'era, e poiché bin/ondo.js
  // lo importa staticamente il pacchetto pubblicato non partiva più — nemmeno
  // `ondo --help`. Un elenco da tenere aggiornato a mano, in uno script che
  // produce l'artefatto distribuito, è un guasto in attesa di succedere.
  let rewritten = 0;
  for (const file of walkJs(STAGE_DIR)) {
    // Il percorso relativo dipende da quanto è profondo il file: da bin/ondo.js
    // il core è '../core/...', da src/commands/x.js è '../../core/...'.
    const depth = path.relative(STAGE_DIR, path.dirname(file)).split(path.sep).filter(Boolean).length;
    const relative = `${'../'.repeat(depth)}core/src/index.js`;
    if (rewriteCoreImport(file, relative)) rewritten += 1;
  }
  console.log(`  ${rewritten} file riscritti`);
  if (rewritten === 0) throw new Error("Nessun import '@catalog/core' trovato: qualcosa è cambiato nel layout.");

  step('Scrittura package.json');
  const pkg = {
    name: '@catalog/ondo-cli',
    version,
    private: true,
    type: 'module',
    bin: { ondo: './bin/ondo.js' },
    // @inquirer/prompts serve al menu a frecce (src/menu/), che da M98 è dentro
    // questo pacchetto e non più un package a sé.
    dependencies: { commander: '^12.1.0', '@inquirer/prompts': '^8.5.2' }
  };
  writeFileSync(path.join(STAGE_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

  step('Scrittura README.md');
  const readme = `# Ondo CLI

Il catalogo video Ondo da terminale: i sotto-comandi (\`video\`, \`author\`,
\`source\`, \`library\`) **e** il menu interattivo a frecce.

Serve **Node.js 20 o superiore**.

## Installazione

\`\`\`bash
npm install -g https://github.com/Helmutsti/YouTubeCatalog/releases/download/<tag>/ondo-cli-<tag>.tgz
ondo setup   # scarica yt-dlp + ffmpeg + ffprobe (per il tuo sistema)
\`\`\`

(sostituisci \`<tag>\` con la versione della release che vuoi, es. \`v1.0.0\`)

## La libreria è la cartella in cui ti trovi

\`ondo\` lavora sulla libreria della cartella corrente. Se non ce n'è una, si
ferma e te lo dice — non ne crea una per sbaglio.

\`\`\`bash
cd D:\\MiaLibreria
ondo init          # solo la prima volta: crea la libreria qui
ondo menu          # l'interfaccia a frecce su QUESTA libreria
ondo video list    # i sotto-comandi, sempre su questa libreria
\`\`\`

Le librerie possono essere quante ne vuoi: sono cartelle, ci si va con \`cd\`.
Per lavorare su un'altra senza spostarti: \`ondo --library D:\\Altra video list\`.

## Uso

\`\`\`bash
ondo               # apre il menu
ondo --help
ondo video --help
ondo author --help
ondo source --help
ondo setup --help
\`\`\`

Per disinstallarlo:

\`\`\`bash
npm uninstall -g @catalog/ondo-cli
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
