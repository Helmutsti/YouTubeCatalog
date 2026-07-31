import express, { Router } from 'express';
import { createBackup, restoreBackup } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const backupRouter = Router();

// Download del backup come .zip (catalogo + metadati + storico job +
// impostazioni + copertine/avatar; niente video né cookie — M61).
backupRouter.get(
  '/backup',
  asyncRoute(async (req, res) => {
    const zip = createBackup();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="ondo-backup-${stamp}.zip"`);
    res.send(zip);
  })
);

// Ripristino: il corpo della richiesta è lo zip grezzo. Middleware `raw` a
// livello di route (l'app monta solo express.json() globale, che ignora questo
// content-type). Limite ampio perché da M61 lo zip include anche le immagini
// (copertine/avatar), quindi può crescere ben oltre i soli JSON.
backupRouter.post(
  '/backup/restore',
  express.raw({ type: () => true, limit: '1gb' }),
  asyncRoute(async (req, res) => {
    if (!req.body || !req.body.length) throw new Error('Nessun file ricevuto.');
    res.json(restoreBackup(req.body));
  })
);
