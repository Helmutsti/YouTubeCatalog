// Client sottile su packages/server: una funzione per endpoint, stessa forma
// dei nomi in @catalog/core così la corrispondenza resta ovvia. Nessuna
// logica applicativa qui — solo fetch + propagazione dell'errore.

async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Richiesta fallita (${res.status})`);
  }
  return body;
}

function qs(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

export const listVideos = () => request('/api/videos');
export const getVideo = (id) => request(`/api/videos/${encodeURIComponent(id)}`);
// Nasconde/mostra un video (asse `hidden` del modello a flag, M25).
export const setHidden = (id, hidden) =>
  request(`/api/videos/${encodeURIComponent(id)}/hidden`, { method: 'POST', body: JSON.stringify({ hidden }) });
// Cancella solo il file scaricato (M30); la scheda resta in libreria.
export const deleteVideoFile = (id) =>
  request(`/api/videos/${encodeURIComponent(id)}/file`, { method: 'DELETE' });
// Aggiorna metadati + copertina (M31); sui rimossi funge da ri-verifica.
export const refreshMetadata = (id) =>
  request(`/api/videos/${encodeURIComponent(id)}/metadata/refresh`, { method: 'POST' });
// download:false → aggiunge solo il video alla libreria senza scaricarlo
// (checkbox "Download immediato" non spuntato, M29). Default: scarica subito.
export const downloadSingle = (url, download = true) =>
  request('/api/videos/download-single', { method: 'POST', body: JSON.stringify({ url, download }) });

export const searchVideos = (q, limit) => request(`/api/search${qs({ q, limit })}`);

export const listChannels = () => request('/api/channels');
export const listVideosByChannel = (key) =>
  request(`/api/channels/${encodeURIComponent(key)}/videos`);

export const listSources = () => request('/api/sources');
export const addSource = (url) => request('/api/sources', { method: 'POST', body: JSON.stringify({ url }) });
export const removeSource = (id) => request(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const syncSources = (sourceId) =>
  request('/api/sync', { method: 'POST', body: JSON.stringify(sourceId ? { sourceId } : {}) });

export const triggerJob = (type, params) =>
  request('/api/jobs', { method: 'POST', body: JSON.stringify({ type, params }) });
export const listJobs = () => request('/api/jobs');
export const getJob = (id) => request(`/api/jobs/${encodeURIComponent(id)}`);
export const deleteJob = (id) => request(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const clearJobs = () => request('/api/jobs', { method: 'DELETE' });

export const reorganizeLibrary = (dryRun) =>
  request('/api/library/reorganize', { method: 'POST', body: JSON.stringify({ dryRun }) });

export const syncChannelAvatars = (force) =>
  request('/api/channels/avatars/sync', { method: 'POST', body: JSON.stringify(force ? { force } : {}) });

// Backup: il download avviene via link diretto (<a href={BACKUP_URL}>), così il
// browser scarica il .zip con il nome dato dall'header Content-Disposition.
export const BACKUP_URL = '/api/backup';
// Ripristino: invia il file .zip grezzo (Content-Type application/zip). Il
// server salva una copia di sicurezza e sostituisce i file; richiede riavvio.
export const restoreBackup = (file) =>
  request('/api/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file
  });

// Impostazioni (M37): posizione della cartella media.
export const getConfig = () => request('/api/config');
export const setMediaRoot = (path) =>
  request('/api/config/media-root', { method: 'POST', body: JSON.stringify({ path }) });
