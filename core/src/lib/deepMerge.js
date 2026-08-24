// M96 — estratto da config.js: ora lo usano due file di configurazione
// distinti (quello della libreria e quello dell'applicazione), e appConfig.js
// non può importare config.js (è config.js a importare appConfig).

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fonde `overrides` dentro `defaults`, in profondità. Gli array si sostituiscono
 * interi (non si fondono elemento per elemento) e `undefined` non sovrascrive:
 * una chiave assente nelle override lascia il default.
 */
export function deepMerge(defaults, overrides) {
  if (Array.isArray(defaults) || Array.isArray(overrides)) {
    return overrides !== undefined ? overrides : defaults;
  }
  if (isPlainObject(defaults) && isPlainObject(overrides)) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    }
    return result;
  }
  return overrides !== undefined ? overrides : defaults;
}
