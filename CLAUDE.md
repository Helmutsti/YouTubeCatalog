# CLAUDE.md

Questo file descrive il **modo operativo** di questo progetto: non solo cosa costruire, ma *come* lavorarci. Vale per qualunque sessione, non solo quella in cui è stato scritto — le decisioni di processo qui sotto sono ricorrenti, non legate a una conversazione specifica.

## Documenti di riferimento

- **`PIANO.md`** — la specifica tecnica di riferimento: contesto, decisioni architetturali, tabella delle milestone (storiche e pianificate), e i "Punti aperti da definire e schedulare" per le idee non ancora abbastanza mature per essere una milestone numerata. Leggilo prima di lavorare su qualunque milestone. Non è un changelog: resta la fotografia della progettazione, aggiornata solo quando un requisito cambia sostanzialmente.
- **`documentazione.md`** — il log narrativo delle decisioni: una sezione per ogni milestone completata, che racconta **cosa è stato costruito e perché** (non un elenco di commit). Ci vivono anche le scoperte impreviste: bug reali trovati in verifica, limiti di API/tool esterni, vicoli ciechi esplorati e scartati.

Chi entra nel progetto legge `PIANO.md` per capire "cosa fa e come è strutturato", `documentazione.md` per capire "perché è fatto così".

## Ciclo di vita di una richiesta/feature

Questo è il pattern da seguire per ogni funzionalità non banale (non per le micro-iterazioni di stile, vedi sotto):

1. **Raccolta**: un'idea arriva com'è, spesso poco definita. Se non è ancora abbastanza matura per essere costruita, finisce nei "Punti aperti" di `PIANO.md`, non implementata a metà.
2. **Analisi di fattibilità reale, non presunta**: leggi il codice esistente invece di assumere come funziona. Quando serve, fai uno **spike empirico** prima di progettare (es. interrogare `yt-dlp` direttamente su un caso reale per scoprire la shape vera di un JSON, invece di indovinare i nomi dei campi; controllare i dati reali dell'utente prima di proporre uno schema, invece di assumerne la forma).
3. **Domande di scope mirate**, solo sui punti di reale ambiguità, ciascuna con un'opzione consigliata e il perché — non un questionario generico. Una richiesta vaga ("rinominare X in Y") può nascondere un ambito molto più ampio (solo testo visibile? anche schema/API/endpoint?): va chiarito *prima* di toccare codice.
4. **Scrivi la milestone in `PIANO.md`** — spesso *prima* di implementare, così il piano riflette la decisione anche se l'implementazione arriva dopo.
5. **Implementa.**
6. **Verifica reale end-to-end**, non solo lettura del codice: build di produzione, avvio del server, interazione vera nel browser, lettura diretta di stato/valori quando uno screenshot o un log non bastano a confermare (es. leggere un valore via JavaScript nella pagina invece di fidarsi solo dell'etichetta mostrata).
7. **Pulisci** qualunque dato di test creato per la verifica — nessun residuo nei dati reali dell'utente (conteggi prima/dopo quando è rilevante).
8. **Aggiorna `documentazione.md`** con la sezione della milestone (decisioni + logica costruttiva + eventuali scoperte/bug trovati in verifica).
9. **Aggiorna la tabella milestone in `PIANO.md`** (spunta ✅) e **rimuovi** il punto dal backlog se ormai risolto (vedi sotto).
10. **Commit descrittivo** (il *perché*, non solo il *cosa*) — **push solo su richiesta esplicita dell'utente**, mai per default.

Per le **micro-iterazioni di stile** (dimensioni, colori, piccoli aggiustamenti puntuali): un bump diretto è corretto, non serve passare dal ciclo completo "milestone → piano → documentazione". La cerimonia va riservata a cambi di comportamento/scope, non a rifiniture.

## Gestione del backlog ("Punti aperti")

Tienilo magro: quando un punto viene promosso a milestone o risolto, **rimuovilo** dalla lista (non limitarti a barrarlo) — mantiene l'elenco leggibile nel tempo.

## Bug segnalati in modo vago

Quando un problema è descritto genericamente (es. "il pulsante sparisce"), prima **prova a riprodurlo da solo** nel browser/ambiente reale. Se non è riproducibile, **chiedi di precisare** invece di applicare correzioni alla cieca sperando di aver indovinato il caso — una richiesta di chiarimento mirata isola il caso esatto molto più in fretta di un tentativo a caso.

## Concorrenza sui dati (`data/catalog.json`)

Il catalogo è tenuto in memoria da ogni processo che lo carica (server, CLI, script) e **non viene mai ricaricato da disco** finché il processo resta vivo. Regola: ogni volta che uno script esterno modifica il catalogo (o il codice `core` viene cambiato) mentre un server/CLI è già in esecuzione, **quel processo va riavviato** — altrimenti la sua cache in memoria, riscritta per intero ad ogni mutazione, rischia di sovrascrivere silenziosamente le modifiche fatte nel frattempo altrove, oppure di continuare a girare con codice ormai superato.

## Limiti noti dell'automazione browser (non bug di prodotto)

Da tenere a mente per non scambiarli per difetti reali del sito: l'hover sintetico non sempre si riflette in uno screenshot immediatamente successivo (fare uno zoom o un'altra azione subito dopo aiuta); una tab non "visibile" a livello di sistema operativo durante l'automazione può bloccare il precaricamento nativo dei media (`preload`) indipendentemente dal codice — verificabile chiamando `.play()` via JavaScript per confermare che la logica sottostante funziona comunque.

## Se si affrontano feature che mutano file reali su disco

Per le più rischiose, valuta un mini-dataset "sandbox" isolato invece di operare sempre sui dati reali dell'utente, quando la natura della milestone lo permette. Se operi sui dati reali, verifica sempre con un conteggio/hash prima e dopo, e pulisci ogni residuo di test.

## Man mano che il progetto cresce

- Se la verifica manuale ad ogni modifica inizia a non scalare, valuta test automatici (es. Vitest per i componenti web, unit test per servizi `core` puri come `reorganizeLibrary`) — non sostituiscono la verifica end-to-end reale ma riducono il rischio di regressioni silenziose su feature già verificate.
- Se la tabella milestone in `PIANO.md` diventa molto lunga, valuta un indice riassuntivo in cima (per area: core/CLI/server/web/branding) invece di scorrere linearmente M0→Mn.
- Se si arriva alla portabilità fuori da Windows (vedi backlog), prevedi una verifica reale di avvio su un secondo sistema operativo, non solo una revisione manuale del codice per riferimenti Windows-specifici.
