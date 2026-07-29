export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Il plurale italiano non si ottiene aggiungendo una lettera in fondo (era il
// bug: "ora"+"e"="orae", "giorno"+"i"="giornoi") — cambia la vocale finale,
// quindi serve la forma plurale per intero, non un suffisso.
const RELATIVE_UNITS = [
  { limit: 60, divisor: 1, singular: 'secondo', plural: 'secondi' },
  { limit: 3600, divisor: 60, singular: 'minuto', plural: 'minuti' },
  { limit: 86400, divisor: 3600, singular: 'ora', plural: 'ore' },
  { limit: 604800, divisor: 86400, singular: 'giorno', plural: 'giorni' },
  { limit: 2629800, divisor: 604800, singular: 'settimana', plural: 'settimane' },
  { limit: 31557600, divisor: 2629800, singular: 'mese', plural: 'mesi' }
];

// video.uploadDate/addedAt sono sempre nel passato per definizione (video già
// pubblicati/già visti dal catalogo): niente ramo "tra X" per il futuro.
export function formatRelativeDate(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const diffSeconds = Math.max(0, (Date.now() - date.getTime()) / 1000);

  if (diffSeconds < 60) return 'proprio ora';
  for (const { limit, divisor, singular, plural } of RELATIVE_UNITS) {
    if (diffSeconds < limit) {
      const value = Math.floor(diffSeconds / divisor);
      return `${value} ${value === 1 ? singular : plural} fa`;
    }
  }
  const years = Math.floor(diffSeconds / 31557600);
  return `${years} ${years === 1 ? 'anno' : 'anni'} fa`;
}

// uploadDate è "YYYYMMDD" (formato yt-dlp) o già ISO; addedAt è sempre ISO.
function toIso(value) {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

export function videoDisplayDate(video) {
  return formatRelativeDate(toIso(video.uploadDate) ?? video.addedAt);
}

export function channelKey(video) {
  return video.channel?.id ?? video.channel?.name ?? null;
}

export function channelInitial(video) {
  return (video.channel?.name ?? '?').charAt(0).toUpperCase();
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatBitrate(kbps) {
  if (kbps === null || kbps === undefined) return null;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} Kbps`;
}
