// Base URL dell'API/server media, configurabile a build-time via
// VITE_API_BASE_URL (vedi .env.example). Vuoto di default: path relativi
// esattamente come oggi (stesso host della pagina — in dev via il proxy di
// Vite su /api e /media, in un'ipotetica build servita dallo stesso host del
// server). Impostandolo si scollega il sito dal dover vivere sullo stesso
// host/porta del server @catalog/server — es. per puntare a un server altrove
// in LAN, o per una build servita da un host statico separato.
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

// I path media (/media/videos|thumbnails|avatars/...) che il server incorpora
// nelle risposte JSON (video.videoUrl, thumbnailUrl, channel.avatarUrl, le
// thumbnail dei job, ecc. — vedi publicVideo.js/publicJob.js) sono sempre
// relativi quando il file è locale. Le varianti già assolute (sourceUrl
// remoto di YouTube, fallback ytimg per copertine non ancora arricchite) NON
// vanno toccate: il controllo su "/media/" le lascia intatte di proposito.
export function resolveMediaUrls(value) {
  if (!API_BASE_URL) return value;
  if (typeof value === 'string') {
    return value.startsWith('/media/') ? apiUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map(resolveMediaUrls);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = resolveMediaUrls(v);
    return out;
  }
  return value;
}
