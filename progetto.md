# progetto.md — regole operative e contesto (Ondo · catalogo YouTube locale)

> Generato dallo schema `claude_master`: contiene i comportamenti fondamentali, il
> profilo di workflow scelto, le regole generali e le specifiche di questo
> progetto. `CLAUDE.md` delega qui. Per rivedere il profilo: scrivi "rivedi il profilo".

---

## Comportamenti fondamentali (attivi di default; modificabili solo su richiesta esplicita, previa conferma)

Invarianti di default (fuori dalle scelte del profilo), ma modificabili su richiesta esplicita dell'utente previa conferma — l'utente resta l'autorità.

1. **Non tenere memoria esterna.** L'unica fonte di verità sono i file versionati del progetto (`CLAUDE.md`/`progetto.md`, `PIANO.md`, `documentazione.md`); niente store di memoria persistente separato.
   *Esempio:* una decisione architetturale va scritta in `documentazione.md`, non "ricordata" in una memoria esterna che un altro computer non vedrebbe.
2. **Non scrivere fuori dalla cartella del progetto senza autorizzazione.** Tutti i file restano dentro la cartella del progetto; niente scritture su Desktop/home/sistema salvo richiesta esplicita.
   *Esempio:* un file temporaneo va nello scratchpad di sessione o in una sottocartella, non sul Desktop — a meno che l'utente non lo chieda.
3. **Progetto sempre auto-portante.** Deve girare qui e proseguire su altre macchine: nessun percorso assoluto macchina-specifico cablato, `config.example` versionata, binari risolti per sistema operativo.
   *Esempio:* i binari yt-dlp/ffmpeg si scelgono da `process.platform` (M50), non con `C:\Users\...` cablato; `data/config.example.json` è versionato.
4. **Proponi miglioramenti di workflow che noti in autonomia.** Se osservi un flusso utile o una regola ricorrente non ancora scritta, proponila: se specifica del progetto, offri di aggiungerla qui in `progetto.md`; se generale, va nel master (fuori dal progetto → chiedi il path di `claude_master.md` o dai il blocco pronto da incollare, senza modificarlo di tua iniziativa).

---

## Profilo di workflow attivo

- **Livello di cerimonia**: `Completo` (milestone + `documentazione.md` per ogni feature non banale).
- **Verifica end-to-end reale**: `ON` (build + avvio + browser/HMR quando possibile; se il browser dell'automazione non raggiunge `localhost`, la verifica visiva la fa l'utente via HMR e lo si dichiara).
- **Commit automatico**: `OFF` (commit solo su richiesta esplicita).
- **Push automatico**: `OFF` (push solo su richiesta esplicita).
- **Scrivi i test**: `OFF`.
- **Agenti paralleli**: `ON` (implementazioni delegate ad agenti in parallelo con coordinamento anti-conflitto).

---

## Regole di processo

### A1 — Ciclo di vita di una feature (10 passi)
Per ogni funzionalità non banale: (1) raccolta, (2) analisi di fattibilità reale, (3) domande di scope mirate, (4) milestone nella spec, (5) implementazione, (6) verifica end-to-end reale, (7) pulizia dati di test, (8) aggiornamento log decisioni, (9) spunta milestone + pulizia backlog, (10) commit descrittivo. *(Passi 6/8/9/10 e test modulati dal profilo.)*
*Esempio:* "aggiungi i preferiti" → scope e milestone prima, poi codice, poi verifica nel browser, poi il perché nel log, poi commit.

### A2 — Micro-iterazioni di stile
Cambi estetici puntuali (colore, dimensione, allineamento) si applicano direttamente, senza milestone né voce di log.
*Esempio:* "allinea a destra quei bottoni" → una riga CSS e basta.

### A3 — Backlog a tre elenchi, tenuto magro
Le idee non ancora milestone vivono nei "Punti aperti" divisi in **tre elenchi**: **"Da realizzare/definire"** (mature), **"Forse"** (incerte), **"Scartati"** (bocciate ma conservate **con la motivazione** e le scoperte utili). Un punto promosso a milestone o risolto si **rimuove** (non si barra). Parallelo per i difetti: "Bug noti da correggere" / "Bug risolti".
*Esempio:* "sottotitoli" analizzati e non voluti → in "Scartati" con i risultati della ricerca; "card orizzontale" matura → milestone, rimossa dai Punti aperti.

### A4 — Comandi rapidi di annotazione (prefissi)
Un messaggio che **inizia** con `bug:`/`miglioramento:`/`punto:`/`forse:` è **sola annotazione**: registra la voce nell'elenco giusto e conferma cosa/dove, nessun codice. Senza prefisso valgono le regole normali.
*Esempio:* "miglioramento: pulsante video successivo" → aggiungo un punto al backlog e rispondo "annotato in `PIANO.md` → Da realizzare/definire", senza implementare.

### A5 — Bug segnalati in modo vago
Prima si prova a **riprodurre** nell'ambiente reale; se non riproducibile, si **chiede di precisare** invece di correggere alla cieca.
*Esempio:* "il menu sparisce" → provo ad aprirlo in vari punti; se non si riproduce, chiedo "quale pagina/posizione/larghezza finestra?".

### A6 — Due documenti di riferimento
Spec (`PIANO.md`) + log delle decisioni (`documentazione.md`); la spec si legge **prima** di lavorare su una milestone.
*Esempio:* prima di M53 rileggo la sua riga in `PIANO.md`; a fine lavoro il "perché" dell'approccio va in `documentazione.md`.

### A7 — Feature che mutano file reali su disco
Per operazioni rischiose, mini-dataset sandbox isolato; se si opera sui dati veri, **conteggio/hash prima-dopo** e **pulizia** dei residui.
*Esempio:* script che rinomina file video → "358 prima / 358 dopo" e rimozione dei file di prova.

### A8 — Man mano che il progetto cresce
Quando verifica manuale o elenchi non scalano: **test automatici** (per la logica pura) e **indice** in cima alla spec.
*Esempio:* superate molte milestone, indice per area (core/CLI/server/web) in cima a `PIANO.md`.

---

## Abitudini di lavoro

### B1 — Fattibilità reale, non presunta
Prima di progettare si **legge il codice vero** e, se serve, si fa uno **spike empirico** su tool/dati reali.
*Esempio:* per la copertina di un canale, interrogo yt-dlp su un video reale per la shape effettiva del JSON invece di indovinare i campi.

### B2 — Domande di scope mirate
Si chiede solo sui punti ambigui, una alla volta, con **opzione consigliata + perché**.
*Esempio:* "rinominare X in Y" → "solo il testo o anche schema/API/endpoint?" prima di toccare codice.

### B3 — Verifica end-to-end reale
Una feature è "fatta" solo dopo averla vista funzionare (build + avvio + browser); quando un'etichetta non basta, si legge lo stato reale.
*Esempio:* leggere `currentSrc` via JavaScript in pagina invece di fidarsi dell'etichetta del pulsante.

### B4 — Pulizia sistematica dei dati di test
Ogni verifica su dati reali si chiude riportando tutto allo stato iniziale, confermato con conteggi/hash.
*Esempio:* dopo aver marcato un video preferito per test, lo riporto com'era e confermo via API.

### B5 — Commit descrittivo, push solo su richiesta
I commit spiegano il **perché**; push (e, se "Commit automatico" OFF, anche il commit) solo su richiesta esplicita.
*Esempio:* messaggio che motiva la scelta architetturale; nessun `git push` finché non lo chiedi.

### B6 — Coordinamento degli agenti paralleli
Mai due agenti sugli **stessi file**; i **documenti condivisi** li aggiorna solo il coordinatore; a fine lavoro **un unico commit**.
*Esempio:* un agente implementa, un altro verifica una parte diversa; il secondo non tocca la spec — riporta al coordinatore, che consolida.

---

## Contesto e regole specifiche del progetto

### Concorrenza sui dati (`data/catalog.json`)
Il catalogo è tenuto in memoria da ogni processo che lo carica (server, CLI, script) e **non viene mai ricaricato da disco** finché il processo resta vivo. Regola: se uno script esterno modifica il catalogo **oppure il codice `core` cambia** mentre un server/CLI è in esecuzione, **quel processo va riavviato** — altrimenti la sua cache in memoria rischia di sovrascrivere silenziosamente le modifiche fatte altrove, o di girare con codice superato.

### Limiti noti dell'automazione browser (non bug di prodotto)
- l'hover sintetico non sempre si riflette nello screenshot immediatamente successivo (uno zoom o un'altra azione subito dopo aiuta);
- una tab non "visibile" a livello di OS può bloccare il `preload` dei media (verificabile con `.play()` via JavaScript);
- in alcune sessioni il browser dell'automazione **non raggiunge `localhost`/`127.0.0.1`**: in quei casi la verifica visiva la fa l'utente via HMR, dichiarandolo, invece di simularla.

### Portabilità fuori da Windows
`yt-dlp`/`ffmpeg` sono scelti per `process.platform` (M50); VLC escluso dallo scope. La portabilità multi-OS richiede una **verifica reale di avvio su Linux/macOS**, non solo una revisione del codice.

---

## Documenti di riferimento del progetto

- **`PIANO.md`** — spec: contesto, decisioni architetturali, tabella milestone (M0→Mn), "Punti aperti" (Da realizzare/Forse/Scartati), "Bug noti / risolti". Da leggere prima di ogni milestone.
- **`documentazione.md`** — log narrativo: una sezione per milestone (cosa/perché + scoperte).
