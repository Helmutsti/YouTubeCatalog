// Le mini API di @catalog/core lanciano semplici Error con un messaggio
// leggibile per qualunque problema (id non trovato, stato incompatibile,
// input non valido, ecc.) — lo stesso pattern che il CLI stampa e da cui
// torna al menu precedente. Qui equivale a rispondere 400 col messaggio: per
// uno strumento personale single-user non serve una tassonomia di codici
// HTTP più fine.
export function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}
