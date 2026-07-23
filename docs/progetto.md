# progetto.md — regole operative e contesto (Ondo · catalogo YouTube locale)

> Generato dallo schema `claude_master`: contiene i comportamenti fondamentali, il
> profilo di workflow scelto, le regole generali e le specifiche di questo
> progetto. `CLAUDE.md` delega qui. Per rivedere il profilo: scrivi "rivedi il profilo".

---

## Comportamenti fondamentali (attivi di default; modificabili solo su richiesta esplicita, previa conferma)

Invarianti di default (fuori dalle scelte del profilo), ma modificabili su richiesta esplicita dell'utente previa conferma — l'utente resta l'autorità.

1. **Non tenere memoria esterna.** L'unica fonte di verità sono i file versionati del progetto (`CLAUDE.md`/`progetto.md`, `PIANO.md`, `documentazione.md`, `storico.md`); niente store di memoria persistente separato.
   *Esempio:* una decisione architetturale va appesa nello `storico.md` (e riflessa in `documentazione.md` se cambia il presente), non "ricordata" in una memoria esterna che un altro computer non vedrebbe.
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
Per ogni funzionalità/punto: (1) raccolta, (2) analisi di fattibilità reale, (3) domande di scope mirate, (4) **milestone OBBLIGATORIA nella spec, con descrizione dettagliata dell'operatività da svolgere** (niente implementazione sostanziale senza milestone), (5) implementazione, (6) verifica end-to-end reale, (7) pulizia dati di test, (8) **chiusura milestone** (spunta + pulizia backlog), (9) **solo a milestone chiusa, aggiornamento del log decisioni**, (10) commit descrittivo. *(Il profilo modula la pipeline: al livello **Completo** il passo 4 — milestone obbligatoria dettagliata — e i passi 8/9 sono richiesti; al livello **Leggero** si implementa direttamente con doc minima. Verifica/commit/push/test seguono i flussi. Micro-iterazioni di stile sempre esenti, A2.)*
*Esempio:* "aggiungi i preferiti" → milestone dettagliata prima, poi codice, poi verifica; a milestone chiusa il perché nel log, poi commit.

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

### A6 — Quattro documenti di riferimento (ruoli distinti)
Vivono tutti nella cartella **`docs/`** (`docs/progetto.md`, `docs/PIANO.md`, `docs/documentazione.md`, `docs/storico.md`); `CLAUDE.md` resta in radice e delega con `@docs/progetto.md`.
- **`progetto.md`** (questo) = **specifiche**: regole, comportamenti, profilo, contesto/architettura, convenzioni.
- **`PIANO.md`** = **futuro**: milestone pianificate + backlog (Da fare/Forse/Scartati) + bug da correggere. Da leggere prima di ogni milestone.
- **`documentazione.md`** = **stato attuale**: riassunto vivo del presente — core del progetto, decisioni più attuali ancora valide, funzionamenti controintuitivi da ricordare, e decisioni "negative" (cose deliberatamente non implementate, col perché). **Non** un log che cresce: si aggiorna/sfoltisce per riflettere il presente.
- **`storico.md`** = **storia**: log append-only completo di tutte le implementazioni e decisioni prese (milestone completate, scoperte, bug risolti), una sezione per milestone. `documentazione.md` ne è il distillato attuale.
*Flusso:* pesco la milestone dal `PIANO.md` → lavoro → a milestone chiusa: (a) appendo l'esito in `storico.md` (sempre); (b) aggiorno `documentazione.md` **solo se** cambia il presente (nuova meccanica controintuitiva, decisione core, cosa decisa-e-non-fatta).

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

## Documenti di riferimento del progetto (quattro, in `docs/`)

Tutti in `docs/`; `CLAUDE.md` in radice delega con `@docs/progetto.md`.

- **`progetto.md`** (questo file) — **specifiche**: regole/comportamenti/profilo + contesto e architettura del progetto.
- **`PIANO.md`** — **futuro**: milestone pianificate + "Punti aperti" (Da realizzare/Forse/Scartati) + "Bug noti da correggere". Da leggere prima di ogni milestone.
- **`documentazione.md`** — **stato attuale**: riassunto vivo del presente (core, decisioni correnti, funzionamenti controintuitivi, scelte negative). Si sfoltisce, non cresce.
- **`storico.md`** — **storia**: log append-only completo (una sezione per milestone completata: cosa/perché + scoperte, + bug risolti). È il dettaglio integrale di cui `documentazione.md` è il distillato.


---

# Contesto e architettura tecnica (spostato da PIANO.md)

## Contesto

L'utente vuole preservare i video dei suoi creator preferiti su YouTube, alcuni dei quali sono stati cancellati o resi privati/non listati in passato e sono andati perduti. L'obiettivo è costruire un tool personale, locale (single-user, Windows), che:

1. Scarica i video localmente per non perderli in futuro.
2. Li cataloga in un file JSON (`data/catalog.json`), che è il "core" del sistema.
3. Offre delle **mini API riusabili da qualsiasi interfaccia** (prima una CLI, poi una WebGUI) per leggere il catalogo, sincronizzare la playlist, decidere cosa scaricare e riprodurre i video.
4. In questa fase: un **CLI a menu selezionabili (`cli.js`)** — navigazione con frecce, non comandi digitati — che permette di gestire una **sourcelist di playlist**, vedere le "novità" trovate, decidere per ciascuna se scaricarla o archiviarla, lanciare i download, e riprodurre un video già scaricato con **VLC** (in modalità video o solo audio).
5. In una fase successiva: una **WebGUI** (catalogo sfogliabile, player, pannello job) costruita sopra le stesse mini API.

Decisioni già prese con l'utente:
- **Stack**: Node.js, un solo linguaggio, nessun Python richiesto.
- **Ordine di costruzione**: prima si costruisce un layer di **mini API in-process** (libreria condivisa, non un server HTTP), poi un **CLI REPL** come primo consumatore, e **solo dopo** la WebGUI (React) come secondo consumatore delle stesse API. Motivazione: per un tool locale single-user non serve un server sempre acceso solo per usare la riga di comando; la stessa libreria verrà poi "vestita" con endpoint Express quando arriverà la WebGUI, riusando esattamente la stessa logica.
- **Motore di download**: binario standalone **`yt-dlp.exe`**, spostato in `tools/yt-dlp.exe`, invocato direttamente via `child_process.spawn` (nessun wrapper npm, nessun download automatico, nessun Python).
- **Fonte aggiornamenti v1**: una **sourcelist multi-playlist** gestita interattivamente dal CLI ("Gestisci fonti": aggiungi/elenca/rimuovi), non più una singola playlist fissa in config. Il monitoraggio di interi canali è desiderato in futuro ma non va implementato ora — va lasciato un punto di estensione pulito (interfaccia "source provider").
- **Manipolazione playlist su YouTube**: fuori scope per v1 (solo lettura/download, niente OAuth per ora).
- **Storage**: video salvati dentro il progetto in `./media`.
- **Qualità**: massima qualità disponibile, nessun cap di risoluzione (merge in MP4 tramite ffmpeg). Conseguenza diretta, chiesta dall'utente ("perché durante il download i file vengono creati tutti insieme e poi spostati?"): il selettore formato è `bv*+ba` (miglior video-only + miglior audio-only separati, `buildFormatSelector` in `ytdlpWrapper.js`), quindi yt-dlp scarica **due flussi grezzi separati** (più `.info.json` e thumbnail) e solo alla fine li fonde in un unico file con ffmpeg (`--merge-output-format mp4`) — i file intermedi (stream video/audio grezzi) sono un artefatto normale e temporaneo di yt-dlp, ripulito automaticamente a fusione riuscita. Non è un bug: è il prezzo della scelta "massima qualità" (i flussi migliori raramente arrivano già uniti da YouTube).
- **Playlist iniziale**: da configurare dall'utente una volta che il CLI è pronto (M6).
- **Documentazione continua**: ogni milestone completata va documentata nello `storico.md` (decisioni + logica costruttiva, non un changelog), aggiornando `documentazione.md` quando cambia lo stato attuale (vedi A6).

## Struttura del progetto

Monorepo con npm workspaces. **`/core`** è la libreria condivisa (le "mini API": funzioni JS pure, senza dipendenza da Express/HTTP), elevata a cartella di primo livello proprio perché è il cuore del progetto — non un dettaglio interno a `packages/`. `cli`, `server` e `web` dentro `packages/` sono le interfacce/adapter che la consumano, tutte richiamando le stesse funzioni esportate da `core`:

```
YouTubeCatalog/
  package.json                 # root workspaces: ["core", "packages/*"]
  .gitignore
  .env.example
  data/
    catalog.json                 # core: fonte di verità (dati curati)
    metadata.json                # metadati grezzi yt-dlp per id, consolidati (senza automatic_captions)
    config.json                  # impostazioni utente (mediaRoot, qualità, vlc, ecc.)
    jobs.json                    # storico persistito dei job (file unico, scrittura atomica — M24; prima: cartella jobs/ un-file-per-job)
  media/
    videos/
    thumbnails/
  core/                           # LE MINI API: libreria di funzioni, richiamabile da CLI e WebGUI
    package.json                    # nome pacchetto: @catalog/core; nessuna dipendenza esterna (anche la ricerca fuzzy, M7, è scritta a mano)
    cookies.txt                     # FACOLTATIVO, non versionato: vedi "Cookie per video privati/non listati"
    src/
      index.js                      # superficie pubblica: re-esporta tutti i servizi sotto
      config.js                     # load/validate data/config.json + .env
      catalog/catalogStore.js        # load/save atomico + mutex + reconciliation all'avvio
      catalog/catalogSchema.js
      catalog/metadataStore.js       # stesso pattern di catalogStore.js, per data/metadata.json
      ytdlp/ytdlpWrapper.js           # spawn tools/yt-dlp.exe, parsing progress/log
      sourceProviders/playlistProvider.js   # unico provider in v1
      services/videoService.js        # listVideos(filter), getVideo(id), listNew(), listChannels(), listVideosByChannel()
      services/syncService.js         # syncSource(sourceId) -> nuove entry "new" + auto-guarigione
      services/sourceService.js       # listSources(), addSource(url), removeSource(sourceId)
      services/decisionService.js     # decideVideo(id, "download"|"exclude"|"undecided")
      services/playbackService.js     # playVideo(id, {mode}) -> spawn VLC sul file locale
      services/metadataService.js     # getRawMetadata(id) -> data/metadata.json
      services/searchService.js       # searchVideos(query) -> ricerca fuzzy multi-campo (M7)
      services/singleVideoService.js  # prepareSingleVideoDownload(url) -> download one-off di un singolo video, mai legato a una fonte (M8)
      services/libraryService.js      # reorganizeLibrary(), sanitizeName(), targetRelPath() -> migrazione/allineamento al layout per creator
      jobs/jobManager.js              # coda single-worker + EventEmitter, persistenza storico
      jobs/jobs/downloadPending.js
      jobs/jobs/downloadSingle.js
  packages/
    cli/                          # primo consumatore delle mini API di /core
      package.json                  # dipendenza: @inquirer/prompts
      cli.js                      # menu a frecce (@inquirer/prompts): importa @catalog/core direttamente, nessun HTTP
    server/                       # thin wrapper HTTP attorno a @catalog/core (M10)
      package.json                   # dipendenza: express
      src/
        index.js                     # crea l'app Express, CORS aperto (strumento locale single-user), monta le route sotto /api + media statico
        routes/videos.routes.js      # lettura catalogo, decideVideo/playVideo, searchVideos, canali, download singolo
        routes/sources.routes.js     # listSources/addSource/removeSource, /api/sync
        routes/jobs.routes.js        # triggerJob/listJobs/getJob + GET /api/jobs/:id/stream (SSE, bridge su jobManager)
        routes/library.routes.js     # POST /api/library/reorganize (dryRun di default true)
        media/mediaRoutes.js         # express.static per /media/videos e /media/thumbnails (Range requests/ETag)
        lib/asyncRoute.js            # cattura le Error di core -> 400 { error: message }, un solo pattern di errore
        lib/publicVideo.js           # aggiunge videoUrl/thumbnailUrl con path-encoding per segmento
    web/                          # SPA React, client HTTP di packages/server (M11)
      vite.config.js                # proxy dev su /api e /media verso il server
      src/
        App.jsx
        main.jsx
        api/client.js
        hooks/useJobStream.js        # sottoscrizione SSE condivisa, chiude la EventSource a success/failed
        lib/format.js
        lib/reviewActions.js         # REVIEW_ACTIONS_BY_STATUS, stessa tabella del CLI
        lib/status.js
        pages/CatalogPage.jsx        # Home: chip di stato, banner "Scarica in coda"
        pages/VideoDetailPage.jsx    # player + azioni contestuali allo stato
        pages/SearchPage.jsx         # ricerca fuzzy (searchVideos), debounce 300ms
        pages/ChannelPage.jsx        # equivalente di "Guarda"
        pages/SourcesPage.jsx        # "Gestisci fonti" + "Sincronizza" fusi
        pages/SingleDownloadPage.jsx # "Scarica video singolo": form + barra avanzamento + storico sempre visibile (M24)
        pages/JobsPage.jsx           # log/progresso live via SSE + storico condiviso
        pages/LibraryPage.jsx        # "Libreria": placeholder vuoto (M23; "Riorganizza libreria" ritirata dal web)
        components/VideoCard.jsx
        components/StatusBadge.jsx
        components/StatusChips.jsx
        components/Layout.jsx
        components/MobileNav.jsx
        components/JobHistory.jsx    # storico job condiviso (M24): copertina+titolo, cancella singolo/svuota
        styles/global.css            # design token direzione "Cinema" (scuro), nessun framework CSS
  scripts/
    testDownload.mjs             # script usa-e-getta per la Milestone 1
  tools/
    yt-dlp.exe                   # binario standalone, invocato direttamente (no wrapper npm)
  CLAUDE.md                      # in radice: entry point che delega a docs/progetto.md (@import)
  docs/                          # tutta la documentazione di riferimento
    progetto.md                    # specifiche: regole/comportamenti/profilo + contesto e architettura
    PIANO.md                       # futuro: milestone pianificate + backlog + bug
    documentazione.md              # stato attuale (riassunto vivo: core, decisioni, meccaniche controintuitive, scelte negative)
    storico.md                     # log append-only di tutte le implementazioni/decisioni, milestone per milestone
```

## Schema del catalogo (`data/catalog.json`)

Oggetto unico, `videos` è una mappa **keyed by YouTube id** (lookup O(1), dedup naturale, diff-friendly):

```json
{
  "version": 1,
  "videos": {
    "dQw4w9WgXcQ": {
      "id": "dQw4w9WgXcQ",
      "title": "Never Gonna Give You Up",
      "description": "The official video for \"Never Gonna Give You Up\" by Rick Astley...",
      "webpageUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "originalUrl": "https://www.youtube.com/playlist?list=PLxxxx&v=dQw4w9WgXcQ",
      "extractor": "youtube",

      "channel": {
        "id": "UCuAXFkgsw1L7xaCfnd5JJOw",
        "name": "Rick Astley",
        "url": "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw",
        "uploaderId": "@RickAstleyYT",
        "uploaderUrl": "https://www.youtube.com/@RickAstleyYT",
        "subscriberCountAtDownload": 4230000
      },

      "uploadDate": "2009-10-25",
      "releaseTimestamp": null,
      "durationSeconds": 212,

      "categories": ["Music"],
      "tags": ["rick astley", "official video", "never gonna give you up"],
      "language": "en",
      "ageLimit": 0,
      "availability": "public",
      "license": null,
      "isLive": false,
      "wasLive": false,

      "statsAtDownload": {
        "viewCount": 1650000000,
        "likeCount": 18000000,
        "commentCount": 2200000,
        "averageRating": null
      },

      "resolution": { "width": 1920, "height": 1080, "fps": 25, "dynamicRange": "SDR" },

      "thumbnails": [
        { "url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg", "width": 1920, "height": 1080 },
        { "url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "width": 480, "height": 360 }
      ],
      "thumbnail": { "sourceUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg", "localPath": "dQw4w9WgXcQ.jpg" },

      "chapters": [
        { "title": "Intro", "startSeconds": 0, "endSeconds": 18 },
        { "title": "Chorus", "startSeconds": 18, "endSeconds": 45 }
      ],
      "subtitleLanguagesAvailable": ["en", "it"],

      "playlistContext": { "playlistId": "PLxxxx", "playlistTitle": "To Download", "playlistIndex": 3 },

      "video": {
        "localPath": "Rick Astley/Never Gonna Give You Up [dQw4w9WgXcQ].mp4",
        "formatId": "bv*+ba/b",
        "container": "mp4",
        "videoCodec": "avc1.640028",
        "audioCodec": "mp4a.40.2",
        "bitrateKbps": 4500,
        "sizeBytes": 123456789,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "downloadedAt": "2026-07-20T10:05:12.000Z",
        "ytdlpVersion": "2026.07.01"
      },

      "status": "downloaded",
      "source": { "sourceId": "PLxxxx", "type": "playlist" },
      "addedAt": "2026-07-18T09:00:00.000Z",
      "updatedAt": "2026-07-20T10:05:12.000Z",
      "decidedAt": "2026-07-18T09:05:00.000Z",
      "attempts": 1,
      "error": null
    }
  },
  "sources": {
    "PLxxxx": {
      "type": "playlist",
      "id": "PLxxxx",
      "name": "To Download",
      "url": "https://www.youtube.com/playlist?list=PLxxxx",
      "lastCheckedAt": null
    }
  },
  "meta": { "lastUpdated": "2026-07-20T10:00:00.000Z" }
}
```

> ⚠️ **In evoluzione (M25+)**: l'unico `status` lineare descritto qui sotto viene smontato in **flag ortogonali** (`presence` / `download` / `hidden`) — vedi la sezione "Modello di stato a flag ortogonali" più in basso. Fino a M25 vale ancora l'enum qui descritto; dopo, questa descrizione resta solo come storia di come nacque il modello.
>
> ⚠️ **In evoluzione (M41)**: il campo `"source": { "sourceId", "type" }` (singolo) qui sopra è superato — sostituito da `"sources": [{ "sourceId", "name" }]` (array). Un video **non dipende** dalla sorgente: è un'entità a sé (esattamente come un download singolo one-off), le fonti sono etichette che porta (zero, una o più), non un vincolo di appartenenza. `sources: []` è lo stato normale di un video senza etichette, non un caso "orfano" speciale. Vedi M41 nella tabella milestone.

**`status`**: `new | pending | downloading | downloaded | failed | excluded`.

- `new` — appena trovato in una sync della playlist, **in attesa di decisione dell'utente** (è la "novità" che il CLI mostra).
- `pending` — l'utente ha deciso di scaricarlo (o un `downloaded` è stato auto-riparato perché il file è sparito dal disco); in coda per il prossimo `downloadPending`.
- `downloading` / `downloaded` / `failed` — come nel flusso di download originale.
- `excluded` — l'utente ha deciso esplicitamente di **non** scaricarlo; resta nel catalogo per non essere riproposto come "novità" a ogni sync successiva, ma nessun file viene scaricato.

`decidedAt` traccia quando l'utente ha preso la decisione (download/esclusione); resta `null` finché lo stato è `new`.

`video.localPath`/`thumbnail.localPath` sono **relativi a `mediaRoot`** (in `config.json`), così spostare l'archivio richiede solo cambiare config, non riscrivere il catalogo. `video.localPath` segue il **layout canonico per creator** `<Creator>/<Titolo> [<id>].<ext>` (sottocartella per canale, id sempre nel nome — vedi "Archivio canonico per creator" più sotto); `thumbnail.localPath` resta piatto (`<id>.jpg`), le thumbnail sono interne e non sfogliate dall'utente.

**Metadati grezzi "il più possibile completi", consolidati in `data/metadata.json`**: oltre ai campi curati sopra, ogni download/importazione passa anche `--write-info-json`, che fa scrivere a yt-dlp un sidecar temporaneo `<id>.info.json` con l'intero oggetto di metadati grezzo estratto da YouTube. `ytdlpWrapper.js` lo legge, lo salva in `data/metadata.json` (mappa `{ [id]: metadatoGrezzo }`, gestita da `catalog/metadataStore.js` con lo stesso pattern mutex+scrittura atomica di `catalogStore.js`) e **cancella il sidecar** — nessun file resta sparso accanto ai video. Prima di salvare viene rimosso `automatic_captions` (elenco di URL per sottotitoli auto-tradotti in 150+ lingue: gonfia ogni metadato di centinaia di KB, quasi mai utile); tutto il resto (formats, heatmap, capitoli, ecc.) resta integrale — nessuna informazione realmente utile che yt-dlp è in grado di estrarre va persa. Accesso tramite `getRawMetadata(id)`. `statsAtDownload` (nel catalogo curato) è deliberatamente uno **snapshot al momento del download**, non un valore live, perché per i video che spariscono da YouTube quello snapshot resta l'unica testimonianza di quei numeri.

Nota: `--write-subs`/`--write-auto-subs` (download dei file di sottotitoli veri e propri) è lasciato fuori dal v1 per contenere tempo/spazio, ma è un'aggiunta banale in futuro — l'elenco `subtitleLanguagesAvailable` viene comunque catturato ora dai metadati.

**Perché JSON puro e non sqlite/lowdb**: scala di un archivio personale (centinaia/poche migliaia di video) → parsing/serializzazione in millisecondi, nessun vantaggio da un motore DB. Il rischio di concorrenza è contenuto **in-process** con un mutex asincrono attorno a ogni mutazione + **scrittura atomica** (`catalog.json.tmp` poi `fs.rename()`, atomico su NTFS). Se in futuro il catalogo crescesse molto, si può sostituire `catalogStore.js` con un backend sqlite dietro la stessa interfaccia, senza toccare il resto.

## Il core: la libreria di mini API (`/core`)

**`core` è la libreria di funzioni condivisa** — le "mini API" di cui si è parlato — richiamabile sia dalla **CLI** (`packages/cli/cli.js`, che la importa direttamente in-process) sia, più avanti, dalla **WebGUI** (`packages/web`, indirettamente: tramite `packages/server`, che espone via HTTP le stesse funzioni). Non è un server, non ha dipendenze da Express/HTTP: è puro codice Node — funzioni JS async, importabili ovunque nello stesso processo o "vestite" da un adapter HTTP quando serve. Per questo vive in una cartella di primo livello (`/core`), non annidata sotto `packages/`: è il nucleo su cui ogni interfaccia si appoggia, non un'interfaccia essa stessa.

Superficie pubblica (`core/src/index.js`), identica per qualunque chiamante:

- `listVideos({ status? })` — elenco video, filtrabile per stato.
- `getVideo(id)` — dettaglio di un video.
- `listNew()` — scorciatoia per `listVideos({ status: 'new' })`, le "novità" da rivedere.
- `listChannels({ status = 'downloaded' })` — canali distinti tra i video con lo stato indicato, con conteggio; usata dal flusso "Guarda" del CLI.
- `listVideosByChannel(channelKey, { status = 'downloaded' })` — video di un canale specifico (stesso `channelKey` restituito da `listChannels`).
- `listSources()` — elenco delle fonti configurate (playlist), con conteggio video per fonte.
- `addSource(url)` — valida che l'URL sia una playlist (`list=`), normalizza l'URL, recupera titolo reale ed entries da YouTube in una chiamata, registra la fonte e ingerisce subito le entry come "novità" (dedup se già presente).
- `removeSource(sourceId)` — rimuove una fonte dall'elenco; i video già catalogati che la referenziano restano intatti.
- `syncSource(sourceId)` — enumera la playlist (`yt-dlp --flat-playlist -J`) di una fonte già registrata in `catalog.sources`, inserisce nuove entry con `status: new`, auto-ripara i `downloaded` il cui file è sparito riportandoli a `pending`, lascia invariati `excluded`/`pending`/`downloading`/`failed`. Ritorna un riepilogo `{ newCount, healedCount }`.
- `decideVideo(id, decision)` — `decision: 'download'` → `status: pending`; `decision: 'exclude'` → `status: excluded`; `decision: 'undecided'` → torna a `status: new` (annulla una decisione precedente). Ammesso da/verso qualunque combinazione tra `new`/`pending`/`excluded` (non da `downloading`/`downloaded`/`failed`, fuori dal ciclo di revisione novità). Aggiorna `decidedAt` (`null` se si torna a `new`).
- `triggerJob(type, params)` / `getJob(id)` / `listJobs()` / `deleteJob(id)` / `clearJobs()` — coda job (`downloadPending`, `downloadSingle`): coda single-worker FIFO, storico persistito in **`data/jobs.json`** (file unico, scrittura atomica; migrato dal vecchio layout un-file-per-job in M24), `EventEmitter` per eventi `log`/`progress`/`status` in tempo reale. `deleteJob`/`clearJobs` (M24) cancellano solo il record storico (i video/file su disco restano); un job `running`/`queued` non è cancellabile (nessun meccanismo di abort).
- `playVideo(id, { mode = 'video' })` — verifica `status: downloaded` e che il file esista, poi lancia VLC; `mode: 'audio'` aggiunge `--no-video` per la riproduzione solo audio.
- `prepareSingleVideoDownload(url)` — **(nuova, M8)** download one-off di un singolo video da un link incollato, senza passare da una fonte/sync di playlist; vedi sezione dedicata sotto.

Il **job manager** e il **wrapper yt-dlp** vivono in `core` (non dentro `packages/server`): il CLI, essendo nello stesso processo, si iscrive direttamente agli eventi dell'`EventEmitter` di `jobManager` e stampa le righe di log a terminale in tempo reale — nessuna infrastruttura SSE necessaria finché non arriva la WebGUI (M10), che invece farà da bridge fra quegli stessi eventi e i suoi client HTTP via SSE.

## Cookie per video privati/non listati (`core/cookies.txt`, facoltativo)

- `core/cookies.txt` è un file **facoltativo**, non versionato (va nel `.gitignore`), in formato Netscape — lo stesso prodotto da estensioni browser tipo "Get cookies.txt LOCALLY" esportando i cookie della sessione YouTube dell'utente.
- Se il file **è presente**, `ytdlpWrapper.js` lo passa automaticamente a ogni invocazione di yt-dlp (`--cookies core/cookies.txt`), permettendo l'accesso a video privati/non listati del proprio account (utile se la playlist "da scaricare" li include).
- Se il file **non è presente**, yt-dlp viene invocato senza `--cookies`, senza errori: non è un prerequisito, è un'aggiunta opzionale attivabile in qualsiasi momento semplicemente creando il file.
- `config.ytdlp.cookiesFile` in `data/config.json` resta `null` di default (= "usa `core/cookies.txt` se esiste"); se l'utente lo valorizza esplicitamente con un altro path, quello ha la precedenza sul default.

## Riproduzione con VLC (`playbackService.js`)

- `config.playback.vlcPath` in `data/config.json`, default `C:\Program Files (x86)\VideoLAN\VLC\vlc.exe` (percorso reale verificato su questa macchina — l'installazione a 64 bit non sempre esiste, dipende dal sistema), sovrascrivibile se installato altrove.
- `playVideo(id, { mode })`: risolve il path assoluto (`mediaRoot + video.localPath`), verifica l'esistenza del file, poi `child_process.spawn(vlcPath, args, { detached: true, stdio: 'ignore' }).unref()` — VLC parte come processo indipendente e continua a girare anche se il CLI viene chiuso. `args` è `[filePath]` in modalità video, `['--no-video', filePath]` in modalità solo audio.
- Se `vlcPath` non esiste su disco, errore chiaro ("VLC non trovato in <path>, imposta playback.vlcPath in data/config.json") invece di un crash silenzioso.

## Il CLI (`packages/cli/cli.js`)

**Navigazione a menu selezionabili con le frecce** (libreria `@inquirer/prompts`: `select`, `confirm`, `input`), non un REPL a comandi digitati — scelta esplicita dell'utente, in stile Claude Code. Si lancia con `node packages/cli/cli.js` (o `npm run cli` dalla root). Un ciclo `while (true)` mostra il menu principale e richiama il sotto-flusso scelto; ogni sotto-flusso è a sua volta un ciclo con una voce **"← Torna"** sempre presente in coda alla lista — è così che si annulla/torna indietro, mai con un comando digitato.

**Menu principale:**

- **Gestisci fonti** → sotto-menu: **Aggiungi fonte** (prompt testuale per l'URL, unico punto del CLI dove serve testo libero; `addSource(url)` aggiunge subito, senza conferma intermedia, reversibile con "Rimuovi fonte") / **Elenca fonti** / **Rimuovi fonte** (select + conferma) / ← Torna.
- **Scarica video singolo** → **(nuova, M8)** prompt testuale per l'URL (o l'id) del video; scarica subito quel singolo video senza creare né toccare nessuna fonte — vedi sezione dedicata sotto. Se l'id è già tracciato tramite una fonte esistente con uno stato diverso da "scaricato"/"in corso", rifiuta e rimanda a "Rivedi novità".
- **Sincronizza** → se nessuna fonte configurata, messaggio e torna al menu; altrimenti `select` con **"Tutte le fonti"** in cima + una voce per fonte + ← Torna → esegue `syncSource` (una o tutte in sequenza) → riepilogo.
- **Rivedi novità** → **vista unica** che sostituisce le due voci separate precedenti (revisione + download, ora una dentro l'altra su richiesta dell'utente). Elenca **tutti** i video `new`/`pending`/`excluded` insieme (con un'icona di stato per riconoscerli a colpo d'occhio), più una voce in cima **"▶ Scarica in coda (N)"** (visibile solo se N > 0) + ← Torna al menu principale. Se non c'è nulla da rivedere e nulla in coda, messaggio e torna al menu.
  - Scegliendo un video: sotto-`select` con le azioni valide per il suo stato attuale — da `new`: **Scarica** / **Archivia**; da `pending`: **Archivia** / **Rimetti tra le novità** (annulla la decisione, torna a `new`); da `excluded`: **Scarica** / **Rimetti tra le novità** — sempre con ← Torna alla lista. Applica `decideVideo(id, 'download'|'exclude'|'undecided')` → torna alla lista aggiornata. Questo risolve anche il bisogno di **togliere un video dagli archiviati** e cambiargli stato, prima non possibile.
  - Scegliendo **"▶ Scarica in coda (N)"**: stesso comportamento di prima (`confirm` "Scaricare N video ora?" → se sì, `triggerJob('downloadPending')` con log/progress live via `EventEmitter`) ma **nidificato dentro questa vista** invece che una voce separata del menu principale.
- **Cerca** → **(nuova, M7)** ricerca fuzzy libera su tutto il catalogo (titolo, canale, tag, descrizione); vedi sezione dedicata sotto.
- **Guarda** → `listChannels({status:'downloaded'})`; se vuoto, messaggio. Altrimenti `select` canali (nome + conteggio) + ← Torna → `select` video di quel canale (titolo, durata, data) + ← Torna ai canali → `select` **Video** / **Solo audio** → `playVideo(id, {mode})` → torna alla lista video di quel canale.
- **Catalogo** → `select` di uno stato (Tutti/Nuovi/In coda/In download/Scaricati/Falliti/Archiviati) + ← Torna → stampa l'elenco corrispondente (vista informativa) → torna al menu.
- **Esci** → termina il processo.

Non esiste una scorciatoia "play per id" a comando digitato: la navigazione **Guarda** (canale → video → modalità) è l'unico modo per riprodurre un video partendo da zero, coerente col vincolo "niente comandi scritti a mano" — **Cerca** e **Scarica video singolo** sono le eccezioni minime e deliberate a questo vincolo, gli unici punti oltre "Aggiungi fonte" dove si digita testo libero, perché una ricerca o un link incollato non hanno senso senza testo digitato. Il blocco "exit durante un download" non richiede gestione esplicita: il design a menu è bloccante (un solo flusso interattivo alla volta), quindi non esiste uno stato in cui si può navigare al menu mentre un job è in corso.

Errori (id inesistente, stato incompatibile con l'azione, VLC non trovato, URL senza `list=`, fonte non trovata, ecc.) vengono stampati come messaggio chiaro e si torna al menu/passo precedente, mai un crash.

## Motore di ricerca (`searchService.js`, M7)

Decisioni prese con l'utente:
- **Campi cercati**: titolo, canale, tag, descrizione — non solo titolo/canale, per massimizzare le possibilità di trovare un video anche ricordandone solo un dettaglio.
- **Ambito**: tutto il catalogo, qualunque stato (`new`/`pending`/`downloading`/`downloaded`/`failed`/`excluded`) — un solo posto per trovare qualsiasi video, non solo quelli scaricati.
- **Tipo di corrispondenza**: fuzzy (tollerante a errori di battitura/ordine delle parole), non semplice sottostringa.

**`core/src/services/searchService.js`** (nuovo): `searchVideos(query, { limit = 20 } = {})`. **Nessuna dipendenza esterna**: valutata la libreria `fuzzysort` ma scartata su richiesta esplicita dell'utente ("core non deve avere dipendenze") — `core` resta puro codice Node, coerente con la scelta originale di non usare `yt-dlp-wrap`/sqlite/altre librerie. Algoritmo scritto a mano:

- Query divisa in parole (spazi), **semantica AND**: ogni parola deve trovare corrispondenza da qualche parte perché un video sia un risultato.
- **Titolo/canale/tag** (campi brevi): corrispondenza fuzzy a **finestra scorrevole + distanza di Levenshtein** — per ogni parola, si scorrono sottostringhe del testo di lunghezza vicina a quella della parola (`editDistance` classico, due righe invece di una matrice completa) e si accetta se la distanza è entro una soglia proporzionale alla lunghezza (0 per parole ≤3 caratteri, 1 fino a 6, 2 oltre). Tollera errori di battitura reali (es. "sampuma" trova "Sampurna").
- **Descrizione** (campo lungo, centinaia/migliaia di caratteri): **solo sottostringa esatta**, non fuzzy. Prima versione usava una sottosequenza libera su tutto il testo ("le lettere compaiono in ordine da qualche parte") — **bug reale trovato in fase di test**: con testi lunghi, quasi ogni parola breve trova una corrispondenza sparsa senza alcun senso (query di 2 parole tornava 20 risultati quasi casuali). Corretto restringendo la tolleranza a errori di battitura solo ai campi brevi, dove è economica e semanticamente sensata; la descrizione resta cercabile ma solo per frase/parola esatta.
- Punteggio pesato per campo (titolo > canale > tag > descrizione) e per qualità del match (sottostringa esatta > fuzzy), risultati ordinati per rilevanza.

Verificato con il catalogo reale dell'utente: `"bel gramar"` (typo) → 1 risultato corretto ("Miss Bell Teaches A Grammar Lesson"), invece dei 20 quasi-casuali della prima versione; `"sampuma"` (typo sul nome canale) → trova comunque il video del canale "Sampurna ASMR"; `"asmr"` → risultati ampi come atteso (quasi tutto il catalogo è a tema ASMR); query senza corrispondenze → 0 risultati puliti.

Esportata da `core/src/index.js`.

**CLI**: usa il prompt **`search`** di `@inquirer/prompts` (non `input`+`select` in due passaggi come altrove — qui il filtro dal vivo mentre si digita è il punto centrale della UX) con una funzione `source(input)` che chiama `core.searchVideos(input)` e mappa i risultati in scelte con icona di stato + titolo + canale. Selezionato un video, si presenta un sotto-`select` di azioni **contestuali allo stato attuale**, riusando la stessa logica già presente in "Rivedi novità" (per `new`/`pending`/`excluded`/`failed`: Scarica/Archivia/Riprova/Rimetti tra le novità, via `decideVideo`) e in "Guarda" (per `downloaded`: Video/Solo audio, via `playVideo`); per `downloading`, solo un messaggio informativo, nessuna azione (è già in corso). Tutte queste azioni richiamano le stesse funzioni `core` già scritte e testate — nessuna nuova logica di stato, solo un nuovo punto di ingresso per raggiungerle.

## Download singolo one-off (`singleVideoService.js`, M8)

L'utente vuole poter scaricare **un singolo video** incollandone il link, senza dover passare dal meccanismo delle fonti (`Gestisci fonti` → `Sincronizza` → `Rivedi novità`), pensato per intere playlist. Il video finisce comunque regolarmente nel catalogo (compare in "Guarda"/"Catalogo"/"Cerca" come qualunque altro), ma senza legame con una fonte. **Qualunque sito supportato da `yt-dlp.exe`** (YouTube, Rumble, ecc.), non solo YouTube — vedi correzione sotto.

`core/src/services/singleVideoService.js` (nuovo), unica funzione pubblica `prepareSingleVideoDownload(url)`:

1. Normalizza l'input a un URL: un id YouTube nudo di 11 caratteri viene espanso a `https://www.youtube.com/watch?v=ID` (comodo da incollare, unico caso in cui l'URL si può costruire senza ambiguità); qualunque altro input deve già essere un URL `http(s)` valido — input non riconosciuto → errore chiaro.
2. **`ytdlpWrapper.resolveVideoInfo(url)`** (nuovo) risolve id/titolo/canale/durata/`extractor`/`webpage_url` **con yt-dlp stesso** (`--skip-download -J`), non con un regex scritto a mano: è così che il sito viene riconosciuto automaticamente, qualunque cosa yt-dlp sappia gestire — nessuna lista di pattern URL da mantenere per ogni sito. Se il link punta a una playlist/canale (non un singolo video), errore chiaro che rimanda a "Gestisci fonti".
3. Se l'id risolto è **già nel catalogo**:
   - `status: downloaded` → nessuna azione, si informa che è già in archivio.
   - `status: downloading` → nessuna azione, si informa che è già in corso.
   - qualunque altro stato (`new`/`pending`/`failed`/`excluded`, cioè un video già tracciato tramite una fonte esistente) → **si rifiuta** e rimanda l'utente a "Rivedi novità": il flusso one-off non deve scavalcare una revisione già impostata da una sync di playlist.
4. Se l'id **non** è nel catalogo: crea uno stub (stesso helper `createNewVideoStub` già usato da `ingestPlaylistEntries`, ora esteso per accettare `webpageUrl`/`originalUrl`/`extractor` reali invece dei default YouTube) con `status: pending` e — punto chiave — `source: { sourceId: null, type: 'single' }`. È questo il meccanismo che garantisce che il video non passi mai per i canali di sincronizzazione: `syncSource(sourceId)` itera solo gli entries di una fonte registrata in `catalog.sources`; un video con `source.sourceId: null` non viene mai enumerato né toccato da nessuna sync futura, qualunque cosa succeda dopo. Segue subito il download vero e proprio, riusando **senza modifiche di logica** il job `downloadSingle` già esistente (`core/src/jobs/jobs/downloadSingle.js`, finora usato implicitamente solo per i retry manuali) — vedi sotto per l'unica correzione necessaria a `downloadVideo()`.

**CLI**: nuova voce **"Scarica video singolo"** nel menu principale, subito dopo "Gestisci fonti" — prompt testuale per l'URL (o l'id), poi in base all'esito: messaggio se già in archivio/in corso/già tracciato altrove, oppure `triggerJob('downloadSingle', { videoId })` con log/progress live in tempo reale, stesso pattern già usato da "Scarica in coda" in "Rivedi novità".

### Correzione: `downloadVideo()` scaricava sempre da un URL YouTube ricostruito dall'id

Bug reale trovato testando un video Rumble end-to-end: `ytdlpWrapper.downloadVideo(videoId, ...)` ignorava del tutto il sito reale e costruiva sempre `https://www.youtube.com/watch?v=${videoId}` da passare a yt-dlp — funzionava per le fonti/playlist (YouTube-only per design) ma avrebbe scaricato l'URL YouTube sbagliato per qualunque video non-YouTube. Corretto: `downloadVideo(videoId, url, {...})` ora accetta l'URL reale (da `video.webpageUrl`, popolato correttamente per qualunque sito da `resolveVideoInfo()`/`mapInfoJsonToVideoFields()`, entrambi già extractor-agnostici) e lo passa a yt-dlp; `videoId` resta usato solo per ritrovare i file scritti da yt-dlp dopo il download (stesso id in `-o "%(id)s.%(ext)s"`). Aggiornati i due chiamanti (`downloadSingleJob`, `downloadPendingJob`) per passare `video.webpageUrl`.

Secondo bug trovato nello stesso test: il format selector di default (`bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]`) esclude l'AV1 su **entrambe** le alternative — un workaround specifico per un problema di YouTube (vedi "Logica di download e dedup" sotto). Su Rumble questo escludeva l'unico formato disponibile, facendo fallire il download con "Requested format is not available" anche se il video esisteva ed era scaricabile. Corretto aggiungendo un ultimo fallback **senza filtro AV1** (`.../b`, sia nel default di `config.json` sia nel ramo con `maxHeight` impostato in `buildFormatSelector()`): su YouTube l'esclusione AV1 continua a valere perché le alternative precedenti quasi sempre trovano un formato non-AV1 valido; sugli altri siti, se le alternative filtrate falliscono, si scarica comunque il meglio disponibile invece di fallire senza motivo apparente.

### Archivio canonico per creator con nomi leggibili

L'utente aveva notato che `media/videos/` era poco consultabile aprendola direttamente in Esplora File: tutti i canali mescolati in un'unica cartella piatta, e il nome file era l'id YouTube (es. `88RAHq3prwo.mp4`), non il titolo. Tra le due strade valutate (cambiare l'archivio canonico vs. un comando di esportazione via hard link separato), l'utente ha scelto esplicitamente di **cambiare l'archivio vero e proprio** — un solo posto, non una vista duplicata — nonostante il costo di dover ri-organizzare i file già scaricati.

**Layout canonico**: `media/videos/<Creator>/<Titolo> [<id>].<ext>` — la convenzione di default di yt-dlp, con sottocartella per creator. L'id è **sempre** nel nome (non solo in caso di collisione): risolve da sé il problema di titoli duplicati nello stesso canale (caso reale incontrato: due video "[ASMR] Come Study With Me" con id diversi) senza bisogno di logica di deduplica dedicata. Le thumbnail restano piatte in `media/thumbnails/<id>.jpg` (interne, non sfogliate dall'utente).

I nuovi download scrivono già in questo layout (template `-o` di yt-dlp aggiornato in `ytdlpWrapper.js`). Per i video scaricati prima del cambio, `core/src/services/libraryService.js` espone `reorganizeLibrary({ dryRun })`: funzione **idempotente e riusabile** (non uno script una tantum) che individua il file attuale di ogni video `downloaded` (per `localPath` registrato o, in fallback, cercando ricorsivamente il marker `[<id>]`/il vecchio nome piatto `<id>.<ext>`), lo sposta (`renameSync`, istantaneo sullo stesso volume) al percorso canonico e aggiorna `localPath` nel catalogo. `dryRun: true` ritorna solo il piano (`planned`/`alreadyOk`/`missing`) senza toccare nulla. Esposta da CLI ("Riorganizza libreria", dry-run → conferma → esecuzione) e web (`LibraryPage`, stesso pattern) e via `POST /api/library/reorganize` sul server.

**Migrazione dell'archivio reale eseguita**: tutti i video già scaricati dall'utente sono stati riorganizzati nel layout per creator (52 spostati, verificato nessun file rimasto nel vecchio formato piatto, funzionamento confermato end-to-end su CLI/server con i file reali). Dettagli e verifica in `storico.md`.

### Reset della schermata CLI

I menu del CLI (`@inquirer/prompts` dentro cicli `while(true)`) non pulivano il terminale: ogni vecchia versione di un elenco (es. "Rivedi novità" dopo ogni decisione, "Guarda" scorrendo canali/video) restava stampata sopra le nuove, e dopo pochi giri lo schermo diventava illeggibile. Implementato un reset a ogni menu/sottomenu:

- Due helper condivisi in `packages/cli/cli.js`: `clearScreen()` pulisce il terminale (`console.clear()`, solo se `process.stdout.isTTY`, per non rompere output rediretto/pipe) e subito dopo ristampa un eventuale messaggio in sospeso; `setMessage(text)` mette in coda quel messaggio (una singola variabile globale, sicura perché il CLI è bloccante — un solo flusso interattivo alla volta).
- Ogni ciclo `while(true)` di menu/sottomenu chiama `clearScreen()` come prima istruzione, prima di ricalcolare/ristampare l'elenco.
- Ogni output "da leggere" non in tempo reale (conferme, riepiloghi, elenchi informativi) passa da `console.log` diretto a `setMessage()`, così sopravvive esattamente una schermata invece di sparire subito o restare per sempre. Fa eccezione lo streaming live dei log di un job in corso, che resta `console.log` diretto riga per riga: solo la riga di riepilogo finale passa da `setMessage()`.

## Logica di download e dedup

1. **Sync (enumerazione)**: `yt-dlp --js-runtimes node --flat-playlist -J <playlist-url>` (economico, non tocca file) su una fonte già registrata in `catalog.sources`. Per ogni id:
   - non in catalogo → inserisci `status: new` (è una "novità", in attesa di decisione).
   - in catalogo `downloaded` → verifica che il file esista su disco; se manca, torna `pending` (già deciso in passato, va solo riscaricato).
   - in catalogo `excluded` → lascia invariato (decisione già presa, non riproporre).
   - in catalogo `new`/`pending`/`downloading`/`failed` → lascia invariato.
2. **Aggiunta fonte**: "Aggiungi fonte" nel CLI (`addSource(url)`) registra una nuova playlist in `catalog.sources` e ingerisce subito le sue entry come sopra (stessa logica, fattorizzata in `ingestPlaylistEntries()`).
3. **Decisione**: "Scarica"/"Archivia"/"Rimetti tra le novità" nella vista "Rivedi novità" del CLI spostano liberamente un'entry tra `new`/`pending`/`excluded`.
4. **Download**: per ogni entry `pending` (o `failed` con `attempts < maxAttempts`, default 3): imposta `downloading`, spawna `yt-dlp --js-runtimes node --extractor-args "youtube:player_client=default,android_vr" -f "bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]/b" --merge-output-format mp4 --write-thumbnail --convert-thumbnails jpg --write-info-json -o "media/videos/%(channel,uploader|Sconosciuto)s/%(title)s [%(id)s].%(ext)s" -o "thumbnail:media/thumbnails/%(id)s.%(ext)s" --download-archive media/.ytdlp-archive.txt <url>` (`<url>` = `video.webpageUrl` reale, non ricostruito dall'id — vedi correzione multi-sito in "Download singolo one-off") — **senza `--cookies` al primo tentativo**; se fallisce e sono configurati dei cookie (`core/cookies.txt`), si ripulisce l'eventuale residuo e si ritenta un'unica volta con `--cookies` incluso. Al termine, `ytdlpWrapper.js` legge il sidecar `.info.json` (trovato per marker `[<id>]` nella sottocartella creator), ne mappa i campi curati nello schema, salva il grezzo in `data/metadata.json` e cancella il sidecar. A successo: calcola sha256 + size, `status: downloaded`. A fallimento: `status: failed`, `attempts++`, salva errore.
   - **`--js-runtimes node`**: senza un runtime JavaScript, yt-dlp non riesce a decifrare le firme dei formati più recenti e i download falliscono a metà con `HTTP 403`. Node è già una dipendenza del progetto, quindi lo si usa come runtime (nessuna installazione aggiuntiva, es. Deno).
   - **Esclusione codec AV1** (`vcodec!*=av01`): scoperto verificando con la playlist reale dell'utente che il formato di default (`bv*+ba/b`, che sceglie AV1 alla risoluzione più alta) falliva sistematicamente con 403 anche con il runtime JS attivo, mentre lo stesso video alla stessa risoluzione in **VP9** scaricava senza problemi. **Nessun compromesso sulla qualità**: si ottiene comunque la risoluzione più alta disponibile, semplicemente non in AV1, coerente con "massima qualità, nessun cap". Il fallback finale `/b` (senza filtro AV1) è stato aggiunto in M8 per i siti non-YouTube dove l'esclusione AV1 può escludere l'unico formato disponibile.
   - **Template `-o` per-creator**: `%(channel,uploader|Sconosciuto)s/%(title)s [%(id)s].%(ext)s` — yt-dlp sanifica da sé i caratteri non validi per Windows e crea le sottocartelle; vedi "Archivio canonico per creator" sopra. Il template della thumbnail resta piatto.
   - **`player_client=default,android_vr`**: alcuni video vengono assegnati da YouTube a un esperimento che richiede un "PO Token" per i client normali (web/ios/tv) — senza, quei client falliscono con 403 in modo sistematico e ripetibile (diagnosticato con `yt-dlp -v --simulate`: "Detected experiment to bind GVS PO Token to video ID"). Il client `android_vr` non è soggetto all'esperimento; aggiunto come client **supplementare** (non sostitutivo di `default`) così i video non coinvolti nell'esperimento continuano a usare i client abituali.
   - **Niente `--cookies` al primo tentativo**: inviare i cookie del browser insieme all'identità client mobile `android_vr` è una combinazione che la CDN video di YouTube tratta come sospetta e blocca con 403, anche se le fasi di estrazione precedenti (con quegli stessi cookie) riescono. Dato che tutti i video di un catalogo personale sono tipicamente pubblici, il primo tentativo è senza cookie; il fallback con cookie resta per l'unico caso in cui servono davvero: video privati/non listati del proprio account.
5. **Interruzioni**: yt-dlp riprende download parziali via range request nativamente (il file `.part` viene deliberatamente preservato quando un download fallisce, per permettere la ripresa). Se il processo muore mid-download, all'avvio `catalogStore` resetta ogni entry bloccata su `downloading` a `pending`.
6. **Pulizia dei residui**: se un download fallisce dopo che yt-dlp ha già scritto `.info.json`/thumbnail (cosa che fa presto nel suo processo), quei file vengono cancellati automaticamente — solo il video/`.part` viene preservato per il resume.
7. **Doppia protezione dedup**: `--download-archive` di yt-dlp come ledger ridondante, ma il catalogo resta la fonte primaria.

## Serving video e player (`packages/server`, M10)

- `express.static()` (via pacchetto `send`) supporta **Range requests**/ETag out of the box, montato da `media/mediaRoutes.js`:
  ```js
  app.use('/media/videos', express.static(paths.videosDir));
  app.use('/media/thumbnails', express.static(paths.thumbnailsDir));
  ```
- `lib/publicVideo.js` costruisce `videoUrl`/`thumbnailUrl` codificando ogni segmento del path (necessario perché `localPath` ora contiene sottocartelle per creator con spazi/caratteri accentati/emoji nel nome).
- Frontend: `<video controls src={videoUrl}>` nativo, sufficiente per mp4/webm/mkv con seek.
- Merge sempre in **MP4** (H.264/AAC) — ffmpeg già presente sulla macchina.

## Pagine frontend (`packages/web`, M11 — direzione visiva "Cinema")

React 19 + Vite + `react-router-dom` (SPA multi-pagina) + `lucide-react` per le icone; nessuna libreria di stato globale (`fetch` + `useState`/`useEffect` per pagina); CSS scritto a mano con i design token della direzione scura scelta dall'utente (vedi mockup `Webapp video catalogo design.zip`, direzione "1b Cinema"). Ogni pagina corrisponde 1:1 a un flusso già esistente nel CLI, stessa logica applicativa (nessuna nuova regola, solo chiamate HTTP a `packages/server`):

- **CatalogPage** (`/`): griglia `VideoCard`, chip di stato (Tutti/Nuovi/In coda/Scaricati/Falliti/Archiviati) invece di categorie editoriali, banner "Scarica in coda (N)".
- **VideoDetailPage** (`/videos/:id`): player nativo per `downloaded`, azioni contestuali allo stato (`decideVideo`) per gli altri, video correlati dello stesso canale.
- **SearchPage** (`/search`): `searchVideos` (M7) con debounce, azioni contestuali sui risultati.
- **ChannelPage** (`/channels/:key`): equivalente di "Guarda" nel CLI.
- **SourcesPage** (`/sources`): "Gestisci fonti" + "Sincronizza" fusi in una vista.
- **SingleDownloadPage** (`/download`): "Scarica video singolo" (M8). Ridisegnata in M24: input sempre presente (nessun redirect, si accodano più download restando sulla pagina), sola barra di avanzamento durante il download (niente box di log), storico sempre visibile sotto (componente condiviso `JobHistory`).
- **JobsPage** (`/jobs`): job in corso con log/progresso live via SSE (bridge sugli eventi di `jobManager`), più storico persistito (`JobHistory`, con cancellazione — M24).
- **LibraryPage** (`/library`): "Libreria" — placeholder vuoto (M23). La vecchia "Riorganizza libreria" è stata ritirata dal web perché strutturalmente non aveva più nulla da spostare; `reorganizeLibrary()` resta come utility core/CLI/API.

## Config (`data/config.json`)

```json
{
  "mediaRoot": "./media",
  "port": 3001,
  "ytdlp": { "binaryPath": "./tools/yt-dlp.exe", "format": "bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]/b", "mergeOutputFormat": "mp4", "maxHeight": null, "cookiesFile": null },
  "playback": { "vlcPath": "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe" },
  "jobs": { "maxAttempts": 3 }
}
```

- `maxHeight: null` → nessun cap di risoluzione (`buildFormatSelector` applica comunque l'esclusione AV1 anche quando un cap è impostato).
- `playback.vlcPath` → percorso dell'eseguibile VLC, usato da `playbackService.js`. **Non esiste un default universale**: su questa macchina VLC è installato nella cartella a 32 bit (`Program Files (x86)`), non quella a 64 bit come si potrebbe assumere — verificarlo per ogni installazione.
- `cookiesFile` (opzionale, `null` di default): se `null`, si usa automaticamente `core/cookies.txt` se esiste; se valorizzato, quel path ha la precedenza. Vedi "Cookie per video privati/non listati" sopra.
- **Le fonti (playlist) non sono più in `config.json`** (M6): vivono in `catalog.sources`, gestite interattivamente dal CLI ("Gestisci fonti") tramite `sourceService.js`. `config.json` resta per le sole impostazioni statiche (percorsi, qualità, VLC, numero massimo di tentativi).
- `data/config.json` contiene dati personali (path locali specifici della macchina) e non va committato: è nel `.gitignore`. `data/config.example.json`, tracciato da git (senza dati personali, con gli stessi default), è il template.

## Modello di stato a flag ortogonali (M25+)

Ripensamento del "punto 1" del progetto (l'area sorgenti + il download), deciso con l'utente. Il modello a **singolo `status` lineare** (`new/pending/downloading/downloaded/failed/excluded`) non sa esprimere stati che nella realtà **coesistono**: un video può essere insieme *presente su YouTube* **e** *scaricato*; *nascosto* è indipendente dall'essere scaricato. Un enum lineare costringe tutto in una casella sola. La soluzione: **smontare `status` in assi separati** sullo schema del video.

```js
presence:  'present' | 'removed'      // presenza su YouTube, aggiornata dalle sync
removedAt: null | ISO                 // quando una sync non l'ha più trovato (presence: 'removed')
download:  'none' | 'downloading' | 'downloaded' | 'failed'   // stato lato server (l'ex pipeline di download)
hidden:    boolean                    // "nascosto": visibile solo in Libreria (sostituisce 'excluded')
```

I flag utente-visibili sono tutti **derivati** da questi assi, senza stati impossibili:

| Flag mostrato | Derivazione |
|---|---|
| Presente su YouTube | `presence === 'present'` |
| Rimosso / non più disponibile | `presence === 'removed'` |
| Scaricato | `download === 'downloaded'` |
| In download / Fallito | `download === 'downloading' \| 'failed'` |
| Nascosto | `hidden === true` |

**Decisioni prese con l'utente (scelte fra le opzioni consigliate):**

1. **Ingest a due fasi.** Aggiungere/aggiornare una sorgente non porta più solo entries leggere: (a) `--flat-playlist` istantaneo → i video compaiono subito con titolo/durata/copertina; (b) un **job in background con progresso** arricchisce i **metadati completi** per-video (una chiamata yt-dlp per video, come un download) e **cacha le copertine in locale** — così un video poi *rimosso* conserva comunque la sua copertina anche quando l'URL YouTube muore (coerente con l'obiettivo di preservazione). Il job emette avanzamento (video N di M) sullo stesso `EventEmitter`/bridge SSE già usato dai download; in `SourcesPage` il pulsante **"Sync"** lancia questo job e mostra una **barra di avanzamento che si riempie fino a fine sync** (riuso dell'infrastruttura `useJobStream`/SSE di M10-M11, nessun meccanismo nuovo).
2. **Niente più `new/pending/excluded` né "Rivedi novità".** Tutto vive in **Libreria** con filtri per flag; *Scarica* e *Nascondi* sono azioni per-video (+ selezione multipla per scaricare in blocco). "Novità" diventa un **filtro derivato** (aggiunti dall'ultimo refresh), non uno stato persistito.
3. **"Rimosso" reattivo e reversibile.** Una sync marca `presence: 'removed'` al **primo** refresh che non trova più il video; se riappare in un refresh successivo torna `present`. File e metadati **mai** cancellati.

**Migrazione dei video esistenti** (una tantum, trasparente al primo avvio, sullo stesso pattern di M24): `downloaded → {present, downloaded}`; `new`/`pending → {present, none}`; `excluded → {present, none, hidden:true}`; `failed → {present, failed}`; `downloading →` resettato a `none` (come già fa la reconciliation all'avvio).

**Limite superato in M41**: lo schema tracciava **una sola** `source` per video — risolto sostituendo `video.source` (oggetto singolo) con `video.sources` (array di etichette, zero/una/più fonti). Con l'arrivo dei canali (punto aperto 4) un video potrà così appartenere a più fonti eterogenee (playlist *e* canale) senza ulteriori cambi di schema.

**Dove vive la logica** (principio ribadito dall'utente, coerente con l'architettura del progetto): ogni funzionalità di queste milestone si costruisce **principalmente nel `core`** — nuovi campi/derivazioni nello schema, ingest a due fasi, detection "rimosso", filtri della libreria come funzioni pure di `videoService`. CLI e web (via `packages/server`) restano **adapter sottili** che chiamano quelle funzioni, senza duplicare regole di stato. Nessuna logica di flag/derivazione va scritta dentro un componente React o dentro `cli.js`.

Consegna **a tappe** (M25→M28). Il client Electron (e il suo asse "locale") è fuori da questo giro; lo schema resta comunque estendibile per aggiungerlo quando si affronterà quel lato.
