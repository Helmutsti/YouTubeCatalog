#!/usr/bin/env node
// M64 — `npm run setup`: procura yt-dlp, ffmpeg e ffprobe in tools/.
//
// Perché uno script che SCARICA invece di binari committati nel repo (decisione
// presa con l'utente): (a) i binari peserebbero ~100-190MB per ogni aggiornamento
// nella history di git, che non li deltifica; (b) soprattutto, un yt-dlp pinnato
// smette di funzionare quando YouTube cambia (settimane/mesi) e l'utente si
// ritrova download falliti senza capire perché. Rilanciare questo script aggiorna.
//
// La logica vera vive in core/src/services/toolsSetupService.js (M91): riusata
// anche dal sotto-comando `ondo setup` del pacchetto standalone, dove questo
// script npm non esiste (installazione globale, nessun package.json locale).
//
// Uso:
//   npm run setup              installa ciò che manca
//   npm run setup -- --force   riscarica tutto, anche se già presente

import { setupTools } from '../core/src/index.js';

const FORCE = process.argv.includes('--force');

setupTools({ force: FORCE })
  .then(({ ok }) => {
    if (!ok) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(`\n✘ Setup fallito: ${err.message}`);
    console.error('\n  Se il problema è di rete, riprova più tardi, o scarica i file a mano in tools/:');
    console.error('    • yt-dlp  →  https://github.com/yt-dlp/yt-dlp/releases/latest');
    console.error('    • ffmpeg  →  build statica (https://ffmpeg.org/download.html)\n');
    process.exitCode = 1;
  });
