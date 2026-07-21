import { JobHistory } from '../components/JobHistory.jsx';

// "Cronologia" (M29): solo lo storico dei job di download. L'aggiunta di un
// video singolo è stata spostata in testa alla Libreria (con il checkbox
// "Download immediato"), quindi qui non c'è più il form: resta la sola
// cronologia, coerente col nome della voce di menu.
export function HistoryPage() {
  return (
    <>
      <div className="page-head"><h1>Cronologia</h1></div>
      <p className="hint" style={{ marginBottom: 16 }}>
        Storico dei download. Per aggiungere un video usa il campo in cima alla <a href="/library">Libreria</a>.
      </p>
      <JobHistory />
    </>
  );
}
