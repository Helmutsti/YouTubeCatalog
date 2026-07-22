import express from 'express';
import { loadConfig } from '@catalog/core';
import { videosRouter } from './routes/videos.routes.js';
import { sourcesRouter } from './routes/sources.routes.js';
import { jobsRouter } from './routes/jobs.routes.js';
import { libraryRouter } from './routes/library.routes.js';
import { backupRouter } from './routes/backup.routes.js';
import { configRouter } from './routes/config.routes.js';
import { mountMediaRoutes } from './media/mediaRoutes.js';

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

const config = loadConfig();
app.listen(config.port, host, () => {
  const shownHost = local ? '127.0.0.1' : 'localhost';
  console.log(`@catalog/server in ascolto su http://${shownHost}:${config.port}${local ? ' (solo locale, non esposto in LAN)' : ''}`);
});
