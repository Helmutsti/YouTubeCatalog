import { Router } from 'express';
import { triggerJob, getJob, listJobs, onJobLog, onJobProgress, onJobStatus } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';
import { toPublicJob, toPublicJobs } from '../lib/publicJob.js';

export const jobsRouter = Router();

jobsRouter.get('/jobs', asyncRoute(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(await toPublicJobs(listJobs(limit)));
}));

jobsRouter.post('/jobs', asyncRoute(async (req, res) => {
  const { type, params } = req.body ?? {};
  res.json(triggerJob(type, params));
}));

jobsRouter.get('/jobs/:id', asyncRoute(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job non trovato: "${req.params.id}"` });
    return;
  }
  res.json(await toPublicJob(job));
}));

// Bridge SSE sugli eventi in tempo reale di jobManager (log/progress/status)
// — lo stesso EventEmitter a cui il CLI si iscrive direttamente essendo nello
// stesso processo. Un client che si collega dopo l'avvio riceve prima lo
// storico accumulato (job.logLines), poi gli eventi live.
jobsRouter.get('/jobs/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job non trovato: "${req.params.id}"` });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('status', job.status);
  for (const line of job.logLines) send('log', line);

  function cleanup() {
    offLog();
    offProgress();
    offStatus();
  }

  const offLog = onJobLog(req.params.id, (line) => send('log', line));
  const offProgress = onJobProgress(req.params.id, (pct) => send('progress', pct));
  const offStatus = onJobStatus(req.params.id, (status) => {
    send('status', status);
    if (status === 'success' || status === 'failed') {
      cleanup();
      res.end();
    }
  });

  req.on('close', cleanup);

  if (job.status === 'success' || job.status === 'failed') {
    cleanup();
    res.end();
  }
});
