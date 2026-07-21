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

export const listVideos = (status) => request(`/api/videos${qs({ status })}`);
export const getVideo = (id) => request(`/api/videos/${encodeURIComponent(id)}`);
export const decideVideo = (id, decision) =>
  request(`/api/videos/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
export const downloadSingle = (url) =>
  request('/api/videos/download-single', { method: 'POST', body: JSON.stringify({ url }) });

export const searchVideos = (q, limit) => request(`/api/search${qs({ q, limit })}`);

export const listChannels = (status) => request(`/api/channels${qs({ status })}`);
export const listVideosByChannel = (key, status) =>
  request(`/api/channels/${encodeURIComponent(key)}/videos${qs({ status })}`);

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
