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
    jobs/                        # storico persistito dei job (uno per file)
  media/
    videos/
    thumbnails/
  core/                           # LE MINI API: libreria di funzioni, richiamabile da CLI e WebGUI
    package.json                    # nome pacchetto: @catalog/core
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
      services/importService.js       # scanImportable(), importLocalVideo(id) -> video già scaricati fuori dal tool
      services/metadataService.js     # getRawMetadata(id) -> data/metadata.json
      jobs/jobManager.js              # coda single-worker + EventEmitter, persistenza storico
      jobs/jobs/downloadPending.js
      jobs/jobs/downloadSingle.js
  packages/
    cli/                          # primo consumatore delle mini API di /core
      package.json                  # dipendenza: @inquirer/prompts
      cli.js                      # menu a frecce (@inquirer/prompts): importa @catalog/core direttamente, nessun HTTP
    server/                       # costruito più avanti (M7): thin wrapper HTTP attorno a @catalog/core
      src/
        index.js
        routes/videos.routes.js
        routes/jobs.routes.js       # include SSE, bridge verso gli eventi di jobManager
        routes/sources.routes.js
        media/mediaRoutes.js        # express.static per /media/videos e /media/thumbnails
    web/                          # costruito più avanti (M8): SPA React, client HTTP di packages/server
      vite.config.js
      src/
        App.jsx
        api/client.js
        pages/CatalogPage.jsx
        pages/VideoDetailPage.jsx
        pages/JobsPage.jsx
        components/VideoCard.jsx
        components/VideoPlayer.jsx
        components/StatusBadge.jsx
        components/JobLogViewer.jsx
        components/JobHistoryList.jsx
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
        "localPath": "dQw4w9WgXcQ.mp4",
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

**`status`**: `new | pending | downloading | downloaded | failed | excluded`.

- `new` — appena trovato in una sync della playlist, **in attesa di decisione dell'utente** (è la "novità" che il CLI mostra).
- `pending` — l'utente ha deciso di scaricarlo (o un `downloaded` è stato auto-riparato perché il file è sparito dal disco); in coda per il prossimo `downloadPending`.
- `downloading` / `downloaded` / `failed` — come nel flusso di download originale.
- `excluded` — l'utente ha deciso esplicitamente di **non** scaricarlo; resta nel catalogo per non essere riproposto come "novità" a ogni sync successiva, ma nessun file viene scaricato.

`decidedAt` traccia quando l'utente ha preso la decisione (download/esclusione); resta `null` finché lo stato è `new`.

`video.localPath`/`thumbnail.localPath` sono **relativi a `mediaRoot`** (in `config.json`), così spostare l'archivio richiede solo cambiare config, non riscrivere il catalogo.

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
- `triggerJob(type, params)` / `getJob(id)` / `listJobs()` — coda job (`downloadPending`, `downloadSingle`): coda single-worker FIFO, stato persistito in `data/jobs/<id>.json`, `EventEmitter` per eventi `log`/`progress`/`status` in tempo reale.
- `playVideo(id, { mode = 'video' })` — verifica `status: downloaded` e che il file esista, poi lancia VLC; `mode: 'audio'` aggiunge `--no-video` per la riproduzione solo audio.

Il **job manager** e il **wrapper yt-dlp** vivono in `core` (non dentro `packages/server`): il CLI, essendo nello stesso processo, si iscrive direttamente agli eventi dell'`EventEmitter` di `jobManager` e stampa le righe di log a terminale in tempo reale — nessuna infrastruttura SSE necessaria finché non arriva la WebGUI (M7), che invece farà da bridge fra quegli stessi eventi e i suoi client HTTP via SSE.

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
- **Sincronizza** → se nessuna fonte configurata, messaggio e torna al menu; altrimenti `select` con **"Tutte le fonti"** in cima + una voce per fonte + ← Torna → esegue `syncSource` (una o tutte in sequenza) → riepilogo.
- **Rivedi novità** → **vista unica** che sostituisce le due voci separate precedenti (revisione + download, ora una dentro l'altra su richiesta dell'utente). Elenca **tutti** i video `new`/`pending`/`excluded` insieme (con un'icona di stato per riconoscerli a colpo d'occhio), più una voce in cima **"▶ Scarica in coda (N)"** (visibile solo se N > 0) + ← Torna al menu principale. Se non c'è nulla da rivedere e nulla in coda, messaggio e torna al menu.
  - Scegliendo un video: sotto-`select` con le azioni valide per il suo stato attuale — da `new`: **Scarica** / **Archivia**; da `pending`: **Archivia** / **Rimetti tra le novità** (annulla la decisione, torna a `new`); da `excluded`: **Scarica** / **Rimetti tra le novità** — sempre con ← Torna alla lista. Applica `decideVideo(id, 'download'|'exclude'|'undecided')` → torna alla lista aggiornata. Questo risolve anche il bisogno di **togliere un video dagli archiviati** e cambiargli stato, prima non possibile.
  - Scegliendo **"▶ Scarica in coda (N)"**: stesso comportamento di prima (`confirm` "Scaricare N video ora?" → se sì, `triggerJob('downloadPending')` con log/progress live via `EventEmitter`) ma **nidificato dentro questa vista** invece che una voce separata del menu principale.
- **Guarda** → `listChannels({status:'downloaded'})`; se vuoto, messaggio. Altrimenti `select` canali (nome + conteggio) + ← Torna → `select` video di quel canale (titolo, durata, data) + ← Torna ai canali → `select` **Video** / **Solo audio** → `playVideo(id, {mode})` → torna alla lista video di quel canale.
- **Catalogo** → `select` di uno stato (Tutti/Nuovi/In coda/In download/Scaricati/Falliti/Archiviati) + ← Torna → stampa l'elenco corrispondente (vista informativa) → torna al menu.
- **Esci** → termina il processo.

Non esiste una scorciatoia "play per id" a comando digitato: la navigazione **Guarda** (canale → video → modalità) è l'unico modo per riprodurre un video, coerente col vincolo "niente comandi scritti a mano". Il blocco "exit durante un download" non richiede gestione esplicita: il design a menu è bloccante (un solo flusso interattivo alla volta), quindi non esiste uno stato in cui si può navigare al menu mentre un job è in corso.

Errori (id inesistente, stato incompatibile con l'azione, VLC non trovato, URL senza `list=`, fonte non trovata, ecc.) vengono stampati come messaggio chiaro e si torna al menu/passo precedente, mai un crash.

### Idea futura (da definire): motore di ricerca

L'utente vuole aggiungere un **motore di ricerca** al CLI, per trovare rapidamente un video nel catalogo (probabilmente per titolo/canale/tag, dato che "Guarda" oggi richiede di navigare canale per canale e "Catalogo" filtra solo per stato). Non ancora progettato: da definire come voce di menu, quali campi indicizzare, se ricerca esatta o fuzzy, e come si integra con la navigazione a menu esistente (es. `input` per il testo di ricerca + `select` sui risultati, sullo stesso modello di "Guarda"). Nessuna implementazione ora — solo appuntato per una definizione futura.

## Logica di download e dedup

1. **Sync (enumerazione)**: `yt-dlp --js-runtimes node --flat-playlist -J <playlist-url>` (economico, non tocca file) su una fonte già registrata in `catalog.sources`. Per ogni id:
   - non in catalogo → inserisci `status: new` (è una "novità", in attesa di decisione).
   - in catalogo `downloaded` → verifica che il file esista su disco; se manca, torna `pending` (già deciso in passato, va solo riscaricato).
   - in catalogo `excluded` → lascia invariato (decisione già presa, non riproporre).
   - in catalogo `new`/`pending`/`downloading`/`failed` → lascia invariato.
2. **Aggiunta fonte**: "Aggiungi fonte" nel CLI (`addSource(url)`) registra una nuova playlist in `catalog.sources` e ingerisce subito le sue entry come sopra (stessa logica, fattorizzata in `ingestPlaylistEntries()`).
3. **Decisione**: "Scarica"/"Archivia"/"Rimetti tra le novità" nella vista "Rivedi novità" del CLI spostano liberamente un'entry tra `new`/`pending`/`excluded`.
4. **Download**: per ogni entry `pending` (o `failed` con `attempts < maxAttempts`, default 3): imposta `downloading`, spawna `yt-dlp --js-runtimes node --extractor-args "youtube:player_client=default,android_vr" -f "bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]" --merge-output-format mp4 --write-thumbnail --convert-thumbnails jpg --write-info-json -o media/videos/%(id)s.%(ext)s -o "thumbnail:media/thumbnails/%(id)s.%(ext)s" --download-archive media/.ytdlp-archive.txt <id>` — **senza `--cookies` al primo tentativo**; se fallisce e sono configurati dei cookie (`core/cookies.txt`), si ripulisce l'eventuale residuo e si ritenta un'unica volta con `--cookies` incluso. Al termine, `ytdlpWrapper.js` legge il sidecar `<id>.info.json`, ne mappa i campi curati nello schema, salva il grezzo in `data/metadata.json` e cancella il sidecar. A successo: calcola sha256 + size, `status: downloaded`. A fallimento: `status: failed`, `attempts++`, salva errore.
   - **`--js-runtimes node`**: senza un runtime JavaScript, yt-dlp non riesce a decifrare le firme dei formati più recenti e i download falliscono a metà con `HTTP 403`. Node è già una dipendenza del progetto, quindi lo si usa come runtime (nessuna installazione aggiuntiva, es. Deno).
   - **Esclusione codec AV1** (`vcodec!*=av01`): scoperto verificando con la playlist reale dell'utente che il formato di default (`bv*+ba/b`, che sceglie AV1 alla risoluzione più alta) falliva sistematicamente con 403 anche con il runtime JS attivo, mentre lo stesso video alla stessa risoluzione in **VP9** scaricava senza problemi. **Nessun compromesso sulla qualità**: si ottiene comunque la risoluzione più alta disponibile, semplicemente non in AV1, coerente con "massima qualità, nessun cap".
   - **`player_client=default,android_vr`**: alcuni video vengono assegnati da YouTube a un esperimento che richiede un "PO Token" per i client normali (web/ios/tv) — senza, quei client falliscono con 403 in modo sistematico e ripetibile (diagnosticato con `yt-dlp -v --simulate`: "Detected experiment to bind GVS PO Token to video ID"). Il client `android_vr` non è soggetto all'esperimento; aggiunto come client **supplementare** (non sostitutivo di `default`) così i video non coinvolti nell'esperimento continuano a usare i client abituali.
   - **Niente `--cookies` al primo tentativo**: inviare i cookie del browser insieme all'identità client mobile `android_vr` è una combinazione che la CDN video di YouTube tratta come sospetta e blocca con 403, anche se le fasi di estrazione precedenti (con quegli stessi cookie) riescono. Dato che tutti i video di un catalogo personale sono tipicamente pubblici, il primo tentativo è senza cookie; il fallback con cookie resta per l'unico caso in cui servono davvero: video privati/non listati del proprio account.
5. **Interruzioni**: yt-dlp riprende download parziali via range request nativamente (il file `.part` viene deliberatamente preservato quando un download fallisce, per permettere la ripresa). Se il processo muore mid-download, all'avvio `catalogStore` resetta ogni entry bloccata su `downloading` a `pending`.
6. **Pulizia dei residui**: se un download fallisce dopo che yt-dlp ha già scritto `.info.json`/thumbnail (cosa che fa presto nel suo processo), quei file vengono cancellati automaticamente — solo il video/`.part` viene preservato per il resume.
7. **Doppia protezione dedup**: `--download-archive` di yt-dlp come ledger ridondante, ma il catalogo resta la fonte primaria.

## Serving video e player (per la futura WebGUI)

- `express.static()` (via pacchetto `send`) supporta già **Range requests**/ETag out of the box.
  ```js
  app.use('/media/videos', express.static(mediaRoot + '/videos'));
  app.use('/media/thumbnails', express.static(mediaRoot + '/thumbnails'));
  ```
- Frontend: `<video controls src="/media/videos/{id}.mp4">` nativo, sufficiente per mp4 con seek.
- Merge sempre in **MP4** (H.264/AAC) — ffmpeg già presente sulla macchina.

## Pagine frontend (WebGUI, fase successiva)

- **CatalogPage** (`/`): griglia `VideoCard`, ricerca/filtri client-side, include anche i video `new`/`excluded` con badge di stato.
- **VideoDetailPage** (`/videos/:id`): `VideoPlayer` + pannello metadati esteso; se `new`, bottoni "Scarica"/"Escludi" (stesso `decideVideo` usato dal CLI); se `failed`, bottone "Riprova".
- **JobsPage** (`/jobs`): trigger job, log live via SSE (bridge sopra gli stessi eventi di `jobManager` già usati dal CLI), storico persistito.

## Config (`data/config.json`)

```json
{
  "mediaRoot": "./media",
  "port": 3001,
  "ytdlp": { "binaryPath": "./tools/yt-dlp.exe", "format": "bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]", "mergeOutputFormat": "mp4", "maxHeight": null, "cookiesFile": null },
  "playback": { "vlcPath": "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe" },
  "jobs": { "maxAttempts": 3 }
}
```

- `maxHeight: null` → nessun cap di risoluzione (`buildFormatSelector` applica comunque l'esclusione AV1 anche quando un cap è impostato).
- `playback.vlcPath` → percorso dell'eseguibile VLC, usato da `playbackService.js`. **Non esiste un default universale**: su questa macchina VLC è installato nella cartella a 32 bit (`Program Files (x86)`), non quella a 64 bit come si potrebbe assumere — verificarlo per ogni installazione.
- `cookiesFile` (opzionale, `null` di default): se `null`, si usa automaticamente `core/cookies.txt` se esiste; se valorizzato, quel path ha la precedenza. Vedi "Cookie per video privati/non listati" sopra.
- **Le fonti (playlist) non sono più in `config.json`** (M6): vivono in `catalog.sources`, gestite interattivamente dal CLI ("Gestisci fonti") tramite `sourceService.js`. `config.json` resta per le sole impostazioni statiche (percorsi, qualità, VLC, numero massimo di tentativi).
- `data/config.json` contiene dati personali (path locali specifici della macchina) e non va committato: è nel `.gitignore`. `data/config.example.json`, tracciato da git (senza dati personali, con gli stessi default), è il template.

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
| M7 | `packages/server`: thin wrapper Express attorno a `@catalog/core` (stesse funzioni, esposte come REST) + bridge SSE sugli eventi di `jobManager` + static serving media con Range requests. | `Invoke-RestMethod` sugli endpoint restituisce gli stessi dati visti dal CLI; richiesta con header `Range` risponde `206`; stream SSE mostra i log di un job in corso. |
| M8 | `packages/web`: SPA React (Vite) — `CatalogPage`, `VideoDetailPage` (con decisione su "novità" e player), `JobsPage`. | `npm run dev`, uso la WebGUI per rivedere una novità, deciderla, scaricarla, e riprodurla nel browser. |
| M9 | Rifinitura: ricerca/filtri su CatalogPage, dettaglio errori + retry sia da CLI che da web, QA sui casi limite. | Passaggio manuale su tutti i flussi, CLI e web. |
| M10 | Solo documentazione: verifica che il seam `sourceProviders` supporti in futuro un provider `channel`; nota dedicata in `documentazione.md`. | Solo lettura, nessuna verifica runtime. |

L'utente ha già in catalogo due fonti reali: "ToDownload" (1 video, in `pending`, ancora da scaricare — un tentativo reale ha incontrato un probabile throttling temporaneo di YouTube legato ai test ripetuti, non un problema di codice) e "bell asmr" (49 video, tutti `downloaded` — l'utente li aveva già scaricati manualmente prima di usare il CLI e li ha importati con "Importa video già scaricati").

**Regola trasversale (da M0 in poi)**: al completamento di ciascuna milestone, prima di iniziare la successiva, aggiungere a `documentazione.md` la sezione corrispondente con le decisioni prese e la logica costruttiva di quella milestone.
