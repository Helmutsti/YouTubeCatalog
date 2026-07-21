// Pagina "Libreria": per ora un contenitore vuoto (placeholder). La vecchia
// funzione "Riorganizza libreria" (dry-run + spostamento dei file nel layout
// canonico per creator) è stata rimossa dall'interfaccia: dopo la migrazione
// una tantum dell'archivio (M9.2) e il criterio strutturale introdotto in M22,
// tutti i nuovi download nascono già nel layout corretto, quindi non c'era mai
// nulla "da spostare". La funzione core reorganizeLibrary() resta disponibile
// come utility (e via CLI) se un giorno servisse una nuova migrazione.
export function LibraryPage() {
  return (
    <>
      <div className="page-head"><h1>Libreria</h1></div>
      <div className="empty-state">Questa sezione sarà popolata in futuro.</div>
    </>
  );
}
