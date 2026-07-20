import { Router } from 'express';
import { reorganizeLibrary } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const libraryRouter = Router();

// dryRun di default true: come nel CLI, il piano va rivisto prima di
// spostare davvero i file su disco.
libraryRouter.post('/library/reorganize', asyncRoute(async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  res.json(await reorganizeLibrary({ dryRun }));
}));
