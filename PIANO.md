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
      jobs/jobManager.js              # coda single-worker + EventEmitter, persistenza storico
      jobs/jobs/downloadPending.js
      jobs/jobs/downloadSingle.js
  packages/
    cli/                          # primo consumatore delle mini API di /core
      package.json                  # dipendenza: @inquirer/prompts
      cli.js                      # menu a frecce (@inquirer/prompts): importa @catalog/core direttamente, nessun HTTP
    server/                       # costruito più avanti (M10): thin wrapper HTTP attorno a @catalog/core
      src/
        index.js
        routes/videos.routes.js
        routes/jobs.routes.js       # include SSE, bridge verso gli eventi di jobManager
        routes/sources.routes.js
        media/mediaRoutes.js        # express.static per /media/videos e /media/thumbnails
    web/                          # costruito più avanti (M11): SPA React, client HTTP di packages/server
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

### Idea in discussione: consultabilità di `media/videos/` da filesystem

L'utente ha notato che `media/videos/` è poco consultabile aprendola direttamente in Esplora File: tutti i canali mescolati in un'unica cartella piatta, e il nome file è l'id YouTube (es. `88RAHq3prwo.mp4`), non il titolo. Ha chiesto di ragionare insieme su una soluzione, proponendo lui stesso l'idea di un comando di esportazione.

Due strade valutate:
1. **Cambiare l'archivio canonico** (es. `media/videos/<Canale>/<Titolo> [<id>].<ext>`, convenzione tipica di yt-dlp) — concettualmente più "corretto", ma richiede riscrivere la logica che oggi si aspetta `<id>.<ext>` esatto (`findDownloadedFiles`) e rendere di nuovo tutti i file già scaricati (l'utente ha appena rinominato 49 file proprio nel formato attuale per l'importazione fatta in M6 — un secondo giro di rinomina sarebbe spreco puro).
2. **Comando di esportazione** (proposto dall'utente): l'archivio interno resta `<id>.<ext>`, invariato, senza toccare nulla del codice esistente. Nuova funzione che genera/aggiorna `media/esportati/<Canale>/<Titolo>.<ext>` tramite **hard link** (non copie): stesso contenuto su disco, occupazione di spazio a zero anche per file da diversi GB, creazione istantanea (`fs.linkSync`, funziona su Windows/NTFS senza privilegi di amministratore, a differenza dei symlink).

**Raccomandazione**: opzione 2 — rischio minimo, nessun re-lavoro sui 50 video già a posto, risultato equivalente (cartella sfogliabile per canale con il titolo vero) a un costo di implementazione molto più basso. Dettagli implementativi da definire quando si passa a costruirla: dove agganciare la generazione/aggiornamento (comando dedicato nel menu vs automatico dopo ogni download), come gestire titoli duplicati nello stesso canale (già visto un caso reale, due video con titolo identico), sanificazione caratteri non validi per nomi file Windows.

### Idea in discussione: reset della schermata CLI (rimandata)

I menu del CLI (`@inquirer/prompts` dentro cicli `while(true)`) non puliscono mai il terminale: ogni vecchia versione di un elenco (es. "Rivedi novità" dopo ogni decisione, "Guarda" scorrendo canali/video) resta stampata sopra le nuove, e dopo pochi giri lo schermo diventa illeggibile. L'utente ha chiesto un reset della schermata a ogni menu/sottomenu — **rimandata** per ora, ma la progettazione è già discussa e pronta per quando si deciderà di riprenderla:

- Meccanismo condiviso in `packages/cli/cli.js`: una `clearScreen()` che pulisce il terminale (`console.clear()`, solo se `process.stdout.isTTY`) e subito dopo ristampa un eventuale messaggio in sospeso; una `setMessage(text)` che mette in coda quel messaggio. Sicuro con una singola variabile globale perché il CLI è già bloccante, un solo flusso interattivo alla volta.
- Ogni ciclo `while(true)` di menu/sottomenu chiama `clearScreen()` come prima istruzione, prima di ricalcolare/ristampare l'elenco.
- Ogni output "da leggere" non in tempo reale (conferme, riepiloghi, elenchi informativi) passa da `console.log` diretto a `setMessage()`, così sopravvive esattamente una schermata invece di sparire subito o restare per sempre. Fa eccezione lo streaming live dei log di un job in corso (`onJobLog`), che resta `console.log` diretto riga per riga: solo la riga di riepilogo finale passa da `setMessage()`.

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
| M7 ✅ | Motore di ricerca nel CLI: `core/src/services/searchService.js` (`searchVideos`, fuzzy scritto a mano — finestra scorrevole + distanza di Levenshtein su titolo/canale/tag, sottostringa esatta su descrizione — nessuna dipendenza esterna) + nuova voce menu "Cerca" (prompt `search` di `@inquirer/prompts`, azioni contestuali allo stato del risultato). | Ricerca reale contro il catalogo dell'utente: titolo con typo, nome canale con typo, termine generico con molti risultati, query senza corrispondenze. |
| M8 ✅ | `core`: nuovo `services/singleVideoService.js` (`prepareSingleVideoDownload(url)` — risolve id/titolo/canale/extractor con **yt-dlp stesso** (`resolveVideoInfo()`, nuovo in `ytdlpWrapper.js`), non con un regex specifico di YouTube: qualunque sito supportato da `yt-dlp.exe` funziona, non solo YouTube. Riusa il job `downloadSingle` già esistente; se l'id non è nel catalogo crea uno stub con `source: { sourceId: null, type: 'single' }` così non è mai toccato da nessuna sync di playlist, poi scarica subito; se è già `downloaded`/`downloading` informa senza agire; se è già tracciato con un altro stato tramite una fonte, rifiuta e rimanda a "Rivedi novità"). Corretto `ytdlpWrapper.downloadVideo()` (scaricava sempre da un URL YouTube ricostruito dall'id, ora accetta l'URL reale) e il format selector di default (l'esclusione AV1, un workaround specifico di YouTube, escludeva l'unico formato disponibile su altri siti — aggiunto un fallback finale senza filtro). `packages/cli/cli.js`: nuova voce menu "Scarica video singolo" (dopo "Gestisci fonti"), log/progress live come "Scarica in coda". | URL YouTube (`watch?v=`, `youtu.be/`, `shorts/`, id nudo) e non-YouTube (verificato con Rumble) → download reale end-to-end e comparsa in "Guarda"/"Catalogo"; URL con `list=` → scarica solo quel video, nessuna fonte creata in `catalog.sources`; id già `downloaded` → messaggio, nessun ri-download; id già tracciato `new`/`pending`/`failed`/`excluded` → rifiutato con messaggio che rimanda a "Rivedi novità"; URL non valido o playlist/canale → errore chiaro, nessun crash. |
| M9 ✅ | Rimozione di "Importa video già scaricati": era uno script di migrazione una tantum (introdotto in M6 per i 49 video già scaricati manualmente prima di adottare il tool), non una funzionalità duratura. Rimuovere `core/src/services/importService.js` (`scanImportable`, `importLocalVideo`) e i relativi export da `core/src/index.js`; rimuovere `fetchMetadata()` da `core/src/ytdlp/ytdlpWrapper.js` (unico chiamante era `importLocalVideo`; `hashFileSha256`/`getYtdlpVersion`/`mapInfoJsonToVideoFields` restano, condivise con `downloadVideo()`); rimuovere dal CLI la voce menu "Importa video già scaricati" e `importFlow()`. Nessun impatto sui 49 video già importati in M6: restano entry `downloaded` regolari nel catalogo, indipendenti dal codice che li ha creati. | Il menu principale non mostra più la voce; nessun riferimento residuo a `importService`/`scanImportable`/`importLocalVideo`/`fetchMetadata` nel repo; i 49 video importati in M6 restano intatti e `downloaded` nel catalogo. |
| M10 ✅ (era M8) | `packages/server`: thin wrapper Express attorno a `@catalog/core` (stesse funzioni, esposte come REST) + bridge SSE sugli eventi di `jobManager` + static serving media con Range requests. | `Invoke-RestMethod` sugli endpoint restituisce gli stessi dati visti dal CLI; richiesta con header `Range` risponde `206`; stream SSE mostra i log di un job in corso. |
| M11 ✅ (era M9) | `packages/web`: SPA React (Vite) — `CatalogPage`, `VideoDetailPage` (con decisione su "novità" e player), `JobsPage`. | `npm run dev`, uso la WebGUI per rivedere una novità, deciderla, scaricarla, e riprodurla nel browser. |
| M12 (era M10) | Rifinitura: ricerca/filtri su CatalogPage, dettaglio errori + retry sia da CLI che da web, QA sui casi limite. | Passaggio manuale su tutti i flussi, CLI e web. |
| M13 (era M11) | Solo documentazione: verifica che il seam `sourceProviders` supporti in futuro un provider `channel`; nota dedicata in `documentazione.md`. | Solo lettura, nessuna verifica runtime. |

Nota: il reset della schermata del CLI (vedi "Idea in discussione: reset della schermata CLI" sopra) resta rimandato, non è una milestone numerata per ora.

L'utente ha già in catalogo due fonti reali: "ToDownload" (1 video, in `pending`, ancora da scaricare — un tentativo reale ha incontrato un probabile throttling temporaneo di YouTube legato ai test ripetuti, non un problema di codice) e "bell asmr" (49 video, tutti `downloaded` — l'utente li aveva già scaricati manualmente prima di usare il CLI e li ha importati con "Importa video già scaricati").

**Regola trasversale (da M0 in poi)**: al completamento di ciascuna milestone, prima di iniziare la successiva, aggiungere a `documentazione.md` la sezione corrispondente con le decisioni prese e la logica costruttiva di quella milestone.
