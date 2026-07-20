# Documentazione del progetto

## M0 — Setup iniziale

Creata la struttura a monorepo con npm workspaces (`packages/core`, `packages/cli`, `packages/server`, `packages/web`), ciascuno come package minimale (solo `package.json`, nessun codice: viene popolato nelle milestone successive). `core` non ha dipendenze da Express/HTTP perché è pensato come libreria pura (le "mini API") condivisa da `cli` e, più avanti, da `server`.

Il binario `yt-dlp.exe`, già presente nella root, è stato spostato in `tools/yt-dlp.exe` per tenerlo separato dal codice sorgente ed è escluso da git (`.gitignore`) essendo un binario di terze parti da scaricare a parte, non da versionare. Verificato funzionante: `yt-dlp.exe --version` → `2026.07.04`.

`ffmpeg` era già presente e disponibile su PATH (necessario per il merge audio/video in MP4 durante i download) — verificato funzionante, nessuna azione richiesta.

Create le cartelle `data/` (con `data/jobs/` per lo storico dei job) e `media/` (con `media/videos/` e `media/thumbnails/`), ancora vuote: verranno popolate rispettivamente da `catalogStore` (M2) e dai download reali (M4+). Anche queste sono escluse da git, dato che contengono dati generati/scaricati localmente, non codice.

Creato `CLAUDE.md` con l'istruzione permanente di documentazione continua, e questo stesso file (`documentazione.md`) come sua prima applicazione.

### Correzione: auto-portanza della cartella

Il piano tecnico completo (schema del catalogo, superficie delle mini API, comandi CLI, formato di `config.json`, roadmap M0-M10) era stato elaborato solo nel file di plan mode esterno al progetto, non nella cartella `YouTubeCatalog`. Per rendere il progetto autonomo — consultabile e proseguibile anche senza quel file esterno — è stato aggiunto `PIANO.md` nella root, con la specifica tecnica completa, e `CLAUDE.md` ora lo referenzia esplicitamente come punto di partenza obbligato prima di lavorare su qualunque milestone.

Corretto anche `.gitignore`: mancava `data/config.json`, che conterrà dati personali (URL della playlist "da scaricare", eventuali path locali) e non deve essere committato — coerentemente, quando `config.json` verrà introdotto (M1/M2), andrà affiancato da un `data/config.example.json` tracciato da git come template senza dati personali.

### Correzione: `core` elevato a cartella di primo livello + supporto cookie facoltativo

`core` (le mini API) è stato spostato da `packages/core` a `/core`, a livello radice del progetto, per riflettere meglio il suo ruolo: non è un'interfaccia come `cli`/`server`/`web`, è la libreria di funzioni su cui tutte loro si appoggiano — va richiamata sia dalla CLI (in-process) sia, più avanti, dalla WebGUI (tramite `packages/server`). Aggiornati di conseguenza `package.json` root (`workspaces: ["core", "packages/*"]`) e `PIANO.md`.

Aggiunto anche il supporto a un file `core/cookies.txt` **facoltativo** (non versionato, in `.gitignore`): se presente, permette a yt-dlp di accedere a video privati/non listati del proprio account tramite `--cookies`; se assente, il download prosegue normalmente senza cookie. Nessun errore se manca — è un'estensione opzionale, non un prerequisito. Dettagli in `PIANO.md`, sezione "Cookie per video privati/non listati".

## M2-M5 — Implementazione del core (le mini API)

Costruita l'intera libreria `core/src/` in un unico passaggio invece di seguire M1 (script usa-e-getta) come passo separato: la validazione end-to-end è stata fatta chiamando direttamente le funzioni reali di `core` invece di uno script throwaway, quindi M1 è considerata assorbita/superata da M2-M5 piuttosto che eseguita a parte.

**`config.js`**: carica `data/config.json`, e se non esiste lo crea al primo avvio copiando i default (stessa forma di `data/config.example.json`, che invece è il template statico tracciato da git). Fa merge ricorsivo tra default e config utente, così se in futuro aggiungiamo nuovi campi ai default, un `config.json` utente più vecchio continua a funzionare senza doverlo riscrivere a mano. `getPaths()` risolve tutti i path assoluti usati dal resto del core (media, catalogo, job, binario yt-dlp, VLC) e **auto-rileva `core/cookies.txt`**: se il file esiste, viene usato automaticamente senza bisogno di configurazione esplicita (verificato: con il file reale che l'utente ha posizionato in `core/cookies.txt`, `getPaths().cookiesPath` lo risolve correttamente).

**`catalog/catalogStore.js`**: cache in memoria + mutex asincrono (coda di promise) attorno a ogni mutazione, scrittura atomica su disco (`.tmp` + rename), e reconciliation all'avvio (`downloading → pending`) per gli scenari di crash a metà download. Durante l'implementazione è emerso un bug reale nella prima versione del mutex: se un `mutator` lanciava un errore (es. `decideVideo` su un video con stato sbagliato), la promise incatenata restava "rifiutata" per sempre, bloccando *tutte* le mutazioni successive (coda avvelenata). Corretto catturando l'errore internamente alla coda e ri-lanciandolo solo al chiamante che lo ha causato, così un errore di validazione isolato non blocca il resto del sistema.

**`ytdlp/ytdlpWrapper.js`**: usa `-o` con prefisso di tipo (`thumbnail:...`) per instradare le miniature in `media/thumbnails/` separatamente dai video in `media/videos/`, replicando la separazione prevista dalla struttura del progetto (altrimenti yt-dlp scrive tutto nella stessa cartella del video). Il progresso del download viene estratto con una regex sulle righe `[download] NN%`; l'hash sha256 è calcolato in streaming (non carica l'intero file in memoria). I metadati "il più possibile completi" vengono letti dal sidecar `.info.json` scritto da yt-dlp e mappati nello schema curato.

**`services/syncService.js`**, **`decisionService.js`**, **`videoService.js`**, **`playbackService.js`**: implementano esattamente la logica di stato descritta in `PIANO.md` (`new → pending/excluded → downloading → downloaded/failed`, auto-guarigione se un file scaricato sparisce dal disco).

**`jobs/jobManager.js`**: coda single-worker FIFO con `EventEmitter` per log/progress/status in tempo reale, persistenza su `data/jobs/<id>.json`. Per evitare di scrivere su disco a ogni singola riga di log di yt-dlp (molto verboso durante il download), la persistenza avviene ogni 25 righe più a ogni cambio di stato — un compromesso tra durabilità e I/O.

**Verifica end-to-end reale**: eseguito un test che usa *solo* le funzioni pubbliche di `core` (`decideVideo`, `triggerJob('downloadPending')`, `getJob`, `listVideos`) contro un video pubblico reale ("Me at the zoo", il primo video mai caricato su YouTube — scelto per la sua durata minima, ~19s). Il download è avvenuto per davvero: file mp4 scaricato e mergiato, miniatura convertita in jpg e spostata in `media/thumbnails/`, `.info.json` scritto e mappato correttamente nello schema (canale, statistiche, capitoli, sottotitoli disponibili, codec, sha256, ecc.), transizioni di stato `new → pending → downloading → downloaded` osservate tramite gli eventi del job manager. Al termine del test, i file e la entry di catalogo generati sono stati rimossi (non erano dati reali dell'utente, solo una verifica), riportando `data/catalog.json` a uno stato vuoto pulito.

`playVideo()` non è stato eseguito in questo test per evitare di aprire VLC automaticamente senza che l'utente lo stesse aspettando; la logica (risoluzione path, controllo esistenza file/eseguibile VLC) è stata solo letta/verificata staticamente.

## M6 — Il CLI a menu e la sourcelist

Costruito `packages/cli/cli.js` come REPL a **menu selezionabili con le frecce** (libreria `@inquirer/prompts`: `select`, `confirm`, `input`), non un REPL a comandi digitati — richiesta esplicita dell'utente, in stile "Claude Code". Ogni sotto-flusso (Gestisci fonti, Sincronizza, Rivedi novità, Scarica in coda, Guarda, Catalogo) è un ciclo `while (true)` con una voce "← Torna" sempre presente nella lista invece di un comando di annullamento digitato — questo copre anche l'esigenza di poter interrompere un wizard a metà senza bisogno di sintassi speciale.

**Sourcelist multi-playlist**: le fonti sono state spostate da `config.json` (array statico) a `catalog.json.sources` (mappa gestita da `catalogStore`, con mutex e scrittura atomica già pronti). `getSource()` in `config.js` è stato rimosso. Nuovo `core/src/services/sourceService.js`: `listSources()`, `addSource(url)`, `removeSource(sourceId)`. L'id di una fonte è l'id della playlist estratto dall'URL (dedup naturale), il nome è il titolo reale recuperato da YouTube (`ytdlpWrapper.getPlaylistEntries` ora ritorna anche `title`, non solo `entries`). Per evitare di duplicare la logica "trasforma entries in video new/auto-riparati" tra `syncSource` (già scritta) e la nuova `addSource`, è stato estratto l'helper condiviso `ingestPlaylistEntries()` in `syncService.js`.

**Playback con scelta video/audio**: `playbackService.playVideo(id, { mode })` — `mode: 'audio'` aggiunge il flag `--no-video` allo spawn di VLC. Nuova `videoService.listChannels({status})` (canali distinti + conteggio, con una `channelKey` esplicita per gestire il fallback quando `channel.id` è assente) e `listVideosByChannel(key, {status})`, usate dal flusso "Guarda".

### Bug reale scoperto durante la verifica: download falliti con HTTP 403

Verificando il download della playlist reale dell'utente (`https://www.youtube.com/watch?v=88RAHq3prwo&list=PLKi-4PIcn4dY`), i download fallivano sistematicamente con `HTTP Error 403: Forbidden` a percentuali basse. yt-dlp segnalava anche un warning: *"No supported JavaScript runtime could be found"* — YouTube richiede un runtime JS per decifrare le firme dei formati video più recenti, e senza di esso alcuni formati falliscono a metà scaricamento.

Diagnosticato e corretto in due parti:
1. **Runtime JS mancante**: aggiunto `--js-runtimes node` a ogni invocazione di yt-dlp in `ytdlpWrapper.js` (sia `getPlaylistEntries` sia `downloadVideo`) — Node è già una dipendenza del progetto, non serve installare altro (es. Deno).
2. **Formato AV1 specificamente bloccato**: anche con il runtime JS attivo, il formato scelto di default (`bv*+ba/b`, che seleziona AV1 alla risoluzione più alta) continuava a fallire con 403, mentre lo stesso video alla stessa risoluzione in **VP9** scaricava senza problemi. Diagnosticato isolando la variabile (stessa risoluzione, codec diverso) prima di cambiare codice. Corretto il format selector di default in `bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]` (sia in `DEFAULT_CONFIG.ytdlp.format` sia nel cap `maxHeight` di `buildFormatSelector`) — **nessun compromesso sulla qualità** (si ottiene comunque la risoluzione più alta disponibile, semplicemente non in AV1), coerente con la decisione già presa "massima qualità, nessun cap".

Nota per l'uso futuro: durante la verifica, ripetute richieste ravvicinate sullo stesso video hanno probabilmente innescato un throttling temporaneo lato YouTube specifico per quell'id (i tentativi successivi fallivano anche con il fix applicato, mentre un video diverso scaricava senza problemi nello stesso momento). Non è un problema del codice — il video `88RAHq3prwo` è stato lasciato in `catalog.json` con stato `pending` pulito (`attempts: 0`), pronto per un nuovo tentativo reale quando l'utente lo scaricherà dal CLI.

### Verifica end-to-end eseguita

- **Fonte reale**: `addSource()` sulla playlist fornita dall'utente → titolo recuperato correttamente ("ToDownload"), 1 video trovato come "novità". Ripetuto `addSource()` sullo stesso URL → dedup corretto (`alreadyExists: true`), nessun duplicato.
- **`syncSource`** su fonte già ingerita → `{newCount: 0, healedCount: 0}` corretto; su fonte inesistente → errore chiaro.
- **Download reale**: dopo il fix, un video pubblico di verifica ("Me at the zoo") scaricato con successo end-to-end tramite `triggerJob('downloadPending')`, log in tempo reale via `EventEmitter` osservati correttamente.
- **`listChannels`/`listVideosByChannel`**: verificato che raggruppano correttamente per canale e filtrano per canale.
- **`playVideo`**: verificato che apre VLC per davvero, sia in modalità video sia in modalità solo audio (`--no-video`).
- **Casi d'errore**: `addSource` con URL senza `list=`, `removeSource` su fonte inesistente, `decideVideo` chiamato due volte sullo stesso video, `playVideo` su un video non scaricato — tutti restituiscono messaggi di errore chiari senza eccezioni non gestite.
- **`removeSource`**: verificato con una fonte fittizia temporanea (per non toccare quella reale dell'utente) — rimossa correttamente dall'elenco, i video già catalogati restano intatti.
- Tutti i video/fonti di test sono stati ripuliti al termine; nel catalogo resta solo la fonte e il video reali forniti dall'utente.

### Verifica non eseguita (richiede l'utente)

La navigazione interattiva vera e propria (frecce + invio nel terminale) non è testabile in modo automatico da qui — verificata solo l'assenza di errori all'avvio (menu renderizzato correttamente) e tutta la logica sottostante chiamata direttamente. L'utente dovrà provare la navigazione a menu con `node packages/cli/cli.js` (o `npm run cli`, se aggiunto) per confermare l'esperienza reale.

## M6 (estensione) — Importazione di video già scaricati in precedenza

L'utente aveva già scaricato manualmente (fuori da questo tool) i video della playlist "bell asmr" prima di usare il CLI. Per evitare di doverli ri-scaricare, aggiunta una funzione di **importazione**: si punta un file video già presente in `media/videos/<id>.<ext>` e si recuperano i metadati completi da YouTube (`ytdlp.fetchMetadata()`, nuova funzione — spawn di yt-dlp con `--skip-download`, quindi nessun trasferimento del video, solo `.info.json` e thumbnail), si calcola sha256/size dal **file locale già presente** (non da uno ri-scaricato), e si marca `status: downloaded`.

**Nuovo `core/src/services/importService.js`**: `scanImportable()` (elenca i file candidati in `media/videos/` il cui nome corrisponde a un id valido) e `importLocalVideo(id)`. Riusa `mapInfoJsonToVideoFields` e `hashFileSha256` di `ytdlpWrapper.js`, ora esportate (prima erano funzioni private del modulo). Nuova voce di menu CLI "Importa video già scaricati".

**Bug reale trovato e corretto**: la prima versione di `scanImportable()` considerava "id" qualunque nome di file spogliato dell'estensione, senza validarlo — un file non ancora rinominato (es. `023 - [ASMR] Titolo.mkv`) veniva trattato come se il suo id fosse la stringa `"023 - [ASMR] Titolo"`, proposto come candidato valido all'importazione (avrebbe fallito silenziosamente al momento del recupero metadati, con un URL YouTube mal formato). Corretto validando che il nome file (senza estensione) rispetti esattamente il formato di un id YouTube (`[A-Za-z0-9_-]{11}`) prima di considerarlo un candidato.

**Rinomina dei file dell'utente**: l'utente aveva 60 file scaricati manualmente, nominati `"NNN - Titolo.ext"` (NNN = posizione nella playlist), con **11 duplicati reali** (stesso video scaricato più volte — stessa dimensione in byte, confermato) e due video diversi con **titolo identico** ("[ASMR] Come Study With Me", id `nOzFO4Be6jY` e `Q8-Wvfrvgvc`) che rendevano il solo confronto per titolo inaffidabile. Risolto ri-scaricando l'elenco grezzo e ordinato della playlist (`yt-dlp --flat-playlist -J`, sola lettura, nessun file toccato) per ottenere la corrispondenza posizione→id esatta e affidabile anche in presenza di duplicati, poi rinominato un solo file per ogni id univoco (49 file) a `<id>.<ext>`; gli 11 file duplicati sono stati **lasciati intatti con il nome originale** (non cancellati) — non risultano più candidati all'importazione grazie al fix sopra, ma restano sul disco a disposizione dell'utente per un'eventuale pulizia manuale.

Verificato con un test reale (file fittizio con id vero + metadati recuperati davvero da YouTube, poi ripulito): `scanImportable` rileva correttamente il file, `importLocalVideo` recupera titolo/canale reali, calcola l'hash dal file locale, marca `downloaded`; verificato anche il caso "nessun file trovato" e l'errore per un id inesistente.

## M6 (estensione) — Consolidamento metadati grezzi in `data/metadata.json`

L'utente ha notato che ogni video scaricato/importato lasciava un sidecar `media/videos/<id>.info.json` sparso accanto al file video, e ha chiesto un unico file dentro `/data`. Verificato (sola lettura, prima di decidere il design): 44 file `.info.json` esistenti, **23MB totali** — molto più del previsto, principalmente per `automatic_captions` (elenco di URL per sottotitoli auto-tradotti in 157 lingue, dentro ogni singolo file, quasi mai utile).

Decisioni prese con l'utente:
- **File separato** da `catalog.json`: `data/metadata.json`, non fuso nell'unico catalogo. Motivazione — `catalog.json` viene riscritto per intero ad ogni piccola modifica (una decisione, una sync), mentre i metadati grezzi si scrivono solo a download/importazione (rari); fondere i due file avrebbe significato riscrivere decine di MB ad ogni minima azione.
- **Alleggerire**: rimuovere `automatic_captions` prima di salvare, mantenere tutto il resto (formats, heatmap, capitoli, ecc.) integralmente — nessuna perdita di informazioni realmente utili.

**Nuovo `core/src/catalog/metadataStore.js`**: ricalca esattamente il pattern già collaudato di `catalogStore.js` (cache in memoria, mutex a coda di promise, scrittura atomica `.tmp`+rename). `setMetadata(id, info)` rimuove `automatic_captions` con una destructuring assignment prima di salvare — punto unico di alleggerimento, ogni chiamante ne beneficia automaticamente. Nuovo `core/src/services/metadataService.js`: `getRawMetadata(id)`.

**`ytdlpWrapper.js`**: sia `downloadVideo()` sia `fetchMetadata()` (usata dall'importazione) ora, dopo aver letto il sidecar `.info.json` scritto da yt-dlp, chiamano un nuovo helper interno `consolidateMetadata()` che salva il contenuto in `metadataStore` e **cancella il sidecar**. Il campo `metadataRawPath` (un nome di file, per-video) è stato **rimosso dallo schema** (`catalogSchema.js`, `mapInfoJsonToVideoFields()`): non serve più un "percorso" dato che il lookup è sempre per id nello stesso `metadata.json`.

**Migrazione una tantum**: script eseguito una sola volta (non parte del codice permanente) che ha letto i sidecar `.info.json` già presenti, li ha salvati in `metadata.json` tramite lo stesso `setMetadata()`, cancellati, e ha ripulito il campo `metadataRawPath` residuo dalle entry già scaricate nel catalogo. Risultato reale: **49 file migrati** (nel frattempo l'utente aveva lanciato l'importazione su tutta la playlist, non più solo 44), `metadata.json` finale **8.26MB** (contro i 23MB dei sidecar originali — circa 65% in meno grazie alla rimozione di `automatic_captions`), nessun `.info.json` rimasto in `media/videos/`.

**Pulizia dei file duplicati**: i probabili 11 file duplicati identificati durante la milestone precedente (rinomina) risultavano già rimossi dal disco al momento di eseguire questa pulizia (probabilmente cancellati manualmente dall'utente nel frattempo) — nessuna azione necessaria, verificato che `media/videos/` contiene esattamente 49 file, tutti nel formato `<id>.<ext>`.

Verificato con un test reale end-to-end (importazione di un video pubblico noto): nessun `.info.json` lasciato accanto al video dopo l'importazione, `getRawMetadata(id)` ritorna il metadato corretto senza `automatic_captions`, il resto della pipeline (catalogo, CLI) continua a funzionare invariato.

## M6 (estensione) — Vista unica "Rivedi novità" + possibilità di cambiare decisione

L'utente aveva due richieste collegate: (1) poter rivedere/vedere anche le novità già decise (non solo quelle ancora `new`), non solo quelle da decidere ora; (2) non aveva modo di togliere un video dagli archiviati o togliere un video dalla coda di download una volta deciso — le decisioni erano a senso unico. Ha anche chiesto esplicitamente di **nascondere "Scarica in coda" sotto "Rivedi novità"** invece di tenerlo come voce separata del menu principale, per avere un unico posto dove rivedere le novità, decidere, e poi lanciare il download.

**`decisionService.decideVideo()` esteso**: prima accettava solo `'download'|'exclude'` e solo a partire dallo stato `new` (decisione a senso unico, errore su qualunque altro stato). Ora accetta anche `'undecided'` (torna a `new`, annulla la decisione) ed è ammesso liberamente tra qualunque coppia di `new`/`pending`/`excluded` — non solo da `new` verso gli altri due, ma anche `pending → excluded`, `excluded → pending`, e il ritorno a `new` da entrambi. Resta bloccato per `downloading`/`downloaded`/`failed`, fuori dal ciclo di revisione novità. `decidedAt` torna `null` quando si rientra in `new`.

**CLI**: `reviewNewFlow` (solo `new`) e `downloadQueueFlow` (voce separata del menu principale) sono stati sostituiti da un'unica `reviewFlow`. Elenca insieme tutti i video `new`/`pending`/`excluded` con un'icona per lo stato (🆕/⬇️/🗄️), più una voce in cima **"▶ Scarica in coda (N)"** (visibile solo se c'è almeno un video `pending`) che lancia lo stesso identico flusso di download di prima, ma nidificato in questa vista. Le azioni proposte per ogni video dipendono dal suo stato attuale (mappa `REVIEW_ACTIONS_BY_STATUS`): da `new` si decide (Scarica/Archivia), da `pending`/`excluded` si può sia spostarsi direttamente all'altro esito sia "Rimettere tra le novità" (tornare a `new`).

Verificato con il video reale rimasto in coda (`88RAHq3prwo`): transizione completa `pending → excluded → new → pending` tramite `decideVideo`, tutte riuscite; verificato anche l'errore su una decisione non valida. Il filtro della vista unificata (`new`/`pending`/`excluded`) e il conteggio della coda testati contro i dati reali del catalogo. Il video è stato lasciato nello stesso stato (`pending`) in cui si trovava prima del test, nessun impatto sui dati reali dell'utente.

## M6 (bug fix) — File orfani lasciati da un download fallito

L'utente ha segnalato che l'ultimo video tentato non compariva in "Guarda" e sembrava "interrotto". Verifica in `media/videos/`: il video (`88RAHq3prwo`) aveva fallito di nuovo con `HTTP 403` (stesso problema intermittente già documentato — probabile throttling di YouTube su questo video/formato ad alto bitrate, non un problema di codice), ma questa volta aveva lasciato tre file orfani nella cartella: il `.part` del video (parziale, atteso), il sidecar `.info.json` e una miniatura `.jpg` — questi ultimi due non referenziati da nessuna entry `downloaded` nel catalogo, quindi invisibili ovunque nel CLI ma comunque presenti su disco.

Causa: `ytdlpWrapper.downloadVideo()` non aveva alcuna gestione di pulizia sul percorso di errore — se yt-dlp falliva dopo aver già scritto `.info.json`/thumbnail (cosa che fa presto nel suo processo, prima ancora di iniziare a scaricare il video vero e proprio), quei file restavano semplicemente lì.

Corretto con `cleanupFailedDownloadArtifacts()`, richiamata in un blocco `catch` che avvolge ora l'intero corpo di `downloadVideo()`: su qualunque errore, cancella tutti i file `<id>.*` nella cartella video/thumbnail **tranne** il video stesso e il suo `.part` — quest'ultimo viene deliberatamente preservato perché yt-dlp lo userà per riprendere il download da dove si era interrotto al prossimo tentativo, invece di ripartire da zero. Ripuliti manualmente anche i 2 file orfani già presenti (info.json + jpg), lasciato il `.part` esistente.

Verificato con un nuovo tentativo reale sullo stesso video: fallito di nuovo con lo stesso 403 (il problema di fondo, il throttling di YouTube su questo video, resta — da riprovare più avanti dall'utente), ma stavolta la pulizia automatica ha funzionato correttamente: dopo il fallimento è rimasto solo il `.part`, nessun file orfano.

## M6 (bug fix) — Stato "failed" mancante nella vista unificata "Rivedi novità"

Il tentativo di download appena documentato ha lasciato il video in stato `failed`. Segnalato dall'utente: non lo vedeva più da nessuna parte nel CLI — non in "Guarda" (corretto, non è mai stato scaricato), ma nemmeno in "Rivedi novità", dove invece ci si aspetterebbe di poterlo rivedere/riprovare.

Causa: quando ho unificato "Rivedi novità" e "Scarica in coda" nella vista unica (milestone precedente), ho riportato solo gli stati `new`/`pending`/`excluded` nella lista visibile — dimenticando `failed`. Il vecchio `downloadQueueFlow` separato includeva correttamente i falliti ritentabili nel proprio conteggio, ma quella logica non è stata propagata alla nuova vista unificata: un video fallito diventava invisibile e irraggiungibile dal CLI, anche se `runDownloadQueue()` lo avrebbe comunque riscaricato automaticamente se fosse stato visibile.

Corretto in due punti:
- `decisionService.js`: `failed` aggiunto agli stati revisionabili da `decideVideo()` — ora si può decidere manualmente "Riprova" (→ `pending`), "Archivia" (→ `excluded`) o "Rimetti tra le novità" (→ `new`) anche da un video fallito, non solo tramite il retry automatico del job. Quando si esce da `failed` con una decisione manuale, `attempts` e `error` vengono azzerati — un "ricomincia da capo" deliberato, altrimenti un video con tentativi automatici già esauriti (`attempts >= maxAttempts`) resterebbe escluso dalla prossima "Scarica in coda" anche dopo una scelta esplicita dell'utente.
- `cli.js`: `failed` aggiunto a `REVIEW_STATUS_ICON`/`REVIEW_STATUS_LABEL`/`REVIEW_ACTIONS_BY_STATUS` (icona ⚠️, azioni Riprova/Archivia/Rimetti tra le novità); il conteggio di "▶ Scarica in coda (N)" ora usa lo stesso criterio di idoneità del job (`pending` oppure `failed` con tentativi non esauriti), non più solo `pending`. Selezionando un video fallito, il messaggio d'errore viene mostrato prima di chiedere l'azione, per capire subito perché è fallito senza dover consultare `Catalogo`.

Verificato con il video reale rimasto fallito (`88RAHq3prwo`, 2 tentativi su 3): ora compare in "Rivedi novità" con l'icona ⚠️, il conteggio della coda lo include correttamente, e `decideVideo(id, 'download')` lo riporta a `pending` con `attempts: 0` e `error: null`.

## M6 (bug fix) — Causa reale del 403 persistente su `88RAHq3prwo`: esperimento PO Token di YouTube

Il video ha continuato a fallire con `HTTP 403` anche dopo il fix `--js-runtimes node` + esclusione AV1 (che restavano comunque necessari e corretti per il problema che risolvevano). Fin qui era stato attribuito genericamente a "throttling" — l'utente ha chiesto di indagare più a fondo invece di accettare quella spiegazione.

Diagnosticato con `yt-dlp -v --simulate` (nessun download, solo log dettagliato): righe chiave —
```
[youtube] [pot] PO Token Providers: none
[youtube] 88RAHq3prwo: Detected experiment to bind GVS PO Token to video ID for web_safari client
[youtube] 88RAHq3prwo: Some web_safari client https formats have been skipped as they are missing a URL. YouTube is forcing SABR streaming for this client.
```
Questo video specifico è stato assegnato da YouTube a un esperimento che richiede un **PO Token** ("Proof of Origin", parte del sistema anti-bot di YouTube) per ottenere URL di streaming validi dai client "normali" (web, ios, tv — testati singolarmente, tutti falliti: `tv` con DRM, `ios` con l'errore esplicito "requires a GVS PO Token which was not provided"). Senza un provider di PO Token configurato (richiederebbe un plugin aggiuntivo, es. `bgutil-ytdlp-pot-provider`), questi client restano bloccati per questo video specifico — spiega perché i 49 video di "bell asmr" scaricavano senza problemi (non soggetti all'esperimento) mentre questo continuava a fallire in modo ripetibile, non intermittente come ipotizzato in precedenza.

Testato `--extractor-args "youtube:player_client=android_vr"`: il client Android VR **non è soggetto a questo esperimento** e fornisce URL funzionanti — verificato con due download reali completi (2.58GB, formato atteso 313+251) fino al 100%. Corretto `ytdlpWrapper.js` aggiungendo `player_client=default,android_vr` (client supplementare, non sostitutivo) a tutte e tre le invocazioni di yt-dlp (`getPlaylistEntries`, `fetchMetadata`, `downloadVideo`): i video non soggetti all'esperimento continuano a usare i client abituali invariati, quelli soggetti trovano comunque formati funzionanti via android_vr nella stessa esecuzione, senza bisogno di configurazione aggiuntiva o di un provider di PO Token esterno.

**Secondo livello del problema, scoperto solo dopo aver applicato il fix sopra**: il video continuava a fallire con 403 anche con `android_vr` **attraverso il codice di produzione**, mentre gli stessi comandi lanciati a mano da terminale riuscivano sempre. Diagnosticato per differenza: il codice di produzione passa `--cookies core/cookies.txt` (i cookie reali del browser dell'utente) a ogni download, i test manuali no. Riprodotto l'errore a mano aggiungendo `--cookies` allo stesso comando che prima funzionava: fallisce di nuovo, sempre intorno al 3-4% — la percentuale esatta dei fallimenti originali. **Causa**: inviare cookie di sessione di un browser desktop insieme a un'identità client mobile (`android_vr`) è una combinazione che la CDN video di YouTube tratta come sospetta e blocca, anche se le fasi precedenti (estrazione pagina, metadati, player API) con quegli stessi cookie vanno a buon fine — il blocco scatta specificamente sulla richiesta dei byte del video.

Corretto rendendo `downloadVideo()` a due tentativi: il primo **senza cookie** (funziona per tutto il contenuto pubblico, il caso normale — nessun video nel catalogo dell'utente è privato); solo se questo fallisce **e** sono configurati dei cookie, si ripulisce l'eventuale residuo e si ritenta **con** i cookie (preserva la funzione originale di `core/cookies.txt`: accedere a video privati/non listati del proprio account, per cui i cookie restano necessari). Estratti due helper (`buildDownloadArgs`, `runYtdlp`) per non duplicare la costruzione degli argomenti/lo spawn tra i due tentativi.

Verificato con il download reale finale del video dell'utente: completato con successo al primo tentativo (senza cookie), 2.58GB, sha256 calcolato, thumbnail spostata correttamente in `media/thumbnails/`, stato `downloaded`. Il catalogo dell'utente è ora completo: **50/50 video scaricati** (49 "bell asmr" + 1 "ToDownload"), tutti visibili in "Guarda".

## Push iniziale su GitHub

Su richiesta dell'utente, caricato il progetto su `https://github.com/Helmutsti/YouTubeCatalog.git` (repository esistente ma vuoto). Prima del commit, revisione manuale dell'elenco file che sarebbero stati tracciati (`git add -A -n`) e scansione per pattern di segreti/credenziali comuni — nessun problema trovato, ma scoperta e aggiunta al `.gitignore` una cartella `.claude/` (stato interno di Claude Code, non parte del progetto) che si era infilata tra i file non ignorati. Tutti i dati personali/generati restano correttamente esclusi (`media/`, `data/catalog.json`, `data/config.json`, `data/metadata.json`, `data/jobs/`, `tools/yt-dlp.exe`, `core/cookies.txt`) — nel repository solo codice sorgente, configurazione di esempio e documentazione.

## M7 — Motore di ricerca nel CLI

Nuova voce di menu "Cerca": ricerca fuzzy multi-campo (titolo, canale, tag, descrizione) su tutto il catalogo, qualunque stato.

**Decisione presa durante l'implementazione**: la prima versione usava la libreria `fuzzysort` come dipendenza di `core`. L'utente ha richiesto esplicitamente che `core` non abbia alcuna dipendenza esterna (coerente con il principio già seguito fin dall'inizio — niente `yt-dlp-wrap`, niente sqlite/lowdb). Rimossa la dipendenza, riscritto l'algoritmo a mano in `core/src/services/searchService.js`:
- Corrispondenza fuzzy (finestra scorrevole + distanza di Levenshtein, soglia proporzionale alla lunghezza della parola) sui campi brevi (titolo, canale, tag).
- Solo sottostringa esatta sulla descrizione (campo lungo).

**Bug reale trovato e corretto durante il test**: la primissima versione scritta a mano usava una sottosequenza libera su tutto il testo (i caratteri della parola cercata compaiono in ordine, ovunque, anche molto distanziati) applicata a tutti i campi inclusa la descrizione. Con testi lunghi questo produce rumore: una query di due parole con un typo intenzionale ("bel gramar") restituiva 20 risultati quasi casuali invece del solo video pertinente, perché quasi ogni descrizione lunga contiene da qualche parte, sparse, le lettere di una parola breve. Corretto restringendo la tolleranza a errori di battitura ai soli campi brevi (dove è economica ed effettivamente utile) e usando solo sottostringa esatta sulla descrizione. Riverificato: la stessa query ora restituisce esattamente 1 risultato corretto.

**CLI**: nuova voce "Cerca", usa il prompt `search` di `@inquirer/prompts` (filtro dal vivo mentre si digita — unica altra eccezione al "niente testo digitato" oltre ad "Aggiungi fonte"). Selezionato un risultato, le azioni disponibili dipendono dal suo stato attuale — **nessuna logica nuova**: per `downloaded` riusa `playVideoWithModeChoice` (estratta da `watchChannelFlow`), per `new`/`pending`/`excluded`/`failed` riusa `applyReviewDecision` (estratta da `reviewFlow`), per `downloading` solo un messaggio informativo. Le due funzioni sono state estratte dai flussi esistenti proprio per essere condivise, senza duplicare codice già scritto e testato.

Verificato con il catalogo reale dell'utente: `"bel gramar"` (typo) → 1 risultato corretto; `"sampuma"` (typo sul nome canale "Sampurna ASMR") → trova comunque il video giusto; `"indian"` → 1 risultato esatto; query senza corrispondenze → 0 risultati; instradamento delle azioni per stato verificato contro dati reali (video `downloaded` → azione di riproduzione). `core` è tornato a **zero dipendenze esterne** dopo la rimozione di `fuzzysort`.

## M8 — Download singolo one-off

Nuova voce di menu "Scarica video singolo": incollato un link, il video viene scaricato subito senza passare dal meccanismo delle fonti/sync di playlist (`Gestisci fonti` → `Sincronizza` → `Rivedi novità`), pensato per intere playlist e non per un singolo video occasionale.

**Nuovo `core/src/services/singleVideoService.js`**, unica funzione pubblica `prepareSingleVideoDownload(url)`:
- `extractVideoId()` riconosce `watch?v=ID` (un eventuale `list=` viene ignorato deliberatamente — un video dentro una playlist va comunque trattato come singolo), `youtu.be/ID`, `shorts/ID`, `live/ID`, `embed/ID`, oppure un id nudo di 11 caratteri.
- Se l'id è già `downloaded`/`downloading` nel catalogo, nessuna mutazione: si informa e basta. Se è già tracciato con un altro stato (`new`/`pending`/`failed`/`excluded`, cioè già gestito da una fonte esistente), il flusso **si rifiuta** e rimanda a "Rivedi novità" — decisione presa con l'utente per non scavalcare una revisione già impostata da una sync di playlist.
- Se l'id non è nel catalogo, crea uno stub (`createNewVideoStub`, già usato da `ingestPlaylistEntries`) con `status: pending` e — punto chiave — `source: { sourceId: null, type: 'single' }`: un video con `source.sourceId: null` non viene mai enumerato da `syncSource()`, che itera solo gli entries di una fonte registrata in `catalog.sources`. Questo è l'intero meccanismo che garantisce "non passa mai per i canali di sincronizzazione", senza bisogno di nessuna logica di esclusione esplicita altrove.
- Il download vero e proprio riusa **senza modifiche** il job `downloadSingle` già esistente (`core/src/jobs/jobs/downloadSingle.js`), finora usato solo implicitamente per i retry manuali dei falliti.

**CLI**: nuova voce "Scarica video singolo" nel menu principale, subito dopo "Gestisci fonti". Il blocco che segue lo stato di un job in tempo reale (log live + attesa di `success`/`failed`) era duplicato identico in `runDownloadQueue()`: estratto in un helper condiviso `runJobToCompletion(jobId)`, riusato sia dal download in coda sia dal nuovo download singolo.

**Verifica eseguita** (senza toccare i dati reali dell'utente): test unitario di `extractVideoId()` su 12 casi (tutti i formati URL supportati, id nudo con spazi, URL con `list=` extra, URL di sola playlist → `null`, stringa non valida → `null`) — tutti corretti. Verificata la superficie pubblica di `core/src/index.js` (`prepareSingleVideoDownload` esportata). Verificato con un id reale già `downloaded` nel catalogo dell'utente (`88RAHq3prwo`) che `prepareSingleVideoDownload` ritorna `already-downloaded` **senza scrivere nulla** — confermato confrontando l'hash sha256 di `data/catalog.json` prima e dopo la chiamata, identico. Verificato l'avvio del CLI (`node packages/cli/cli.js`): il menu principale mostra correttamente la nuova voce nella posizione attesa.

## M9 — Rimozione "Importa video già scaricati"

"Importa video già scaricati" (`scanImportable`/`importLocalVideo`, costruita in M6) era nata per assorbire in un colpo solo i 49 video che l'utente aveva già scaricato manualmente prima di adottare questo tool — uno script di migrazione una tantum, non una funzionalità pensata per restare. Su richiesta esplicita dell'utente, rimossa del tutto: né la voce di menu né il codice sottostante restano nel progetto.

Rimosso: `core/src/services/importService.js` (file eliminato interamente), la voce di menu "Importa video già scaricati" e la funzione `importFlow()` in `packages/cli/cli.js`, l'import/export di `scanImportable`/`importLocalVideo` in `core/src/index.js`, e `fetchMetadata()` in `core/src/ytdlp/ytdlpWrapper.js` — verificato con una ricerca nel repo che il suo unico chiamante fosse `importLocalVideo`, quindi diventata codice morto una volta rimosso quest'ultimo. Le altre funzioni che `importService.js` importava da `ytdlpWrapper.js` (`hashFileSha256`, `getYtdlpVersion`, `mapInfoJsonToVideoFields`) restano invariate: sono condivise con `downloadVideo()` e continuano a servire.

Nessun impatto sui 49 video già importati in M6: restano entry `downloaded` regolari in `data/catalog.json`, indipendenti dal codice che li ha creati — rimuovere la funzionalità non tocca dati già scritti (verificato: nessuna differenza nell'hash del catalogo prima/dopo le modifiche a questa milestone).

La milestone storica **M6 non è stata riscritta**: descrive correttamente cosa fu costruito e verificato all'epoca, incluso lo script di importazione allora esistente — resta un record accurato di come i 49 video sono realmente arrivati nel catalogo, anche se quello strumento non esiste più nel codice attuale.

**Verifica eseguita**: `node --check` su tutti i file toccati; ricerca nel repo per `importFlow`/`scanImportable`/`importLocalVideo`/`fetchMetadata` → nessun riferimento residuo; avvio reale del CLI → il menu principale non mostra più la voce.

## Nota: reset della schermata CLI (rimandato)

L'utente ha chiesto anche un reset della schermata a ogni menu/sottomenu (i vecchi elenchi restano stampati sopra i nuovi, rendendo il terminale illeggibile dopo pochi giri). Progettazione discussa e già pronta (helper condivisi `clearScreen()`/`setMessage()` in `cli.js`, applicati a ogni `while(true)` di menu) — annotata in `PIANO.md` come idea in discussione, ma **non implementata in questa sessione**: l'utente ha chiesto esplicitamente di rimandarla.
