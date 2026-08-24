// M86 — `Quality`: che qualità scaricare. Traduzione di `Quality` in
// `ondo-core/src/config.rs`.
//
// «Chiedi ogni volta» **non è un tetto**: è l'assenza di una decisione presa in
// anticipo. Chi scarica deve averla risolta *prima* di accodare — il tetto vero
// viaggia col singolo download (`maxHeight` del job), non con la config. Se una
// `ask` arriva fino a yt-dlp senza essere stata risolta si scarica il meglio,
// che è il default meno sorprendente.
//
// Forma su disco, in `data/config.json` → `quality`:
//   "best" · "ask" · { "height": 1080 }

// M96 — la qualità predefinita è una preferenza dell'APPLICAZIONE, non della
// libreria: due programmi sulla stessa macchina possono volerne una diversa, e
// una libreria copiata altrove non deve imporre la propria.
import { loadAppConfig, updateAppConfig } from './appConfig.js';

export const QUALITY_BEST = 'best';
export const QUALITY_ASK = 'ask';

/** `{ kind: 'best' | 'ask' | 'height', height: number|null }` */
export function parseQuality(raw) {
  if (raw === QUALITY_ASK) return { kind: QUALITY_ASK, height: null };
  if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.height))) {
    return { kind: 'height', height: Number(raw.height) };
  }
  // Qualunque altra cosa (assente, illeggibile, un vecchio valore) vale "la
  // migliore": un file di config storto non deve impedire di scaricare.
  return { kind: QUALITY_BEST, height: null };
}

/** La forma da salvare in `config.json`. */
export function serializeQuality(quality) {
  if (quality.kind === QUALITY_ASK) return QUALITY_ASK;
  if (quality.kind === 'height') return { height: quality.height };
  return QUALITY_BEST;
}

/** Il tetto da passare a yt-dlp. `null` = la migliore disponibile. */
export function maxHeightOf(quality) {
  return quality.kind === 'height' ? quality.height : null;
}

export function qualityLabel(quality) {
  if (quality.kind === QUALITY_ASK) return 'Chiedi ogni volta';
  if (quality.kind === 'height') return `${quality.height}p (o la migliore sotto)`;
  return 'Massima';
}

export function sameQuality(a, b) {
  return a.kind === b.kind && a.height === b.height;
}

export function height(h) {
  return { kind: 'height', height: h };
}

/** I livelli offerti nelle impostazioni, «Chiedi ogni volta» compreso. */
export const QUALITY_LEVELS = [
  { kind: QUALITY_BEST, height: null },
  { kind: QUALITY_ASK, height: null },
  height(2160),
  height(1440),
  height(1080),
  height(720),
  height(480),
  height(360)
];

/** Gli stessi livelli senza «Chiedi ogni volta»: qui la domanda è già stata fatta. */
export const QUALITY_PER_DOWNLOAD = QUALITY_LEVELS.filter((q) => q.kind !== QUALITY_ASK);

export function getQuality() {
  return parseQuality(loadAppConfig().quality);
}

export function setQuality(quality) {
  updateAppConfig({ quality: serializeQuality(quality) });
  return getQuality();
}
