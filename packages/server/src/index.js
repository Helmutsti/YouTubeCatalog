import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppConfig, setAppId, reportToolsOnStartup, setLockRole, isLibrary, initLibrary, libraryRoot } from '@catalog/core';
import { videosRouter } from './routes/videos.routes.js';
import { sourcesRouter } from './routes/sources.routes.js';
import { jobsRouter } from './routes/jobs.routes.js';
import { libraryRouter } from './routes/library.routes.js';
import { backupRouter } from './routes/backup.routes.js';
import { configRouter } from './routes/config.routes.js';
import { mountMediaRoutes } from './media/mediaRoutes.js';

// M96 — dichiara QUALE applicazione siamo: decide il file di impostazioni
// (`web.json`, distinto dall'`ondo.json` della CLI). Prima di qualunque lettura
// della configurazione, quindi prima di tutto il resto.
setAppId('web');

// M98 — la libreria: qui NON vale la regola «quella in cui ti trovi», perché la
// cartella di lavoro del container è /app e non è una libreria. Arriva da
// ONDO_LIBRARY, impostata dall'immagine, e la si inizializza se il volume è
// vuoto: un deploy non è una sessione interattiva, e `docker compose up -d`
// deve bastare come promette la guida. La CLI invece si ferma e chiede
// `ondo init`, perché lì una cartella sbagliata è un errore di battitura, non
// un volume nuovo.
const library = libraryRoot();
if (!isLibrary(library)) {
  const { created } = initLibrary(library);
  console.log(`Libreria inizializzata in ${library} (${created.length} elementi creati).`);
}

const app = express();
app.use(express.json());

// Strumento locale single-user: server e client (CLI/web) girano sulla
// stessa macchina, senza autenticazione. Il CORS aperto serve solo a
// permettere al dev server di Vite (porta diversa) di chiamare questa API.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use('/api', videosRouter);
app.use('/api', sourcesRouter);
app.use('/api', jobsRouter);
app.use('/api', libraryRouter);
app.use('/api', backupRouter);
app.use('/api', configRouter);
mountMediaRoutes(app);

// Web GUI compilata (M63): quando la build di Vite è presente
// (packages/web/dist), la si serve dallo STESSO host/porta dell'API — è così
// che il container Docker espone un unico servizio usabile dal browser. La web
// usa già path relativi per /api e /media (apiBase vuoto di default), quindi
// same-origin funziona senza configurazione. Guardia existsSync: se la build
// non c'è (sviluppo con Vite), niente cambia — il dev continua a usare il proxy
// di Vite. Non-breaking.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // Fallback SPA: qualunque GET che non sia /api o /media (già gestiti sopra)
  // restituisce index.html, così le rotte lato client di react-router
  // (/videos/:id, /search, ecc.) funzionano anche su refresh/accesso diretto.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// --local (script "server:local"): lega l'ascolto a 127.0.0.1 invece che a
// tutte le interfacce — l'API non risulta raggiungibile da altri dispositivi
// in LAN. Pensato per l'uso "gui+proxy api": la web GUI resta raggiungibile in
// rete (npm run web:lan) e continua a parlare con l'API tramite il proxy di
// Vite, che gira sulla stessa macchina e quindi raggiunge comunque
// 127.0.0.1 — nessun dispositivo remoto tocca mai l'API direttamente.
// Senza il flag (default, invariato): ascolto su tutte le interfacce, per
// l'uso "api+gui" con la web GUI configurata a parlare direttamente con
// l'API via VITE_API_BASE_URL (vedi README).
const local = process.argv.includes('--local');
const host = local ? '127.0.0.1' : undefined;

// Prerequisiti esterni (M64): avvisa subito se yt-dlp/ffmpeg mancano, invece di
// far scoprire il problema come `spawn ENOENT` a metà del primo download. Non
// blocca l'avvio: sfogliare il catalogo e riprodurre i video già scaricati
// funziona comunque.
reportToolsOnStartup();

// Lock consultivo su data/ (M92): si attiva da solo a ogni scrittura vera e
// propria (dentro il core), non all'avvio — il server può restare aperto
// insieme a quante CLI si vuole finché tutte leggono soltanto. Qui si imposta
// solo il ruolo mostrato nel messaggio a chi trova il lock occupato.
setLockRole('server');

const config = loadAppConfig();
app.listen(config.port, host, () => {
  const shownHost = local ? '127.0.0.1' : 'localhost';
  console.log(`@catalog/server in ascolto su http://${shownHost}:${config.port}${local ? ' (solo locale, non esposto in LAN)' : ''}`);
});
