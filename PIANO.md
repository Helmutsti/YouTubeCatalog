# Catalogo video YouTube locale (archivio personale)

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
- **Qualità**: massima qualità disponibile, nessun cap di risoluzione (merge in MP4 tramite ffmpeg).
- **Playlist iniziale**: da configurare dall'utente una volta che il CLI è pronto (M6).
- **Documentazione continua**: `CLAUDE.md` con l'istruzione permanente che ogni milestone completata va documentata in `documentazione.md` (decisioni + logica costruttiva, non un changelog).

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
  CLAUDE.md                      # istruzioni permanenti per il lavoro futuro su questo repo
  documentazione.md              # log delle decisioni di progetto, aggiornato milestone per milestone
  PIANO.md                       # questo file: la specifica tecnica di riferimento
```

## Documentazione continua (CLAUDE.md + documentazione.md)

`CLAUDE.md` contiene questa istruzione permanente:

> Al termine dell'esecuzione di una parte del piano, questo deve confluire in un file `documentazione.md` dove vengono esplicitate le decisioni del progetto e come è stato costruito.

In pratica: ogni volta che una milestone viene completata, prima di passare alla successiva va aggiunta una sezione a `documentazione.md` che racconta **cosa è stato costruito, quali decisioni tecniche sono state prese e perché** (non un changelog di commit, ma la logica dietro le scelte). `documentazione.md` cresce in modo incrementale, diventando nel tempo la documentazione di riferimento del progetto — complementare a questo file (`PIANO.md`), che resta la fotografia della progettazione iniziale e non va aggiornato milestone per milestone (se un requisito cambia sostanzialmente, va invece aggiornato qui e la decisione spiegata in `documentazione.md`).

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

**Migrazione dell'archivio reale eseguita**: tutti i video già scaricati dall'utente sono stati riorganizzati nel layout per creator (52 spostati, verificato nessun file rimasto nel vecchio formato piatto, funzionamento confermato end-to-end su CLI/server con i file reali). Dettagli e verifica in `documentazione.md`.

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

**Limite pre-esistente da tenere presente**: lo schema traccia **una sola** `source` per video. Con l'arrivo dei canali (punto aperto 6) un video potrà appartenere a playlist *e* canale insieme, e la detection "rimosso" andrà ripensata come "non trovato in **nessuna** delle sue fonti". Fuori da questo giro, ma esplicitato.

**Dove vive la logica** (principio ribadito dall'utente, coerente con l'architettura del progetto): ogni funzionalità di queste milestone si costruisce **principalmente nel `core`** — nuovi campi/derivazioni nello schema, ingest a due fasi, detection "rimosso", filtri della libreria come funzioni pure di `videoService`. CLI e web (via `packages/server`) restano **adapter sottili** che chiamano quelle funzioni, senza duplicare regole di stato. Nessuna logica di flag/derivazione va scritta dentro un componente React o dentro `cli.js`.

Consegna **a tappe** (M25→M28). Il client Electron (e il suo asse "locale") è fuori da questo giro; lo schema resta comunque estendibile per aggiungerlo quando si affronterà quel lato.

## Milestone di implementazione e verifica

| # | Milestone | Verifica |
|---|---|---|
| M0 ✅ | Spostare `yt-dlp.exe` in `tools/yt-dlp.exe`; confermare ffmpeg; scaffolding cartelle + `package.json` workspaces (`core` a livello radice, `cli`/`server`/`web` come package vuoti sotto `packages/`); creare `CLAUDE.md`, `documentazione.md`, `PIANO.md`. | `.\tools\yt-dlp.exe --version` e `ffmpeg -version` funzionano; struttura cartelle e i file di documentazione esistono. |
| M1 ⏭️ | *Assorbita*: lo script usa-e-getta previsto è stato sostituito da un test diretto delle vere funzioni di `core` (vedi M2-M5) — nessun file `scripts/testDownload.mjs` separato. | — |
| M2 ✅ | `core`: `catalogStore.js` (mutex, scrittura atomica, reconciliation `downloading → pending` all'avvio) + `catalogSchema.js` con l'enum di stato completo (`new/pending/downloading/downloaded/failed/excluded`). | Scritture concorrenti simulate senza corruzione; kill mid-write + restart ripristina correttamente. |
| M3 ✅ | `core`: `ytdlpWrapper.js` (incluso il supporto a `core/cookies.txt` se presente) + `sourceProviders/playlistProvider.js` + `syncService.syncSource()` (nuove entry `new`, auto-guarigione, `excluded` invariati). | Contro una playlist pubblica reale: nuove entry `new` corrette, nessun duplicato, nessuna `excluded` toccata. |
| M4 ✅ | `core`: `jobManager.js` (coda + EventEmitter + persistenza) + job `downloadPending`/`downloadSingle` + `decisionService.decideVideo()`. | Da uno script/test Node: `decideVideo` sposta `new → pending`; `downloadPending` scarica davvero un video pubblico e transita `pending → downloading → downloaded`; id non valido → `failed` + `attempts++`. |
| M5 ✅ | `core`: `playbackService.js` (spawn VLC). | Verificata la logica (risoluzione path, controlli di esistenza); l'apertura effettiva di VLC non è stata eseguita in automatico per non aprire un'app grafica senza conferma esplicita dell'utente. |
| M6 ✅ | `packages/cli/cli.js`: menu a frecce (`@inquirer/prompts`) — Gestisci fonti, Sincronizza, **Rivedi novità** (vista unica: revisione + coda + download, "Scarica in coda" nidificato qui), **Importa video già scaricati**, Guarda, Catalogo, Esci. Nuovo `sourceService.js` (sourcelist multi-playlist in `catalog.sources`), `importService.js` (import di video scaricati fuori dal tool), `listChannels`/`listVideosByChannel`, `playVideo` con modalità video/audio, metadati grezzi consolidati in `data/metadata.json` (`metadataStore.js`/`metadataService.js`, niente più `.info.json` sparsi accanto ai video). | Verificato con la playlist reale dell'utente: `addSource` (titolo recuperato, dedup), `syncSource`, download reale (dopo il fix `--js-runtimes node` + esclusione AV1), `listChannels`/`listVideosByChannel`, `playVideo` in entrambe le modalità (VLC aperto per davvero), `removeSource`, importazione di 49 video già scaricati manualmente dall'utente (rinominati ai rispettivi id tramite l'ordine grezzo della playlist), migrazione dei metadati grezzi in `data/metadata.json` (49 file, 23MB → 8.26MB), tutti i casi d'errore previsti. La navigazione a frecce vera e propria non è testabile in automatico — verificata solo l'assenza di errori all'avvio; l'utente l'ha provata di persona. |
| M7 ✅ | Motore di ricerca nel CLI: `core/src/services/searchService.js` (`searchVideos`, fuzzy scritto a mano — finestra scorrevole + distanza di Levenshtein su titolo/canale/tag, sottostringa esatta su descrizione — nessuna dipendenza esterna) + nuova voce menu "Cerca" (prompt `search` di `@inquirer/prompts`, azioni contestuali allo stato del risultato). | Ricerca reale contro il catalogo dell'utente: titolo con typo, nome canale con typo, termine generico con molti risultati, query senza corrispondenze. |
| M8 ✅ | `core`: nuovo `services/singleVideoService.js` (`prepareSingleVideoDownload(url)` — risolve id/titolo/canale/extractor con **yt-dlp stesso** (`resolveVideoInfo()`, nuovo in `ytdlpWrapper.js`), non con un regex specifico di YouTube: qualunque sito supportato da `yt-dlp.exe` funziona, non solo YouTube. Riusa il job `downloadSingle` già esistente; se l'id non è nel catalogo crea uno stub con `source: { sourceId: null, type: 'single' }` così non è mai toccato da nessuna sync di playlist, poi scarica subito; se è già `downloaded`/`downloading` informa senza agire; se è già tracciato con un altro stato tramite una fonte, rifiuta e rimanda a "Rivedi novità"). Corretto `ytdlpWrapper.downloadVideo()` (scaricava sempre da un URL YouTube ricostruito dall'id, ora accetta l'URL reale) e il format selector di default (l'esclusione AV1, un workaround specifico di YouTube, escludeva l'unico formato disponibile su altri siti — aggiunto un fallback finale senza filtro). `packages/cli/cli.js`: nuova voce menu "Scarica video singolo" (dopo "Gestisci fonti"), log/progress live come "Scarica in coda". | URL YouTube (`watch?v=`, `youtu.be/`, `shorts/`, id nudo) e non-YouTube (verificato con Rumble) → download reale end-to-end e comparsa in "Guarda"/"Catalogo"; URL con `list=` → scarica solo quel video, nessuna fonte creata in `catalog.sources`; id già `downloaded` → messaggio, nessun ri-download; id già tracciato `new`/`pending`/`failed`/`excluded` → rifiutato con messaggio che rimanda a "Rivedi novità"; URL non valido o playlist/canale → errore chiaro, nessun crash. |
| M9 ✅ | Rimozione di "Importa video già scaricati": era uno script di migrazione una tantum (introdotto in M6 per i 49 video già scaricati manualmente prima di adottare il tool), non una funzionalità duratura. Rimuovere `core/src/services/importService.js` (`scanImportable`, `importLocalVideo`) e i relativi export da `core/src/index.js`; rimuovere `fetchMetadata()` da `core/src/ytdlp/ytdlpWrapper.js` (unico chiamante era `importLocalVideo`; `hashFileSha256`/`getYtdlpVersion`/`mapInfoJsonToVideoFields` restano, condivise con `downloadVideo()`); rimuovere dal CLI la voce menu "Importa video già scaricati" e `importFlow()`. Nessun impatto sui 49 video già importati in M6: restano entry `downloaded` regolari nel catalogo, indipendenti dal codice che li ha creati. | Il menu principale non mostra più la voce; nessun riferimento residuo a `importService`/`scanImportable`/`importLocalVideo`/`fetchMetadata` nel repo; i 49 video importati in M6 restano intatti e `downloaded` nel catalogo. |
| M9.1 ✅ | Reset della schermata CLI: `clearScreen()`/`setMessage()` condivisi in `packages/cli/cli.js`, applicati a ogni ciclo menu/sottomenu (vedi "Reset della schermata CLI" sopra). | `node --check` passa; avvio reale del CLI senza errori. Navigazione interattiva confermata dall'utente. |
| M9.2 ✅ | Archivio canonico per creator: nuovo template `-o` di yt-dlp per i download futuri, `core/src/services/libraryService.js` (`reorganizeLibrary`) per migrare l'archivio esistente (vedi "Archivio canonico per creator" sopra). CLI: voce menu "Riorganizza libreria" (dry-run → conferma → esecuzione). | Test unitario del sanitizer e test d'integrazione dry-run/esecuzione/idempotenza su dati sintetici; **migrazione reale dell'archivio dell'utente eseguita** (52 file spostati, verificato nessun residuo nel vecchio layout, `listVideos`/`listChannels`/`searchVideos`/server tutti funzionanti sui path reali post-migrazione). Dettagli in `documentazione.md`. |
| M10 ✅ (era M8) | `packages/server`: thin wrapper Express attorno a `@catalog/core` (routes `videos`/`sources`/`jobs`/`library`, bridge SSE sugli eventi di `jobManager`, static serving media con Range requests via `mediaRoutes.js`, `lib/asyncRoute.js` + `lib/publicVideo.js`). | Server avviato realmente contro i dati reali dell'utente: endpoint di lettura, ricerca, canali, sorgenti, media (Range → `206`) tutti verificati; percorsi di errore verificati senza mutare i dati reali. |
| M11 ✅ (era M9) | `packages/web`: SPA React 19 + Vite + `react-router-dom` + `lucide-react`, direzione visiva "Cinema" (scura) scelta dall'utente tra due mockup proposti — 8 pagine: `CatalogPage`, `VideoDetailPage`, `SearchPage`, `ChannelPage`, `SourcesPage`, `SingleDownloadPage`, `JobsPage`, `LibraryPage` (vedi "Pagine frontend" sopra). | Build di produzione senza errori; navigazione reale nel browser su tutte le pagine con i dati reali dell'utente; layout mobile verificato; bug reale trovato e corretto (badge di stato mal posizionato in `SearchPage`). |
| M12 ✅ | Rifinitura: dettaglio errori + retry sia da CLI che da web (aggiunto in `VideoDetailPage` il blocco errore per i video `failed`, mancante rispetto al CLI), QA sui casi limite (azioni di decisione dal web, aggiunta/sincronizzazione fonte dal web, job di download reale con SSE dal vivo, esecuzione reale di "Riorganizza libreria" dal web). | Verificato end-to-end con dati di test creati e ripuliti appositamente: ciclo completo di decisioni (`new→pending→new→excluded`) da dettaglio e card, dettaglio errore + Riprova su un video fallito, "Aggiungi fonte"/"Sincronizza tutte" reali, download reale con log SSE dal vivo ("Me at the zoo"), riorganizzazione libreria reale dal pulsante web. "Rimuovi fonte" verificata solo via endpoint diretto (usa `window.confirm`, dialogo nativo bloccante, non cliccato dall'automazione browser). Dettagli in `documentazione.md`. |
| M14 ✅ | Foto profilo reali dei canali (invece dell'iniziale generica): nuovo `catalog.channelAvatars` (`data/catalog.json`), `core/src/services/channelAvatarService.js` (`syncChannelAvatars({force})` — nuova interrogazione yt-dlp sull'URL del canale, mai fatta finora nel progetto, perché i metadati per-video non contengono l'avatar; download immagine con `fetch` nativo, cache in `media/avatars/`), esposta via `POST /api/channels/avatars/sync` e mostrata in sidebar/card/dettaglio/pagina canale della web GUI (CLI fuori scope, testuale). Ambito: solo canali con almeno un video scaricato. Aggiornamento: non fisso, ri-scaricabile manualmente (pulsante + opzione "forza" in `SourcesPage`). | Interrogazione yt-dlp reale su un canale per fissare la shape JSON dell'avatar; sync reale sul catalogo dell'utente (7 canali); verifica visiva nei 4 punti UI incluso il canale senza id (`GinaCarla`, fallback su nome); idempotenza (`force:false` due volte → 0 nuovi fetch la seconda); force refetch senza file orfani; un errore su un canale non blocca gli altri. Rumble (`GinaCarla`) verificato non risolvibile via yt-dlp (l'estrattore `RumbleChannel` non espone l'avatar) — foto impostata manualmente dall'utente, stesso meccanismo di cache. |
| M15 ✅ | Rinominare "canali" in "creator" — **solo testo visibile** (etichette CLI + web), su scelta esplicita dell'utente: nomi di variabili/funzioni (`channelKey`, `listChannels`...), schema dati (`video.channel`), endpoint API (`/api/channels`) e classi CSS (`.chan-avatar`, ecc.) restano tutti invariati. | Build web pulita, `node --check` su `cli.js`, verifica visiva nel browser (sidebar "CREATOR", placeholder ricerca), nessuna stringa "canale/canali" residua nel codice utente-visibile (verificato con ricerca nel repo — solo commenti, intenzionalmente non toccati). |
| M16 ✅ | Due funzionalità mirate ritagliate dai punti aperti 4 e 9 (non l'analisi completa di entrambi — vedi sotto cosa resta aperto): **Picture-in-Picture** rapido (`VideoDetailPage`, pulsante accanto a "Solo audio", API nativa `requestPictureInPicture`/`exitPictureInPicture`, sincronizzato anche se l'utente chiude la finestra PiP dall'OS) e **copertina "clicca per riprodurre" in stile Rumble** per i video `downloaded` mai avviati (thumbnail + tasto play grande sopra il player, sparisce per sempre al primo `play` — non ricompare in pausa — grazie a `preload="metadata"` + `onPlay`, non a un `poster` nativo da solo). | Verificato nel browser reale: click sulla copertina → riproduzione avviata, copertina sparita, nessuna ricomparsa in pausa; PiP entra/esce correttamente con sincronizzazione del pulsante; **due bug reali trovati e corretti in fase di verifica**: (1) l'errore PiP riusava lo stato `error` a piena pagina, cancellando l'intero player invece di un avviso — separato in uno stato `pipError` dedicato; (2) `requestPictureInPicture()` falliva se cliccato prima di aver mai avviato il video (metadati non caricati) — corretto con `preload="metadata"` + attesa di `loadedmetadata` con timeout di sicurezza. |
| M17 ✅ | Rebrand: nuovo nome **"Ondo"** e nuovo logo (pacchetto SVG fornito dall'utente in `loghi.zip` — wordmark, icona, app icon, dark/light — copiati in `packages/web/public/`), sostituendo il testo "CINÉ." nella topbar con l'SVG del wordmark e aggiungendo un favicon vero (mai esistito prima). Colore d'accento allineato dall'arancione al blurple del logo (`--accent: #9184d9`). Su scelta esplicita dell'utente, il font dei titoli è stato allineato a quello del logo (Sora, al posto di Space Grotesk) in tutta l'interfaccia — **risolve di riflesso anche il punto 6** del backlog. | Build di produzione pulita; verifica visiva reale nel browser: titolo scheda "Ondo", favicon caricato (`200`, `image/svg+xml`), logo/wordmark renderizzato correttamente in Sora, colore d'accento confermato via `getComputedStyle` e verificato visivamente su un pulsante primario reale. CLI non toccata (nessun riferimento al brand testuale). |
| M18 ✅ | Velocità di riproduzione in `VideoDetailPage`: pulsante accanto a "Picture in Picture" che cicla `1x → 1.25x → 1.5x → 1.75x → 2x → 2.5x → 3x → 3.5x → 4x → 0.25x → 0.5x → 0.75x → …` (fino a 4x, come YouTube Premium) impostando `video.playbackRate` via `ref`, si resetta a 1x a ogni cambio video. Analizzati insieme a questo anche i **sottotitoli**: fattibili ma **non voluti ora** dall'utente — restano come idea documentata nei "Punti aperti" con i risultati della ricerca già fatta (sottotitoli manuali quasi sempre assenti nel catalogo reale, servirebbero quelli automatici di YouTube). | Verificato nel browser reale con click veri: il pulsante cicla correttamente le velocità fino a 4x, `video.playbackRate` combacia sempre con l'etichetta mostrata (controllato via `document.querySelector('video').playbackRate`), reset a 1x confermato passando a un altro video. |
| M19 ✅ | **Filtro + ordinamento in Home e pagina canale**. Nuovo `lib/sort.js` condiviso (`SORT_OPTIONS`/`sortVideos`, tutto client-side — i video sono già interamente caricati, nessuna modifica server): data aggiunta al catalogo (più recenti prima), data di pubblicazione originale su YouTube, durata, titolo (A-Z), per stato con priorità `STATUS_PRIORITY` (falliti → in download → in coda → nuovi → scaricati → archiviati, nuova costante in `lib/status.js`). Filtro per canale aggiunto solo in `CatalogPage` (Home), derivato dai video già caricati (non da `listChannels()`, che di default considera solo i `downloaded` — qui serve vedere anche i "nuovi" di un canale specifico). | Verificato nel browser reale: filtro per canale su "Sampurna ASMR" → esattamente 1 risultato (atteso); ordinamento per titolo → ordine alfabetico corretto sui primi 5 risultati; dropdown presenti e funzionanti sia in Home sia in pagina canale. |
| M20 ✅ | **Storico job: thumbnail del video + dettaglio errore**. `downloadPendingJob` esteso per salvare `summary.results: [{id, status}]` (prima solo `{downloaded, failed, total}`, nessun dettaglio per-video). Nuovo `packages/server/src/lib/publicJob.js` (`toPublicJob`/`toPublicJobs`) arricchisce ogni job con `thumbnails` (fino a 4, riusando `toPublicVideo`) e `thumbnailsMore`: per `downloadSingle` da `params.videoId` (sempre disponibile, a costo zero); per `downloadPending` dai primi 4 id con esito `downloaded` in `summary.results`. Job più vecchi di questa modifica restano senza thumbnail per i batch (nessun `results` salvato all'epoca), coerente con "solo i job futuri" già scelto per pattern simili (M14). Dettaglio errore promosso dalla vista espansa alla riga collassata per i job falliti. | Verificato con job fittizi scritti direttamente in `data/jobs/` (nessun download reale necessario, stessa logica di arricchimento indipendentemente da come il job è stato creato) referenziando id reali già scaricati: risposta API confermata via `fetch` diretto (`thumbnails: 4, thumbnailsMore: 2` su un batch di 6 con 1 fallito — cap e conteggio esatti) e verifica visiva nel browser (4 miniature + "+2 altri" per il batch, thumbnail + errore in rosso visibile senza espandere per il singolo fallito). Job di test rimossi al termine. |
| M21 ✅ | **Dati tecnici del video** in un box a fine descrizione in `VideoDetailPage`, stessa classe `.d-desc` già usata per il box "Descrizione". Nuovi helper `formatBytes`/`formatBitrate` in `lib/format.js`. Campi mostrati: risoluzione (+ fps se presente), codec video/audio, bitrate, dimensione file, formato, versione yt-dlp — `sha256` escluso su conferma esplicita dell'utente. Solo i campi con un valore vengono mostrati (nessun "undefined" in caso di dati mancanti). | Verificato nel browser reale su un video scaricato: box "Dati tecnici" mostrato correttamente sotto la descrizione, valori reali e formattati (`1920×1080 · 30fps`, `2.4 Mbps`, `183.4 MB`, ecc.), stile visivamente identico al box descrizione come richiesto. |
| M22 ✅ | **Fix del falso positivo "da spostare" in "Riorganizza libreria"**: causa reale trovata sul catalogo dell'utente — yt-dlp sanifica i titoli a modo suo (es. `\|` → `｜`, pipe a tutta larghezza), diverso dal sanitizzatore proprio del progetto (`sanitizeName()` in `libraryService.js`), quindi ogni video con caratteri non validi su Windows nel titolo veniva rimarcato "da spostare" a ogni download, pur essendo già nella cartella creator corretta. Su decisione esplicita dell'utente ("teniamo il titolo generato da yt-dlp, non dobbiamo più allineare nessun video"): `reorganizeLibrary()` ora considera un file "già a posto" con un criterio strutturale (`isAlreadyOrganized()` — già in una sottocartella creator + marker `[<id>]` nel nome), non più per confronto esatto col path ricalcolato da `targetRelPath()`; il nome scelto da yt-dlp non viene più "corretto" per farlo combaciare col sanitizzatore del progetto. `targetRelPath()` resta solo il nome di ripiego per i file ancora piatti (vecchio layout). GUI web: nessuna modifica necessaria, mostrava già il titolo originale (`video.title`) ovunque. CLI: nuovo helper `displayTitle(video)` in `cli.js` — normalmente il titolo originale, con ripiego sul titolo derivato dal nome file (quello di yt-dlp) se assente, invece del solo id. | Verificato sul catalogo reale dell'utente: il video `Gq4aN6KnJoE` (titolo con `\|`), unico "da spostare" prima del fix, ora è correttamente conteggiato tra i 63 "già a posto" (`reorganizeLibrary({dryRun:true})` → `moved:0, planned:[]`). Verificato nel browser reale (`/library`): banner "0 da spostare · 63 già a posto". Verificato `/videos/Gq4aN6KnJoE`: titolo mostrato con il `\|` normale originale, non il `｜` del filename. `displayTitle()` verificato in isolamento per i 3 casi (titolo presente, titolo assente con ripiego sul filename, nessuno dei due). `node --check` su `cli.js`/`libraryService.js`. |
| M23 ✅ | **Pagina "Libreria" svuotata** (ritiro di "Riorganizza libreria" dal web): dopo la migrazione M9.2 + il criterio strutturale M22, la lista "da spostare" è sempre vuota (nuovi download già nel layout canonico), quindi la sezione era codice morto. Su decisione dell'utente la pagina web `/library` è svuotata e rinominata "Libreria" (placeholder per uso futuro, slot navigazione/rotta conservati), icona sidebar `Wrench` → `Library`, label "Riorganizza libreria" → "Libreria". Funzione core `reorganizeLibrary()`, endpoint `POST /api/library/reorganize` e voce CLI **invariati** (utility di manutenzione, direttiva limitata al web). | Build di produzione web pulita; `Library` confermata export reale di lucide-react; nessun riferimento residuo a `Wrench`/"Riorganizza" nel codice web. Verifica visiva browser non eseguita (nessuno strumento di automazione browser in sessione — dichiarato apertamente). Dettagli in `documentazione.md`. |
| M24 ✅ | **Punto 6 del backlog: storico dei download sempre visibile + cancellazione job + storage consolidato.** (1) `core/jobs/jobManager.js`: nuove `deleteJob(id)`/`clearJobs()` (cancellano solo il record storico — video/file su disco intatti; un job `running`/`queued` non è cancellabile, nessun abort). (2) Storage migrato da "un file per job" (`data/jobs/<id>.json`) a **file unico `data/jobs.json`** (scrittura atomica tmp+rename, tutto in memoria, migrazione una tantum trasparente al primo avvio che consolida e rimuove i vecchi file), su richiesta dell'utente. (3) Server: `DELETE /api/jobs/:id` + `DELETE /api/jobs`. (4) `publicJob.js` arricchisce anche col `title` del video (downloadSingle). (5) Web: nuovo componente condiviso `components/JobHistory.jsx` (storico con copertina video a tutta altezza + titolo, cestino per riga sui terminati, "Svuota storico"), usato da `JobsPage` e da `SingleDownloadPage`; quest'ultima ridisegnata: **input sempre presente** (niente redirect, si accodano più download), **sola barra di avanzamento** durante il download (niente box di log), **storico sempre sotto**. | Migrazione reale eseguita e verificata: 23 job per-file → `data/jobs.json` (23 job, 0 file residui, 0 malformati, conteggio invariato). `deleteJob` su terminato → file/record rimosso; su `running` → rifiutato con messaggio chiaro; conteggio job invariato dopo il test. Arricchimento su dati reali via `toPublicJobs(listJobs())`: `downloadSingle` con titolo+copertina reali, `downloadPending` batch → ripiego sul label del tipo. Build web pulita. Verifica visiva browser non eseguita (nessuno strumento di automazione in sessione). ⚠️ Il server già in esecuzione va riavviato per caricare il nuovo codice e `jobs.json`. Dettagli in `documentazione.md`. |
| M25 ✅ | **Modello di stato a flag ortogonali + migrazione** (vedi sezione dedicata sopra). **Lavoro principalmente nel `core`**: smontato l'unico `status` in `presence`/`download`/`hidden` + `removedAt` in `catalogSchema.js`/`createNewVideoStub`; adeguati `catalogStore` (reconciliation `downloading→none` + migrazione una tantum), `decisionService` (`decideVideo`→`setVideoHidden`), `videoService.listVideos` (filtri per flag come funzioni pure), i job (`downloadPending` ora su lista esplicita `videoIds`), `singleVideoService` (opzione `download`), `playbackService`/`libraryService`/`syncService`/`channelAvatarService`. Derivazione `videoCategory` esposta dal core e consumata dagli adapter: server (`publicVideo.category`, `POST /videos/:id/hidden`), web (`lib/status.js` per categorie, `actionsFor`, card/badge/chip/pagine), CLI (`cli.js`). | ✅ Catalogo reale migrato: 64/64 video, 0 residui `status`, stessi id, 3 sorgenti intatte, conteggi invariati; API server (istanza di test :3002) porta `category`+flag; `setVideoHidden`/`download-single {download:false}` verificati; build web pulita, `node --check` su tutti i file toccati. UI browser a stack completo non verificata (server utente occupava :3001 con codice pre-M25). Dettagli in `documentazione.md`. ⚠️ Il server/CLI in esecuzione va riavviato. |
| M26 ✅ | **Ingest a due fasi con metadati completi.** Nel `core`: `addSource`/`syncSource` restano la fase 1 istantanea (flat-playlist); nuovo job `enrichSource` (fase 2) estrae i metadati completi per-video (`ytdlpWrapper.fetchVideoMetadata`, `--skip-download`) e cacha le copertine in `media/thumbnails/`, con avanzamento sull'`EventEmitter`. Nuovo campo `enrichedAt` (idempotenza). Adapter: server (`POST /sources` e `/sync` tornano un `jobId`), web (`SourcesPage` mostra la **barra di avanzamento** via `useJobStream`), CLI (`enrichAfterIngest` con log live). | ✅ Arricchimento reale su "Me at the zoo": stub `present/none` → metadati completi + copertina jpg su disco + `data/metadata.json`, `download` resta `none`, idempotente, cleanup completo (catalogo tornato a 64). `enrichSource` via job manager ok. Build web pulita, `node --check` ok. Click reale sul Sync nel browser da confermare dopo il riavvio del server. Dettagli in `documentazione.md`. |
| M27 ✅ | **Detection "Rimosso" nel refresh.** In `syncService.ingestPlaylistEntries`: sweep dei video della fonte non più tra gli entries → `presence:'removed'` + `removedAt` (non tocca `download` né i file); ripristino reversibile alla ricomparsa. Ritorna `removedCount`/`restoredCount`, esposti in CLI/web. | ✅ Test unitario su catalogo sintetico: rimozione con `removedAt`; **un video scaricato poi rimosso mantiene `download:'downloaded'`, `localPath` e il file su disco**; ricomparsa → `present`, `removedAt:null`. Verifica su una playlist reale che perde un video: da confermare dall'utente. Dettagli in `documentazione.md`. |
| M28 ✅ | **Pagina "Libreria".** `LibraryPage` ora è la vista centrale: chip categoria (`StatusChips`) + dropdown creator + dropdown sorgente (`listSources` + "Singoli"), ordinamento (`lib/sort.js`), azioni per-video (`actionsFor`), e **selezione multipla** (`VideoCard` esteso con checkbox) → "Scarica selezionati" via `triggerJob('downloadPending', {videoIds})`. "Novità" = filtro categoria "Su YouTube". | ✅ Download in blocco via job manager verificato (id già scaricati → skippati, `total:0`); `listSources` ok; build web pulita. Verifica browser nella sessione combinata finale (server utente occupa :3001). Dettagli in `documentazione.md`. |
| M29 ✅ | **Aggiunta rapida in Libreria + riorganizzazione navigazione.** Form "incolla un link" + checkbox **"Download immediato"** in testa alla `LibraryPage`: on → `downloadSingle(url,true)` (job + barra inline); off → `downloadSingle(url,false)` → `added` (stub `present/none`, nessun download). Nuova `HistoryPage` (`/history`, "Cronologia", solo `JobHistory`); `SingleDownloadPage` rimossa. Sidebar: "Scarica video" → rimossa, "Cronologia" (icona `History`) aggiunta in basso; `MobileNav` "+" → `/library`. | ✅ Core `download:false` (→ `added`, stub `present/none`) verificato in M26; build web pulita, nessun riferimento residuo a `/download`. Verifica browser nella sessione combinata finale. Dettagli in `documentazione.md`. |
| M30 ✅ | **Chiedere "Vuoi tenere il video?" quando si nasconde un video scaricato.** Core `deleteVideoFile(id)` (cancella solo il file + cartella creator vuota, `download→none`, azzera i campi del file; entry/metadati/copertina restano; rifiuta i non-scaricati). Adapter: server `DELETE /videos/:id/file`; web hook condiviso `useHideWithPrompt` (modale Annulla/Cancella il file/Tieni il video) usato da Libreria/Home/Cerca/Dettaglio; CLI `confirm` in `applyReviewDecision`. | ✅ Test reale su video fittizio: `deleteVideoFile` cancella file+cartella vuota, `download:'none'`, **entry+titolo+copertina conservati in libreria**; guardia sui non-scaricati; cleanup a 64. `node --check` + build web ok. Modale browser nella sessione combinata (senza cliccare "Cancella" su dati reali). Dettagli in `documentazione.md`. |
| M31 ✅ | **Riorganizzazione UI e navigazione (flag-first).** (1) **Menu ⋮** su tutte le card (`VideoCard`) al posto dei pulsanti inline: *Scarica video* / *Archivia*↔*Ripristina* (contestuale) / *Mostra profilo*. (2) **Home** = libreria attiva (esclude gli archiviati): chip *Tutti/Da scaricare/Falliti* + filtri creator, **sorgente**, ordinamento. (3) **Sorgenti** = hub di ingresso: input intelligente (playlist→nuova fonte, singolo→aggiungi/scarica con *Download immediato*) + **storico download** in fondo. (4) **"Libreria" → "Archiviati"**: solo i nascosti, **copertine b/n**. (5) Pagina **"Cronologia" rimossa**; la Cronologia mostra solo job di **download** (gli `enrichSource` sono nascosti). (6) `listChannels`/`listVideosByChannel` di default = **tutti** i video (creator visibili anche senza scaricati); avatar sync esteso a tutti i creator + eseguito **automaticamente** a fine `enrichSource`. | Build web pulita; `node --check` core; `/api/channels` 10 creator (incluso quello con soli "disponibili"); Cronologia filtra gli `enrichSource`. Verifica visiva browser: a carico dell'utente (server utente su :3001). Dettagli in `documentazione.md`. |
| M32 ✅ | **Rifiniture UX (rimozione con grazia, menu ⋮ esteso, badge a pallino, tasto archivia defilato).** (1) **"Rimosso" con periodo di grazia**: `syncService` marca `removed` solo dopo **2 sync consecutive** di assenza (`missCount`), reversibile. (2) Menu ⋮: **"Aggiorna metadati"** (`refreshVideoMetadata`, anche sui rimossi come ri-verifica: ripristina se torna, non tocca se confermato rimosso) e **"Cancella video"** (= `deleteVideoFile`: cancella solo il file, metadati/copertina restano; nascosto sui rimossi). (3) **Badge a pallino**: scaricato = nessun badge, *Su YouTube* verde, *rimosso* arancione, *errore* rosso — indipendente dal flag nascosto. (4) Pagina video: tasto **Archivia** spostato a sinistra, **rosso mattone**, con conferma (modale per gli scaricati); placeholder "non disponibile" con **copertina scura** (via le bande oblique). | Test unitario del periodo di grazia (miss1→presente, miss2→rimosso, ricompare→ripristinato); build web pulita; `node --check` core; server riavviato. Verifica visiva browser a carico dell'utente. Dettagli in `documentazione.md`. |
| M33 ✅ | **Titolo della scheda del browser dinamico** (ex punto 9). Nuovo hook `hooks/useTitle.js` (`"<contesto> · Ondo"`, ripristina "Ondo" all'uscita); applicato alle pagine: dettaglio → titolo video, Home/Sorgenti/Archiviati/Job → nome pagina, Cerca → `"Cerca: <query>"`, creator → nome creator. | Build web pulita; hook chiamato sempre prima dei return condizionali (regole dei hook rispettate). |
| M34 ✅ | **Foto profilo del creator più grande** (ex punto 11). Ingrandito **solo** l'avatar nella **pagina creator** (`.chan-avatar` 84→108px, font 30→40); sidebar/card/dettaglio **invariati** (correzione dopo un primo bump generalizzato: l'utente voleva solo la pagina creator). | Build web pulita; solo CSS. |
| M36 ✅ | **Backup e ripristino del catalogo in `.zip`** (ex punto 2 del backlog). **Core** (senza dipendenze esterne, come da invariante del progetto): nuovo `core/src/lib/zip.js` — scrittura/lettura ZIP scritte a mano (deflate via `zlib` nativo + CRC-32, header locali + central directory + EOCD); nuovo `core/src/services/backupService.js` — `createBackup()` impacchetta in memoria `catalog.json` + `metadata.json` + `jobs.json` (whitelist esplicita: **niente** `config.json`, specifico della macchina, né `cookies.txt`, sensibile) e `restoreBackup(zipBuffer)` che valida (catalog.json obbligatorio + JSON validi), **copia i file attuali in `data/pre-restore-<timestamp>/`**, poi sostituisce atomicamente (tmp+rename) solo i file in whitelist presenti nello zip (mai un nome arbitrario preso dallo zip). Ritorna `{ restored, backedUp, safetyDir, requiresRestart:true }`. **Adapter**: server (`GET /api/backup` → download `application/zip`; `POST /api/backup/restore` con corpo zip grezzo via `express.raw`), web (nuova pagina **"Impostazioni"** `/settings`: "Scarica backup .zip" + "Ripristina da file…", con avviso di riavvio), CLI (voce menu "Backup / Ripristino": salva/legge lo zip da un percorso su disco). Il ripristino **richiede il riavvio** del processo (config e store sono cache in-memory, mai ricaricate a caldo). NB: lo spostamento della cartella `media/` fuori dal progetto è un punto separato (rimandato). | Round-trip del core byte-per-byte identico su catalog+metadata+jobs reali (10,7 MB → ~1,1 MB zip); **interoperabilità confermata** (`unzip -l`/`-t` legge l'archivio, CRC corretti, file estratti identici agli originali); endpoint reali su istanza di test `:3002` — `GET /api/backup` `200 application/zip` con `Content-Disposition` corretto, `POST /api/backup/restore` `200` con copia di sicurezza creata e file ripristinati; **dati reali integri** (74 video, 4 sorgenti) e residui di test ripuliti (cartella `pre-restore-*` e script rimossi, nessun `.restore-tmp`); build web pulita; `node --check` su tutti i file. UI della pagina Impostazioni non verificata nel browser (automazione non raggiungeva il dev server locale). ⚠️ Il server/CLI in esecuzione va riavviato per esporre gli endpoint/menu nuovi. Dettagli in `documentazione.md`. |
| M35 ✅ | **Box "Stato e sincronizzazione" nel dettaglio video** (ex punto 13). Sotto i dati tecnici, un riquadro con: presenza (Su YouTube/Rimosso + data), stato download, archiviato, ultimo aggiornamento metadati, sorgente; e i pulsanti **Scarica metadati** (`refreshVideoMetadata`) e **Archivia**/**Ripristina** — il tasto Archivia è stato **spostato qui** dalla riga defilata sopra (M32). | Build web pulita; `handleAction('metadata')` collegato a `refreshMetadata`; verifica visiva a carico dell'utente. |

Lo stato corrente del catalogo dell'utente (numero di video, fonti configurate, cosa è `pending`/`downloaded`) non è tracciato qui — cambia continuamente ed è per natura un dato, non una decisione di progetto. Per lo stato più recente vedi `documentazione.md` (aggiornato milestone per milestone) o interroga direttamente `data/catalog.json`/il CLI.

**Regola trasversale (da M0 in poi)**: al completamento di ciascuna milestone, prima di iniziare la successiva, aggiungere a `documentazione.md` la sezione corrispondente con le decisioni prese e la logica costruttiva di quella milestone.

## Punti aperti da definire e schedulare

Idee raccolte dall'utente, non ancora scoperte a sufficienza per diventare una milestone numerata (mancano decisioni di design/scope) — da riprendere e dettagliare prima di iniziare l'implementazione:

> **Nota**: il vecchio punto 1 ("Vista dello stato di un video oltre il locale") è stato **promosso** a milestone M25–M28 — il modello a flag ortogonali (`presence`/`download`/`hidden`) lo copre. Anche il punto "backup e ripristino" è stato promosso a **M36** (backup/ripristino in `.zip`); un eventuale "backup su cloud" ne sarebbe un'estensione futura. Rimossi da qui e gli altri punti rinumerati, come da regola del backlog.

1. **Video suggeriti → togliere o cambiare?** (`VideoDetailPage`): oggi mostra solo altri video dello stesso canale. Da decidere se ha senso tenerlo così com'è, cambiare criterio (es. video simili per tag/titolo, più recenti, casuali), o toglierlo del tutto.
2. **Sottotitoli** — analizzata la fattibilità (vedi M18), ma **non voluti ora** dall'utente: resta solo un'idea per il futuro. Risultati della ricerca già fatta, da riusare se si riprende in mano: `subtitleLanguagesAvailable` (già nello schema) traccia solo i sottotitoli **manuali** di YouTube, praticamente sempre assenti nel catalogo reale (verificato: 2 video su 15 controllati, e solo "live_chat", non sottotitoli veri). Servirebbero invece i **sottotitoli automatici** di YouTube (`info.automatic_captions`, confermati disponibili — 157 lingue su un video reale del catalogo, formato `vtt` nativamente supportato dal tag `<video>`, mostra da solo un pulsante "CC" senza bisogno di UI custom). Implicherebbe: scaricare i file veri (oggi non scaricato nulla), nuova cartella `media/subtitles/`, nuovi flag yt-dlp, e decidere quali lingue scaricare (157 per video è eccessivo — proposta non ancora confermata: italiano + inglese fissi). Per i 63 video già scaricati, preferenza espressa se si riprende: solo i download futuri, non un recupero retroattivo.
3. **Eseguibile vs codice sorgente di `yt-dlp` — portabilità fuori da Windows**: oggi il progetto dipende da un binario standalone Windows (`tools/yt-dlp.exe`, `.exe` fisso nel path di default, invocato via `child_process.spawn` — decisione originale esplicita: "nessun wrapper npm, nessun download automatico, **nessun Python**"). Per portare il progetto su Linux/macOS serve decidere come procurarsi yt-dlp lì. Da valutare: (a) yt-dlp pubblica binari standalone anche per Linux/macOS (non solo `.exe` per Windows) — si potrebbe restare fedeli alla decisione "nessun Python" scegliendo il binario giusto per piattaforma invece che installare yt-dlp da sorgente/pip; (b) installare yt-dlp da codice sorgente/pip richiederebbe Python come dipendenza di sistema, in contrasto con la decisione originale. Da capire anche cos'altro nel progetto assume Windows oltre al binario (es. default `playback.vlcPath` con path stile `C:\Program Files...`, separatori di percorso, ecc.) prima di considerare il progetto realisticamente portabile.
4. **Provider `channel` per il monitoraggio di interi canali** (ex M13, spostata qui perché non abbastanza definita per essere una milestone) — l'idea originale del progetto era lasciare un punto di estensione pulito in `sourceProviders` per aggiungere in futuro il monitoraggio di un intero canale YouTube (non solo playlist). Verificato però che oggi `sourceProviders/playlistProvider.js` è **una singola funzione hardcoded** (`listEntries`), importata direttamente da `syncService.js` — non esiste ancora un vero "seam" (un dispatch per tipo di sorgente, un registro di provider) da poter verificare o estendere. Da definire da zero se e quando si riprende: cosa deve fare concretamente un provider `channel` (rilevare nuovi upload di un canale intero), come si aggiunge un meccanismo di dispatch per tipo di sorgente senza rompere `playlistProvider.js` esistente, e cosa vuol dire "supportarlo" in modo verificabile (non solo una nota di sola lettura).
5. **Scelta della copertina del video** — oggi la copertina è quella che yt-dlp scarica in automatico (la thumbnail a risoluzione più alta), senza possibilità di sceglierne un'altra. Emerso da un caso reale (`Gq4aN6KnJoE`): yt-dlp aveva scelto `sddefault.jpg` (640×480, 4:3) perché a più pixel, ma quel formato ha le **bande nere di letterbox "cotte" dentro l'immagine**, mentre esisteva una `mqdefault.jpg` (320×180) 16:9 pulita ma a risoluzione inferiore — risolto manualmente sostituendo il file. Due funzionalità da definire: (a) **scelta tra le copertine disponibili** — YouTube ne espone diverse (maxres/sd/hq/mq + varianti croppate `sqp`), mostrarle e lasciar scegliere quella preferita (o applicare da subito una preferenza automatica "16:9 pulita a risoluzione più alta" invece del semplice "più pixel", che eviterebbe da sé il caso letterbox per i futuri download); (b) **copertina custom estratta da un fotogramma del video** a un istante scelto dall'utente (scrubbing sul player → "usa questo frame come copertina", estratto con ffmpeg, già presente). Da definire: dove vive la copertina scelta nello schema (oggi `thumbnail.sourceUrl`/`localPath`), come si rigenera, se vale per download futuri e/o retroattivi, e l'interfaccia (dropdown di miniature vs. estrazione dal player).
6. **Client desktop Electron** — l'altro lato del progetto, mai ancora affrontato: un'app desktop (Electron) che permette di scaricare i video **in locale sulla macchina dell'utente** (non solo sul server), da cui l'asse **"locale"** previsto e poi rimandato in M25. Da definire da zero: cosa condivide col `core` esistente (le stesse mini-API? un catalogo separato o lo stesso `data/catalog.json`?), come si sincronizza lo stato "locale" tra client e server, se il download locale riusa `yt-dlp`/`ffmpeg` impacchettati nell'app o quelli di sistema, packaging/distribuzione, e come reintrodurre l'asse `local` nello schema (il modello a flag di M25 è già pensato per accoglierlo). Grande, tutto da scoprire — non iniziare senza una fase di analisi/scope dedicata.
7. **Copertine (banner) dei canali — rimuovere o implementare?** `ChannelPage` ha oggi un `<div className="banner">` **vuoto** (placeholder mai riempito), distinto dalla foto profilo/avatar del canale già implementata in M14. Da decidere: **rimuoverlo** (semplifica la pagina) oppure **implementarlo** scaricando il banner reale del canale (via yt-dlp, come per l'avatar in M14 — da verificare se l'estrattore lo espone e per quali siti; su Rumble l'avatar non era disponibile). Se implementato: dove cacharlo (`media/banners/`?), quando aggiornarlo, e il fallback quando manca.
8. **Anteprima video sulla card / nel player** (da ragionare) — una voce di menu ⋮ "Anteprima" che mostri un'anteprima del video: hover-preview sulla copertina in stile YouTube (uno spezzone che parte al passaggio del mouse) e/o un player di anteprima. Da definire: cosa si riproduce se il video non è scaricato (spezzone da YouTube? clip locale?), la sorgente dell'anteprima, dove vive (overlay sulla card vs mini-player), e il costo/complessità.
9. **Cartella `media/` relocabile fuori dal progetto** (scorporato da M36, in cui è stato deciso di rimandarlo). Oggi i video vivono in `./media` dentro il progetto; l'utente vuole poterne impostare la posizione su disco fuori dal progetto. Fattibilità già verificata: `getPaths()` in `core/src/config.js` risolve già `mediaRoot` con `path.resolve(PROJECT_ROOT, config.mediaRoot)`, quindi un percorso **assoluto** in `config.json` funziona già senza modifiche al codice (anche lo static serving Express serve qualunque path assoluto). Ciò che manca da definire/costruire: (a) un'interfaccia per impostare il percorso (oggi si edita `config.json` a mano); (b) una funzione che **scriva `config.json` a runtime** e invalidi la cache — non esiste (`loadConfig` cacha e non ricarica mai); (c) se **spostare fisicamente** i media esistenti nella nuova posizione o solo ripuntare (l'utente ha detto che i file "non vanno toccati"); (d) il vincolo di **riavvio** del processo (config e static serving sono fissati all'avvio). Nota: `dataDir` resta ancorato a `PROJECT_ROOT/data` — qui si parla solo della cartella media.

## Bug risolti fuori milestone

- ✅ **Copertina con bande nere di letterbox** su `Gq4aN6KnJoE` (video YouTube 16:9): yt-dlp aveva scaricato la thumbnail `sddefault.jpg` 640×480 (4:3, con barre nere sopra/sotto "cotte" nel JPG) perché a più pixel della 16:9 `mqdefault.jpg` (320×180). In "Scarica video" la copertina risultava con bande visibili, diversa dalle altre (tutte 1280×720 pulite). Corretto sostituendo il file `media/thumbnails/Gq4aN6KnJoE.jpg` con la 16:9 pulita (`mqdefault`) e aggiornando `thumbnail.sourceUrl` nel catalogo; nessuna versione 720p esiste per quel video (maxresdefault/hq720 → 404). La scelta della copertura in modo strutturale è tracciata nei "Punti aperti" (punto 5).

- ✅ **Pulsanti `.btn-primary` (accento) in hover diventavano illeggibili** ("spariscono e diventano neri") — segnalato dall'utente su "+ Aggiungi" in Sorgenti. Causa: `.btn:hover` (regola generica) imposta uno sfondo scuro quasi nero, e vince su `.btn-primary` in hover perché quest'ultimo non ridichiarava lo sfondo colorato sullo stato `:hover` (stessa specificità CSS, ma dichiarato prima nel file) — il testo scuro (`--accent-contrast`) pensato per un fondo chiaro finiva su un fondo quasi nero, illeggibile. **Bug pre-esistente al rebrand M17**, non introdotto dal cambio colore — solo reso più evidente. Corretto in `global.css`: `.btn-primary:hover` ridichiara esplicitamente `background: var(--accent)`. Verificato nel browser reale: il pulsante resta viola e leggibile in hover.
