import express from 'express';
import { loadConfig } from '@catalog/core';
import { videosRouter } from './routes/videos.routes.js';
import { sourcesRouter } from './routes/sources.routes.js';
import { jobsRouter } from './routes/jobs.routes.js';
import { libraryRouter } from './routes/library.routes.js';
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
mountMediaRoutes(app);

const config = loadConfig();
app.listen(config.port, () => {
  console.log(`@catalog/server in ascolto su http://localhost:${config.port}`);
});
