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

## M8 (correzione) — Supporto multi-sito (Rumble e altri, non solo YouTube)

Segnalato dall'utente: "Scarica video singolo" doveva accettare qualunque sito che `yt-dlp.exe` sa gestire (Rumble compreso), esattamente come il binario stesso — non solo YouTube. La prima versione era invece YouTube-only in due punti indipendenti, entrambi bug reali confermati testando un video Rumble end-to-end.

**Riconoscimento del sito**: `extractVideoId()` era un regex scritto a mano che riconosceva solo pattern di URL YouTube (`watch?v=`, `youtu.be/`, `shorts/`, ecc.) — qualunque altro sito veniva respinto con "URL non riconosciuto" prima ancora di provare. Sostituito con `ytdlpWrapper.resolveVideoInfo(url)` (nuovo): un'unica chiamata a yt-dlp (`--skip-download -J`) che risolve id/titolo/canale/durata/`extractor`/`webpage_url` per **qualunque sito che yt-dlp sa gestire**, senza bisogno di mantenere una lista di pattern URL per ogni sito — è yt-dlp stesso a fare il riconoscimento, non il nostro codice. `createNewVideoStub()` (`catalogSchema.js`) esteso per accettare `webpageUrl`/`originalUrl`/`extractor` reali invece dei default hardcoded per YouTube (i chiamanti esistenti, le fonti/playlist, restano YouTube-only per design e non passano questi parametri, quindi i default restano invariati per loro).

**Bug nascosto, trovato solo scaricando per davvero**: anche dopo il fix sopra, `ytdlpWrapper.downloadVideo(videoId, ...)` continuava a costruire da sé `https://www.youtube.com/watch?v=${videoId}` come URL da passare a yt-dlp, **ignorando il sito reale** — per le fonti/playlist (YouTube-only per design) l'id coincideva sempre con un video YouTube valido, quindi il bug non si vedeva; per un video Rumble, avrebbe scaricato l'URL YouTube sbagliato (o fallito con id non valido). Corretto: `downloadVideo(videoId, url, {...})` ora accetta l'URL reale come parametro esplicito — passato da `video.webpageUrl` sia da `downloadSingleJob` sia da `downloadPendingJob` — e lo usa direttamente; `videoId` resta usato solo per ritrovare i file scritti da yt-dlp dopo il download (stesso id nel template `-o "%(id)s.%(ext)s"`).

**Secondo bug, trovato nello stesso test**: il primo download Rumble reale è fallito con `ERROR: Requested format is not available`. Causa: il format selector di default (`bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]`) esclude l'AV1 su **entrambe** le sue alternative — un workaround specifico per un problema di YouTube documentato in M6 (l'AV1 falliva sistematicamente con 403). Su Rumble, dove il formato disponibile è probabilmente proprio (o solo) AV1, questo filtro escludeva l'unica opzione scaricabile, senza un fallback che la recuperasse. Corretto aggiungendo un ultimo fallback **senza filtro AV1** (`.../b`) sia al default in `config.js`/`config.example.json`/`config.json` sia al ramo con `maxHeight` impostato in `buildFormatSelector()`: su YouTube l'esclusione AV1 continua a valere nella pratica (le alternative filtrate quasi sempre trovano un formato non-AV1 valido, verificato riscaricando lo stesso video di test), sugli altri siti si scarica comunque il meglio disponibile invece di fallire.

**Verifica end-to-end reale eseguita** (non solo lettura del codice): `resolveVideoInfo()` testato contro un video YouTube reale e un video Rumble reale ("Winter-loving dog helps girls dig a snow fort", `rumble.com/vdmum1-...`) — entrambi risolti correttamente (id, titolo, canale, `extractor` giusto: `youtube` vs `RumbleEmbed`). Poi l'intera pipeline `prepareSingleVideoDownload` → `triggerJob('downloadSingle')` → download reale eseguita per entrambi i video: scaricati per davvero, mergiati, marcati `downloaded`, con `extractor`/`webpageUrl`/`originalUrl` corretti nel catalogo e `source: { sourceId: null, type: 'single' }`. File, entry di catalogo, entry di `data/metadata.json` e righe nel download-archive generati dal test sono stati rimossi al termine — nessun residuo nei dati reali dell'utente (il catalogo è tornato a 50/50 video, lo stato precedente al test).

## Reset della schermata CLI

I menu (`@inquirer/prompts` dentro cicli `while(true)`) non pulivano mai il terminale: ogni vecchia versione di un elenco (es. "Rivedi novità" dopo ogni decisione, "Guarda" scorrendo canali/video) restava stampata sopra le nuove e dopo pochi giri lo schermo diventava illeggibile. Richiesta rimandata in una sessione precedente, ora implementata seguendo il design già discusso in `PIANO.md`.

**Due helper condivisi in `packages/cli/cli.js`**:
- `clearScreen()` — pulisce il terminale (`console.clear()`, **solo se `process.stdout.isTTY`** per non rompere output rediretto/pipe) e subito dopo ristampa l'eventuale messaggio in sospeso.
- `setMessage(text)` — mette in coda un messaggio "da leggere". Una singola variabile globale `pendingMessage` è sufficiente perché il CLI è bloccante (un solo flusso interattivo alla volta).

**Applicazione**:
- Ogni ciclo `while(true)` di menu/sottomenu (`mainMenu`, `manageSourcesFlow`, `reviewFlow`, `watchFlow`, `watchChannelFlow`, `searchFlow`) chiama `clearScreen()` come **prima istruzione**, prima di ricalcolare/ristampare l'elenco.
- Ogni output "da leggere" non in tempo reale (conferme, riepiloghi, elenchi informativi di `listSourcesFlow`/`syncFlow`/`catalogFlow`, esiti di `addSource`/`removeSource`/`decideVideo`/`playVideo`, messaggi di errore del menu principale) è passato da `console.log` diretto a `setMessage()`, così sopravvive esattamente a una pulizia (ristampato una volta sopra il menu successivo, poi scartato) invece di sparire subito o restare per sempre.

**Eccezione deliberata**: lo streaming live dei log di un job in corso (`runJobToCompletion`, righe di yt-dlp riga per riga) resta `console.log` diretto — deve scorrere in tempo reale, non ha senso metterlo in coda. Solo la riga di riepilogo finale del job (successo/fallimento) passa da `setMessage()`. Anche il messaggio d'errore mostrato prima del select in `applyReviewDecision` resta diretto: è contesto immediato del prompt che segue, non un esito post-azione.

Le entry informative di flussi "usa e getta" (non-loop) come `syncFlow`/`catalogFlow`/`addSourceFlow` usano `setMessage()` e si affidano al `clearScreen()` del ciclo chiamante (mainMenu o il sottomenu) per la ristampa: il messaggio compare sopra il menu al giro successivo.

Verificato: `node --check packages/cli/cli.js` passa. La navigazione interattiva vera e propria (frecce + pulizia schermo a ogni passo) va confermata dall'utente lanciando il CLI, non essendo testabile in automatico da qui.

## Archivio canonico per creator con nomi leggibili

Fino a qui i video vivevano **piatti** in `media/videos/<id>.<ext>` (es. `88RAHq3prwo.mp4`): tutti i creator mescolati, nome = id YouTube, cartella non consultabile da Esplora File. Su richiesta dell'utente si è cambiato il **layout canonico** in `media/videos/<Creator>/<Titolo> [<id>].<ext>` — la convenzione di default di yt-dlp (`%(title)s [%(id)s].%(ext)s`), con sottocartella per creator.

**Perché cambiare l'archivio (opzione 1 di `PIANO.md`) e non un export via hard link (opzione 2)**: in una discussione precedente si era propeso per l'export a hard link proprio per non toccare i file già scaricati. L'utente ha però scelto esplicitamente di cambiare l'archivio vero e proprio — un solo posto, non una vista duplicata. Il costo del re-lavoro sui file esistenti è assorbito da una funzione di migrazione riusabile (vedi sotto), non da un rinominare a mano.

**Nome file: id sempre presente.** Il suffisso `[<id>]` è **sempre** nel nome (come yt-dlp), non solo in caso di collisione. Questo risolve da sé il problema dei titoli duplicati nello stesso canale (caso reale già visto: due "[ASMR] Come Study With Me"): id diversi → nomi file diversi, nessuna logica speciale di deduplica necessaria.

### Modifiche a `core/src/ytdlp/ytdlpWrapper.js`

- **Template `-o`** in `buildDownloadArgs()`: da `%(id)s.%(ext)s` a `%(channel,uploader|Sconosciuto)s/%(title)s [%(id)s].%(ext)s`. yt-dlp **sanifica da solo** i caratteri non validi per Windows e crea le sottocartelle; il fallback `|Sconosciuto` copre i rari casi senza `channel`/`uploader`. L'`.info.json` segue automaticamente lo stesso template (finisce nella sottocartella creator). Il template della **thumbnail resta invariato**: `media/thumbnails/<id>.jpg` piatto (le thumbnail sono interne, non sfogliate dall'utente → nessuna migrazione thumbnail).
- **`findDownloadedFiles()`**: prima cercava piatto per prefisso id (`startsWith("<id>.")`); ora fa un **walk ricorsivo** di `videosDir` e trova video/`.info.json` il cui basename contiene il marker `[<id>]`. L'id è univoco → match robusto qualunque sia la sanitizzazione fatta da yt-dlp sul titolo/creator. Ritorna il video/info come **percorso relativo a `videosDir`** (separatori normalizzati a `/`), che finisce direttamente in `video.localPath`.
- **`cleanupFailedDownloadArtifacts()`**: reso ricorsivo con lo stesso criterio (`[<id>]`), continua a preservare il file video e il `.part` per il resume, ripulendo `.info.json`/altri artefatti nella sottocartella creator.
- **Nessuna modifica** a `downloadVideo()` e `mapInfoJsonToVideoFields()`: risolvevano già i path con `path.join(videosDir, X)` e derivavano `container` da `path.extname` — entrambi funzionano trasparentemente con un `localPath` che ora include la sottocartella.

**Perché playback e sync non cambiano**: sia `playbackService.playVideo()` sia l'auto-guarigione in `syncService` risolvono il file come `path.join(videosDir, video.localPath)`. Trasformare `localPath` in un percorso relativo con sottocartella è quindi trasparente per loro — verificato leggendo tutti i consumatori di `localPath`/`videosDir`.

### Migrazione dei file esistenti — `core/src/services/libraryService.js` (nuovo)

`reorganizeLibrary({ dryRun = false })`, esportata da `core/src/index.js`, **idempotente e riusabile** (non uno script usa-e-getta: serve ora per migrare i video già scaricati nel vecchio layout piatto, e in futuro se cambiano titoli o si vuole riallineare l'archivio):

- Per ogni video `downloaded`: calcola il target canonico (`targetRelPath()`), individua il file attuale (`localPath` registrato, con fallback a ricerca ricorsiva per `<id>.<ext>` piatto o marker `[<id>]`), e se non è già al posto giusto lo **sposta** (`renameSync`, istantaneo sullo stesso volume) nella sottocartella creator, aggiornando `video.localPath` nel catalogo via `updateCatalog`.
- **Idempotente**: i video già al target vengono contati come `alreadyOk` e saltati; una seconda esecuzione non sposta nulla. I `downloaded` senza file su disco finiscono in `missing` (segnalati, non tentati).
- **`dryRun`**: ritorna solo il piano (`planned: [{id, from, to}]`) senza toccare nulla — usato dal CLI per mostrare l'anteprima prima della conferma.
- **`sanitizeName()`**: sanitizer Windows scritto a mano (rimuove `< > : " / \ | ? *` + control char, collassa spazi, toglie spazi/punti finali, gestisce i nomi riservati `CON`/`PRN`/…, fallback su id/`Sconosciuto`, taglia i titoli oltre 150 char preservando `[<id>].<ext>`). Non serve parità esatta con yt-dlp: i lookup dei file avvengono per marker `[<id>]`, non per nome.
- Al termine rimuove le eventuali sottocartelle rimaste vuote.

**CLI**: nuova voce menu "Riorganizza libreria (per creator)" (`packages/cli/cli.js`, `reorganizeFlow`): esegue prima un `dryRun` e mostra gli spostamenti previsti (contesto immediato → `console.log` diretto), poi `confirm`, poi l'esecuzione reale con riepilogo via `setMessage` (coerente con il reset schermata).

### Verifica

- **Sanitizer** (`sanitizeName`, `targetRelPath`): test unitario su caratteri non validi, spazi/punti finali, nome riservato, titolo/canale null → tutti corretti; `Never Gonna Give You Up` di Rick Astley → `Rick Astley/Never Gonna Give You Up [dQw4w9WgXcQ].mp4`.
- **`reorganizeLibrary`** (test d'integrazione su `mediaRoot` temporaneo + catalogo sintetico): dry-run pianifica gli spostamenti giusti; esecuzione reale sposta i file nelle cartelle creator e aggiorna `localPath`; **duplicati di titolo** vanno a file distinti grazie all'id; video già nidificato contato come `alreadyOk`; video senza file su disco segnalato come `missing`; **seconda esecuzione = 0 spostamenti** (idempotenza); vecchi file piatti rimossi. Tutte le asserzioni superate.
- `node --check` su tutti i file toccati; import runtime di `core/src/index.js` OK (`reorganizeLibrary` presente tra gli export).
- **Non eseguibile in questo ambiente** (copia pulita senza `tools/yt-dlp.exe` né `media/`): il download reale end-to-end nel nuovo layout e la migrazione dei 50 file reali. Vanno lanciati dall'utente sulla propria macchina — `reorganizeLibrary({ dryRun: true })` prima, per rivedere il piano, poi l'esecuzione dal menu "Riorganizza libreria".

## Direzione visiva scelta per la WebGUI (in preparazione a M11)

Prima di M10, l'utente ha condiviso uno zip di design (`Webapp video catalogo design.zip`, un handoff HTML in stile "Design Component", non codice di produzione) con **due direzioni visive alternative** per la Home/Catalogo: **1a** ("Chiaro & essenziale" — sfondo bianco, grigi neutri, Helvetica Neue) e **1b** ("Cinema" — sfondo quasi nero, thumbnail grandi, titoli Space Grotesk, accento ambra). Lo zip copre solo Home (desktop+mobile); Player, Ricerca e pagina Canale non erano inclusi ("da progettare").

**Scelta dell'utente: 1b (Cinema, scuro).** Adattamenti decisi rispetto al mock originale, per aderenza al vero modello dati del progetto invece che a contenuti generici stile YouTube:
- Le **chip categoria** in cima alla griglia diventano **chip di stato** (Tutti/Nuovi/In coda/Scaricati/Falliti/Archiviati) — l'asse di navigazione reale di questo catalogo è lo stato del video (`VIDEO_STATUS`), non un genere editoriale; corrisponde 1:1 alla vista "Catalogo" del CLI.
- Il **chip categoria ambra sopra la thumbnail** (mock originale) diventa un **badge di stato** colorato per card, con palette semantica dedicata separata dall'accento ambra del brand (nuovo=blu, in coda=viola, in download=ambra/brand, scaricato=verde, fallito=rosso, archiviato=grigio).
- **Sidebar**: Home / Scarica video (singolo) / Sorgenti + sezione Canali → ricalca esattamente il menu principale del CLI (voci "Scarica video singolo" e "Gestisci fonti").
- Pagine mancanti disegnate coerenti con 1b: **Dettaglio video/Player** (azioni contestuali allo stato — stesso pattern di "Rivedi novità"/"Guarda" nel CLI: Scarica/Archivia per i nuovi, Riproduci/Solo audio per gli scaricati, Riprova per i falliti), **Ricerca** (riusa `searchVideos`, badge di stato sui risultati), **Pagina canale** (equivalente di "Guarda": banner, avatar, griglia dei video di quel canale).
- Rimandati a quando si scaffolda `packages/web` in codice (M11): pannello job/download (log live + storico) e gestione sorgenti — liste/form senza pattern visivi nuovi da decidere a priori.

Nessun codice scritto per questa parte: solo mockup statici (HTML/CSS) di validazione, sostituiti dall'implementazione React reale in M11.

## M10 — `packages/server`: wrapper HTTP su `@catalog/core`

Su richiesta dell'utente si è passati direttamente a M10 (server), rimandando lo scaffolding di `packages/web` a dopo — il server è un prerequisito per una WebGUI reale (M11 la consumerà via `fetch`/SSE), mentre i mockup visivi (sezione sopra) restano validi indipendentemente da quando si scrive il codice React.

**Architettura**: Express **sottile** — ogni route richiama direttamente una funzione già esportata da `core/src/index.js` e ne serializza il risultato in JSON; **nessuna logica applicativa nuova** in `packages/server`, coerente con l'intera impostazione del progetto ("core" come unica fonte di verità comportamentale, "server"/"cli" come semplici adattatori). Aggiunta la dipendenza `express` (`^4.19.2`) solo a `packages/server` — `core` resta a zero dipendenze esterne, invariato.

**Struttura**:
- `src/index.js` — crea l'app Express, monta `express.json()`, un middleware CORS scritto a mano (accesso aperto: strumento locale single-user, server e client sulla stessa macchina, nessuna autenticazione — l'unico scopo del CORS è permettere al dev server di Vite, porta diversa, di chiamare l'API), monta le route sotto `/api` e il media statico, poi `app.listen(config.port)` (da `data/config.json`, default 3001).
- `src/routes/videos.routes.js` — CRUD di lettura sul catalogo (`listVideos` con filtro `?status=`, `listNew`, `getVideo`, `getRawMetadata`), le azioni (`decideVideo`, `playVideo`), la ricerca (`searchVideos`), i canali (`listChannels`, `listVideosByChannel`), e il download singolo one-off (`prepareSingleVideoDownload` + `triggerJob('downloadSingle')` se c'è da scaricare, stessa orchestrazione della voce "Scarica video singolo" nel CLI).
- `src/routes/sources.routes.js` — `listSources`/`addSource`/`removeSource`, più `/api/sync` che sincronizza una fonte (`body.sourceId`) o tutte in sequenza se omesso (replica "Tutte le fonti" del CLI).
- `src/routes/jobs.routes.js` — `triggerJob` generico, `listJobs`, `getJob`, e **`GET /api/jobs/:id/stream`**: bridge SSE sullo stesso `EventEmitter` di `jobManager` a cui il CLI si iscrive in-process. Un client che si collega dopo l'avvio del job riceve prima lo stato e lo storico log già accumulato (`job.logLines`), poi gli eventi `log`/`progress`/`status` in tempo reale; lo stream si chiude da solo a `success`/`failed` (anche se il job era già concluso al momento della connessione).
- `src/routes/library.routes.js` — `POST /api/library/reorganize` (`reorganizeLibrary`, `dryRun` di default `true`, coerente col CLI: il piano va rivisto prima di spostare file veri).
- `src/media/mediaRoutes.js` — `express.static` su `paths.videosDir`/`paths.thumbnailsDir` (da `getPaths()`), che supporta Range requests/ETag nativamente (necessario per il seek nel player `<video>` della futura WebGUI).
- `src/lib/asyncRoute.js` — wrapper che cattura le `Error` lanciate da `core` (id non trovato, stato incompatibile, input non valido, ecc. — lo stesso pattern di messaggi chiari già usato dal CLI) e risponde `400 { error: message }`. Per uno strumento personale single-user non serve una tassonomia di codici HTTP più fine: un solo pattern di errore, riusato ovunque.
- `src/lib/publicVideo.js` — aggiunge `videoUrl`/`thumbnailUrl` pronti all'uso a ogni video restituito dall'API, codificando ogni segmento del path (necessario perché da "Archivio canonico per creator" `localPath` può contenere sottocartelle con caratteri accentati/speciali nel nome del creator o del titolo).

**Verifica eseguita** (server avviato realmente con `node packages/server/src/index.js` contro i dati reali dell'utente, poi terminato): `GET /api/videos?status=downloaded` → 52 risultati con struttura attesa; `GET /api/channels` → 5 canali con conteggi corretti; `GET /api/sources` → le 2 fonti reali (`bell asmr` 49 video, `ToDownload` 1 video); `GET /media/thumbnails/<id>.jpg` → `200` con `Accept-Ranges: bytes`; `GET /api/channels/<id>/videos` → 48 video di "Miss Bell ASMR", `videoUrl`/`thumbnailUrl` corretti; `GET /api/search?q=asmr&limit=2` → 2 risultati. **Percorsi di errore verificati senza toccare i dati reali** (hash sha256 di `data/catalog.json` identico prima/dopo): `GET`/`POST` su un id inesistente → `400` col messaggio di `core`, nessuna mutazione; `POST /api/sources` con URL senza `list=` → `400`; `POST /api/library/reorganize` con `dryRun:true` → piano restituito (conferma che l'archivio reale non è ancora stato migrato al layout per creator, restano i path piatti `<id>.<ext>`), nessuno spostamento reale. Non verificato in questa sessione: lo stream SSE con un job realmente in corso (avviarlo avrebbe scaricato/mutato dati reali) — la logica di sottoscrizione/pulizia è stata solo letta, non esercitata end-to-end.

`packages/web` (M11) resta da scaffoldare: consumerà questa API via `fetch` per i dati e `EventSource` per `/api/jobs/:id/stream`, implementando i mockup della direzione 1b sopra descritta.

## M11 — `packages/web`: SPA React (Vite), direzione Cinema

Zone grigie chiarite con l'utente prima di scrivere codice (la navigazione della CLI è forzatamente sequenziale, quindi non le poneva):

- **Azioni sulla card**: sia scorciatoie al passaggio del mouse sulla card in griglia, sia le stesse azioni ripetute nella pagina di dettaglio — non solo dal dettaglio come nel CLI.
- **Player "solo audio"**: solo player nativo `<video>`; "solo audio" nasconde il riquadro video via CSS (`audio-only` su `.player-frame`) senza smettere di decodificare il video — differenza accettata rispetto al vero `--no-video` di VLC, in cambio di zero dipendenze da un programma esterno nel web. Niente bottone "Apri in VLC": l'endpoint `POST /api/videos/:id/play` resta disponibile lato server (parità con `core`) ma inutilizzato dal client web.
- **Riorganizza libreria**: inclusa anche nel web (non solo CLI), stesso pattern dry-run → conferma → esecuzione.
- **Dev workflow**: due processi separati (`npm run server` + Vite dev su `packages/web`), con proxy di Vite su `/api` e `/media` verso `http://localhost:3001` — nessuna build di produzione servita da Express per ora.

**Stack**: React 19 + Vite 8 + `react-router-dom` 7 (SPA multi-pagina: Catalogo/Dettaglio/Ricerca/Canale/Sorgenti/Scarica/Job/Riorganizza, un router è giustificato) + `lucide-react` (icone vettoriali reali al posto dei placeholder geometrici del mock, come richiesto dal design). Nessuna libreria di stato globale: `fetch` + `useState`/`useEffect` per pagina bastano per la scala di un archivio personale; un solo hook condiviso, `useJobStream(jobId)`, incapsula la sottoscrizione SSE (chiude esplicitamente la `EventSource` a `success`/`failed`, altrimenti riproverebbe a riconnettersi all'infinito rigiocando lo storico). CSS scritto a mano in un unico `styles/global.css` con i design token della direzione 1b (nessun framework CSS).

**Corrispondenza con la CLI** (stessa logica, nessuna nuova regola applicativa — solo chiamate a `@catalog/server`):
- **CatalogPage** (`/`) = Home: chip di stato (client-side, un solo fetch di `listVideos()` poi filtrato in memoria, come suggerito da `PIANO.md`) invece delle categorie del mock; banner "Scarica in coda (N)" quando ci sono `pending`, che chiama `triggerJob('downloadPending')` e porta a `/jobs` per il log live — nidificato nella stessa vista come nel CLI ("Rivedi novità"), non una voce di menu separata.
- **VideoDetailPage** (`/videos/:id`) = "Rivedi novità" + "Guarda" fusi: player nativo per `downloaded`, azioni contestuali allo stato (`reviewActionsFor`, stessa tabella `REVIEW_ACTIONS_BY_STATUS` del CLI) per gli altri stati, video correlati dello stesso canale.
- **SearchPage** (`/search`) = "Cerca": stesso `searchVideos` (M7), debounce 300ms invece del filtro dal vivo di `@inquirer/prompts`, azioni contestuali sui risultati.
- **ChannelPage** (`/channels/:key`) = "Guarda" (solo `downloaded`, per la riproduzione — non per la revisione).
- **SourcesPage** (`/sources`) = "Gestisci fonti" + "Sincronizza" fusi in una vista.
- **SingleDownloadPage** (`/download`) = "Scarica video singolo": stessa gestione dei quattro esiti di `prepareSingleVideoDownload` (già-scaricato/già-in-download/già-tracciato/da-scaricare).
- **JobsPage** (`/jobs`) = job in corso con log/progresso live via SSE (`?highlight=<jobId>`) + storico (snapshot statico già persistito, nessuno stream necessario per i job conclusi).
- **LibraryPage** (`/library`) = "Riorganizza libreria": dry-run automatico all'apertura, conferma, esecuzione.

### Bug reale trovato e corretto durante il test in browser

`StatusBadge` riusava la classe `.badge` (pensata per l'angolo sovrapposto a una thumbnail, `position:absolute`) anche nella riga dei risultati di ricerca, dove non c'è un genitore `position:relative` a cui ancorarsi: il badge finiva posizionato altrove nella pagina, invisibile. Corretto aggiungendo una variante `inline` (prop `inline` su `StatusBadge`, classe `.badge-inline` a flusso normale, non posizionata) usata da `SearchPage`; l'uso nella griglia (`VideoCard`, dentro `.thumb`) e nel placeholder del player restano invariati e corretti.

### Intoppo di dipendenze: doppia copia di React

Il primo tentativo (React 18.3 + Vite 5 + react-router-dom 6, poi alzati a React 19 + Vite 8 + react-router-dom 7 per chiudere due vulnerabilità moderate/alte di `esbuild` segnalate da `npm audit`) ha prodotto un albero `node_modules` con **due copie di React** (`node_modules/react@18.3.1` alla radice, `packages/web/node_modules/react@19.2.7` annidata) nonostante tutti i `peerDependencies` in gioco (incluso `lucide-react`) dichiarassero compatibilità con la 19 — un side-effect dell'hoisting degli npm workspaces quando si cambiano le versioni dichiarate senza ripartire da un lockfile pulito. Sintomo: `Invalid hook call`/`Cannot read properties of null (reading 'useRef')` al primo render, pagina completamente nera. Risolto con una reinstallazione pulita (`rm -rf node_modules package-lock.json && npm install`): da zero, npm risolve una sola copia deduplicata. Nota per il futuro: dopo un cambio di major version di una dipendenza React in un workspace, reinstallare da zero piuttosto che fare un `npm install` incrementale.

**Verifica eseguita** (build + dev server reali, dati reali dell'utente, nessuna mutazione): `npm run build` in `packages/web` → bundle prodotto senza errori; server (M10) + Vite dev avviati insieme, navigazione reale nel browser (Chrome, via `claude-in-chrome`) su tutte e otto le pagine con i dati reali (52 video scaricati, 5 canali, le 2 fonti, storico job già esistente da sessioni precedenti). Confermate visivamente: griglia Catalogo con badge di stato colorati e chip funzionanti; pagina canale ("a2", 1 video); player nativo con controlli e durata corretta, sezione descrizione; Ricerca fuzzy ("asmr teacher" → risultati pertinenti, tag `Miss Bell ASMR`) con badge di stato dopo il fix; Sorgenti con le 2 fonti reali e conteggi corretti; Job con lo storico reale (job "Scarica video singolo"/"Scarica in coda" con esiti Completato/Fallito); Riorganizza libreria con piano dry-run reale (52 da spostare, 0 già a posto) **senza eseguire lo spostamento** per non toccare i file reali. Layout mobile (sidebar → tab bar in basso, griglia a una colonna) verificato ridimensionando la finestra a 400px.

**Non verificato in questa sessione** (per non mutare il catalogo/i file reali dell'utente): le azioni di decisione (Scarica/Archivia/Rimetti tra le novità) dalla card o dal dettaglio, l'aggiunta/rimozione di una fonte, un job di download reale con log SSE dal vivo, e l'esecuzione reale di "Riorganizza libreria". La logica di questi percorsi è la stessa già verificata lato server in M10 (stesse funzioni `core`); andrebbero comunque provati end-to-end dall'utente con dati di cui è disponibile a rischiare una mutazione.

## Esecuzione reale della migrazione al layout per creator

`reorganizeLibrary()` (M10/M11, sopra) era stata scritta e verificata solo in dry-run/test sintetici: l'archivio reale dell'utente era rimasto nel vecchio layout piatto (52 file `<id>.<ext>` alla radice di `media/videos/`, più 1 video già nel nuovo layout perché scaricato dopo il cambio di template in `ytdlpWrapper.js`). Su richiesta esplicita dell'utente, eseguita la migrazione vera e propria.

**Procedura**: `reorganizeLibrary({ dryRun: true })` prima, per rivedere il piano (52 spostamenti pianificati, 1 `alreadyOk`, 0 `missing`, nessuna collisione) — poi `reorganizeLibrary({ dryRun: false })` per l'esecuzione reale. Risultato: `{ moved: 52, planned: 52, alreadyOk: 1, missing: 0 }`.

**Verifica post-migrazione** (dati reali, nessuno script di rollback necessario dato l'esito pulito):
- Filesystem: nessun file video rimasto alla radice di `media/videos/`; 53 file totali distribuiti in 6 cartelle per creator (`Miss Bell ASMR` 48, le altre 5 con 1 video ciascuna); nessuna sottocartella vuota residua.
- Catalogo: tutti i 53 video `downloaded` hanno `video.localPath` aggiornato con il segmento di sottocartella e il file corrispondente esiste su disco (verificato per ognuno, non a campione).
- **Idempotenza confermata su dati reali** (non solo nel test sintetico precedente): una seconda `reorganizeLibrary({ dryRun: true })` dopo la migrazione ritorna `{ planned: 0, alreadyOk: 53, missing: 0 }`.
- **Funzioni `core` contro il catalogo reale post-migrazione**: `listVideos`, `listChannels`, `listVideosByChannel` (percorso di ogni video risolto e verificato esistente su disco per tutti i 6 canali), `searchVideos('bel gramar')` → stesso risultato corretto di M7.
- **Server (M10) contro i file reali riorganizzati**: avviato per davvero, `GET /api/videos?status=downloaded` → 53 risultati; su un video con percorso reale contenente spazi/parentesi/emoji (`Miss Bell ASMR/[ASMR] Brain Anatomy Lesson 🧠 (teacher roleplay) [3DHT17o36Zw].mkv`), `videoUrl` correttamente URL-encoded per segmento e la richiesta con header `Range` risponde `206`/`Content-Range` corretto — conferma che `publicVideo.js` gestisce nomi di cartella/file reali, non solo il caso sintetico testato in M10. `GET /api/channels` → i 6 canali reali con conteggi corretti.
- **CLI**: `node --check` passa; avvio reale del CLI verificato senza errori (il menu principale si renderizza leggendo il catalogo post-migrazione).
- Nessun processo server lasciato residente al termine della verifica.

L'archivio dell'utente è ora interamente nel layout canonico per creator descritto in `PIANO.md`/sopra; la sezione "Idea in discussione" di `PIANO.md` relativa a questo tema è quindi chiusa (non più in discussione) — vedi aggiornamento a `PIANO.md`.

## M12 — Rifinitura: dettaglio errori e QA end-to-end dal web

M10/M11 avevano verificato il web solo lato lettura/dry-run, per non mutare i dati reali dell'utente. M12 chiude quei buchi: un bug reale corretto e i percorsi di scrittura (decisioni, fonti, download, riorganizzazione) esercitati per davvero attraverso la web GUI, con dati di test creati e ripuliti appositamente per non toccare il catalogo reale.

### Bug reale corretto: nessun dettaglio d'errore per i video `failed` nella web GUI

Il CLI mostra il messaggio d'errore di un video fallito prima di proporre le azioni ("Rivedi novità"); la web GUI no — `VideoDetailPage` non renderizzava mai `video.error`, l'unico modo per capire perché un download fosse fallito era consultare `data/catalog.json` a mano. Corretto aggiungendo un blocco `notice error` (stesso stile già usato altrove) con numero di tentativi + messaggio, visibile solo per `status: 'failed'` con `error` valorizzato, sopra le azioni contestuali (Riprova/Archivia/Rimetti tra le novità) già esistenti da M11.

### QA end-to-end dal web, con dati di test sicuri

Verificato ogni percorso di scrittura non ancora esercitato via web, usando dati creati apposta e rimossi subito dopo (nessun impatto sul catalogo reale, hash dei file reali invariato):

- **Decisioni dal web** (dettaglio e card in griglia): due video sintetici inseriti direttamente nel catalogo (`QATEST0new1` in `new`, `QATESTfail1` in `failed` con un errore finto) per testare `Scarica`/`Archivia`/`Rimetti tra le novità`/`Riprova` senza dover aspettare una sync o un download reale. Ciclo completo `new → pending → new → excluded` verificato dal dettaglio; verificato anche il nuovo blocco errore su `QATESTfail1` e `Riprova` (→ `pending`, errore/tentativi azzerati, coerente con `decisionService`). **Nota tecnica**: il click sintetico dell'automazione browser sul pulsante inline della card (rivelato da `:hover`, `pointer-events` gestito via CSS) non attivava correttamente `:hover` prima del click, facendo "cadere" il click sul `Link` sottostante invece che sul bottone — falso allarme, non un bug dell'app: un click DOM diretto (`element.click()`, che bypassa l'hit-test di `pointer-events`) sullo stesso bottone ha confermato che `preventDefault`/`stopPropagation` funzionano correttamente e la decisione viene applicata.
- **Fonti dal web**: "Aggiungi fonte" testata con l'URL reale di una fonte già esistente (`ToDownload`) → risposta reale di dedup (`Fonte già presente`), stessa chiamata di rete a yt-dlp di un aggiunta vera. "Sincronizza tutte" eseguita per davvero sulle 3 fonti reali → `0 nuovi, 0 riparati` (atteso, tutto già sincronizzato). "Rimuovi fonte" **non cliccata dall'automazione**: usa `window.confirm`, un dialogo nativo bloccante che avrebbe impedito ulteriori comandi al browser — il codice (endpoint `DELETE /api/sources/:id` → `removeSource`) è stato letto/verificato ma non esercitato a click; rischio basso, è una chiamata a tre righe già usata identica da `handleSync`.
- **Download reale con log SSE dal vivo**: "Scarica video singolo" su un video pubblico minuscolo già usato in test precedenti di questo progetto (`jNQXAC9IVRw`, "Me at the zoo", ~19s) → job reale innescato, redirect automatico a `/jobs?highlight=<id>`, log yt-dlp reale visibile (progress bar, righe di download, merge, spostamento thumbnail), job concluso `COMPLETATO` e comparso nello storico. Video verificato anche in `VideoDetailPage`: player nativo funzionante, canale reale (`jawed`) creato correttamente.
- **Riorganizza libreria dal web**: poiché l'archivio reale è già interamente nel layout canonico (0 file da spostare), il file di test scaricato sopra è stato temporaneamente spostato fuori dal layout canonico (rinominato a `<id>.mp4` piatto, `localPath` disallineato di conseguenza) per dare al motore qualcosa da spostare davvero. `LibraryPage` ha mostrato correttamente il piano (`1 da spostare · 61 già a posto`); l'esecuzione (`POST /api/library/reorganize` con `dryRun:false`, stesso endpoint dietro il pulsante — non cliccato per lo stesso motivo di `window.confirm` di "Rimuovi fonte") ha spostato il file al posto giusto, verificato ricaricando la pagina (`0 da spostare · 62 già a posto`).

**Pulizia**: al termine, i due video sintetici, il video/file/thumbnail/riga di `.ytdlp-archive.txt`/entry di `data/metadata.json` del download di test, e la entry di storico job generata sono stati rimossi. Verificato: `data/catalog.json` tornato esattamente a 61 video tutti `downloaded`, 3 fonti invariate, nessuna cartella residua in `media/videos/`. Nessun processo server/Vite lasciato residente al termine.

### Nota di processo: attenzione ai processi Node concorrenti sullo stesso catalogo

`catalogStore.js` tiene il catalogo in memoria per processo (caricato una sola volta, mai ricaricato da disco). In questa sessione sono girati più processi Node in parallelo sugli stessi file (`data/catalog.json`) per scopi diversi (server per il browser, script diretti per seed/pulizia dei dati di test): ogni volta che uno script ha scritto sul catalogo mentre il server era già avviato, il server è stato **fermato e riavviato** subito dopo, così da ripartire con lo stato fresco da disco invece di rischiare che la sua cache in memoria, riscritta per intero a ogni mutazione, sovrascrivesse le modifiche fatte dallo script. Stesso principio vale per una eventuale CLI dell'utente lasciata aperta: se resta aperta mentre il catalogo viene modificato da un altro processo, la prima azione compiuta in quella CLI riscriverebbe il catalogo con lo stato vecchio che aveva in memoria.

## M14 — Foto profilo reali dei canali

Promosso da "punto aperto" (raccolto a fine sessione precedente) a milestone vera e propria, con tre decisioni prese in fase di scoping: foto recuperata solo per i canali con almeno un video scaricato; aggiornamento non fisso, ri-scaricabile manualmente (a differenza delle thumbnail video, mai riscaricate); visibile in 4 punti della web GUI (sidebar, card, dettaglio, pagina canale) — CLI esplicitamente fuori scope, essendo puramente testuale.

**Scoperta chiave, verificata prima di scrivere codice**: i metadati grezzi già presenti in `data/metadata.json` (62 video reali) **non contengono alcun campo avatar** — confermato cercando `avatar|channel_thumb|photo|icon` su tutte le chiavi di tutte le entry, zero corrispondenze. Serve quindi un'interrogazione yt-dlp **dedicata sull'URL del canale stesso** (`--playlist-items 0 -J`, economica, non enumera i video), mai fatta finora in questo progetto (finora solo playlist e singolo video).

**Spike empirico contro un canale reale** (Sampurna ASMR) prima di scrivere il parsing definitivo: l'avatar non ha una chiave dedicata — vive dentro l'array `thumbnails` (condiviso con l'immagine banner del canale), taggato `id: "avatar_uncropped"`. `pickAvatarUrl()` in `ytdlpWrapper.js` cerca prima quel tag esatto, poi un fallback su qualunque id che contenga "avatar", poi la thumbnail quadrata più grande (l'avatar è sempre 1:1, il banner no) — tre livelli di difesa nel caso yt-dlp cambi convenzione in futuro.

**Dati**: nuovo `catalog.channelAvatars` (mappa `{channelKey: {sourceUrl, localPath, fetchedAt, error}}`) dentro `data/catalog.json` — non un file separato come `data/metadata.json`, perché un canale produce un solo piccolo record (non centinaia di KB per video): vive comodamente accanto a `catalog.sources`, ereditando gratis mutex e scrittura atomica già presenti. `reconcileOnLoad()` in `catalogStore.js` esteso per backfillare `channelAvatars: {}` sui cataloghi già esistenti (il catalogo reale dell'utente tra questi) — stesso meccanismo già usato per la reconciliation di `downloading → pending`.

**Download immagine**: `fetch()` nativo di Node (Node v22.20.0 installato, nessuna dipendenza nuova, coerente con "core non deve avere dipendenze esterne"), non un'altra chiamata yt-dlp — l'URL risolto è una semplice immagine HTTPS. Nome file da `sanitizeName(channelKey, 'channel')` (riuso diretto da `libraryService.js`), estensione da `content-type` (jpg/png/webp osservati entrambi contro canali reali). Su un refresh forzato che cambia estensione, il vecchio file viene rimosso per non lasciare orfani.

**`core/src/services/channelAvatarService.js`** (nuovo): `syncChannelAvatars({force})` — batch tollerante ai fallimenti (un canale che fallisce non blocca gli altri, stesso principio già usato per i download), ritorna `{channelsConsidered, fetchedCount, skippedCount, failedCount, errors}`. `getChannelAvatarMap()` per la lettura lato server. `channelKey()` (prima privata in `videoService.js`) esportata da `core/src/index.js` per non duplicare la logica di raggruppamento canale tra `videoService.js` e il nuovo `publicVideo.js` lato server.

**Server**: nuovo mount statico `/media/avatars`; `toPublicVideo(video, channelAvatars)` arricchisce anche `video.channel.avatarUrl`; `GET /api/channels` arricchito separatamente (shape diversa, slim); nuova `POST /api/channels/avatars/sync` — messa accanto alle altre route canale in `videos.routes.js`, non in `library.routes.js` (quest'ultima specifica per operazioni a rischio reale sui file video su disco, da cui il suo `dryRun`; questa è "tira dati freschi da YouTube", stessa famiglia di `POST /api/sync`).

**Web**: pattern condizionale uniforme nei 4 punti concordati (`<img className="avatar-photo">` se `avatarUrl` presente, altrimenti l'iniziale-lettera già esistente) — una sola classe CSS condivisa (`avatar-photo`, `width/height:100%; border-radius:50%; object-fit:cover`) funziona alle tre taglie già esistenti (22/38/84px) senza toccare `.avatar`/`.d-avatar`/`.chan-avatar`. Pulsante "Sincronizza foto canali" in `SourcesPage` accanto a "Sincronizza tutte", con un checkbox "Aggiorna anche le foto già presenti" che passa `force:true` — necessario perché l'utente ha scelto esplicitamente "ri-scaricabile manualmente" (non "fissa per sempre"): un pulsante che salta sempre i canali già a posto non avrebbe mai permesso di aggiornare una foto dalla UI.

### Verifica eseguita (dati reali dell'utente, nessun dato di test)

- Migrazione automatica confermata: catalogo reale (creato prima di M14) riavviando il server ha ricevuto `channelAvatars: {}` al primo caricamento, persistito su disco.
- Sync reale sui canali dell'utente: **7/8 riusciti**, 1 fallito con errore chiaro e batch non interrotto — il fallimento è **GinaCarla**, un canale **Rumble** (`https://rumble.com/user/GinaCarla`, non YouTube — coerente con il supporto multi-sito di "Scarica video singolo", M8): la logica di estrazione avatar, informata dallo spike su un canale YouTube reale, non trova nulla lì. Comportamento corretto, non un bug: fallback sull'iniziale-lettera in UI, verificato visivamente.
- Idempotenza: secondo giro con `force:false` → `fetchedCount:0, skippedCount:7` (GinaCarla ritentato a ogni giro non-force, corretto: non ha mai un `localPath` da poter saltare).
- Verifica visiva reale nel browser (Chrome via `claude-in-chrome`) sui 4 punti concordati: sidebar, card in griglia, dettaglio video, pagina canale — foto reali mostrate correttamente per i 7 canali riusciti, fallback a iniziale-lettera per GinaCarla in tutti e 4 i punti.
- Force refetch testato dalla UI reale (checkbox + pulsante): `7 scaricate, 0 già presenti, 1 non trovate` — nessun file orfano in `media/avatars/` dopo (7 file, stesso conteggio di prima).
- Immagine servita correttamente via `/media/avatars/<file>` (`200`, `content-type` corretto).
- Regressione: `node --check` su tutti i file toccati, avvio reale del CLI senza errori (unica superficie condivisa toccata è l'elenco export additivo di `core/src/index.js`).

### Bug reale scoperto (non collegato a M14): `.gitignore` con `media/` non ancorato

Durante `git status` è emerso che `packages/server/src/media/mediaRoutes.js` — file esistente e funzionante dalla milestone M10 — **non era mai stato tracciato da git**. Causa: la riga 4 di `.gitignore`, `media/` (senza `/` iniziale), in sintassi gitignore non è ancorata alla radice del repo — esclude qualunque cartella chiamata `media` a qualunque profondità, non solo `./media/` (l'archivio video/thumbnail, l'intento originale). Ha quindi silenziosamente escluso anche `packages/server/src/media/` fin dalla sua creazione: un clone pulito del repository sarebbe stato privo delle route di serving media (video/thumbnail/avatar), una funzionalità server critica.

Corretto: `.gitignore` riga 4 ora `/media/` (ancorata alla radice). Verificato con `git check-ignore`: `packages/server/src/media/` non più ignorata, `media/videos` (l'archivio reale) ancora correttamente ignorata. `packages/server/src/media/mediaRoutes.js` incluso nel commit di questa milestone.


## Post-M14: foto canale impostata manualmente per Rumble

Indagine su richiesta dell'utente: yt-dlp può recuperare l'avatar per un canale **Rumble** (`GinaCarla`, l'unico fallimento su 8 in M14)? Verificato con uno spike diretto (`--playlist-items 0 -J` e `--playlist-items 1 -J` contro `https://rumble.com/user/GinaCarla`): l'estrattore `RumbleChannel` di yt-dlp non espone **alcun** campo di avatar/thumbnail a livello di canale (risposta quasi vuota con 0 item), e nemmeno a livello di singolo video esiste un campo tipo `uploader_thumbnail`/`channel_thumbnails` — solo la thumbnail del video stesso. Confermato: è un limite reale dell'estrattore Rumble di yt-dlp, non risolvibile aggiustando la query.

Valutate tre strade con l'utente: (1) lasciare il fallback all'iniziale-lettera, (2) scraping diretto dell'HTML della pagina Rumble (scartato: fragile, va contro la scelta di appoggiarsi sempre a yt-dlp), (3) un meccanismo di override manuale generico. L'utente ha risolto il caso specifico fornendo direttamente il file immagine: copiato in `media/avatars/GinaCarla.jpg` (stessa convenzione di nome usata da `syncChannelAvatars`, `sanitizeName(channelKey)`), e il record `catalog.channelAvatars.GinaCarla` aggiornato a mano con `localPath` valorizzato ed `error: null` — così una futura sincronizzazione senza `force` la lascia intatta, esattamente come una foto scaricata automaticamente. Nessun meccanismo di override generico costruito (non richiesto); resta un'idea aperta se il caso si ripresentasse con altri canali non-YouTube.

## M15 — Rinominare "canali" in "creator" (solo testo visibile)

Promosso da "punto aperto" a milestone. Prima domanda di scoping: quanto profonda deve essere la rinomina? L'utente ha scelto esplicitamente **solo il testo visibile** (non nomi di variabili/funzioni, non lo schema dati `video.channel`, non gli endpoint `/api/channels`, non le classi CSS `.chan-*`) — la scelta con il minor rischio, nessuna migrazione dati, nessuna rottura delle rotte API appena costruite in M14.

**Individuazione delle stringhe**: ricerca `[Cc]anal[ei]|CANALI|Canale` su tutto `packages/`, poi separazione manuale tra testo effettivamente renderizzato all'utente e commenti nel codice (questi ultimi lasciati invariati, coerente con lo scope "solo testo visibile" — un commento non è mai visto dall'utente finale).

**CLI** (`packages/cli/cli.js`): fallback `'Canale'` → `'Creator'` (titolo di `watchChannelFlow` quando il nome canale è assente), `'← Torna ai canali'` → `'← Torna ai creator'`, `'Guarda — scegli un canale'` → `'Guarda — scegli un creator'`, `'Cerca (titolo, canale, tag, descrizione)'` → `'...creator...'`, due occorrenze di `'canale sconosciuto'` (elenco "Rivedi novità" e risultati di ricerca) → `'creator sconosciuto'`.

**Web**: `Layout.jsx` (placeholder di ricerca, intestazione sidebar "Canali"→"Creator", messaggio "Nessun canale ancora"), `ChannelPage.jsx` ("Nessun video scaricato per questo canale"), `VideoCard.jsx`/`SearchPage.jsx`/`VideoDetailPage.jsx` (fallback `'Canale sconosciuto'` → `'Creator sconosciuto'`, tre punti), `SourcesPage.jsx` (pulsante "Sincronizza foto canali" e il messaggio di esito "Foto canali: ...").

**Verifica eseguita**: `node --check packages/cli/cli.js`, build di produzione di `packages/web` pulita, verifica visiva reale nel browser (sidebar "CREATOR", placeholder "Cerca video, creator, argomenti"), nuova ricerca nel repo per confermare che non restano stringhe "canale/canali" visibili all'utente (solo commenti, intenzionalmente invariati).

## M16 — Picture-in-Picture rapido e copertina "clicca per riprodurre" in stile Rumble

Ritagliate due funzionalità concrete dai punti aperti 4 (player nativo) e 9 (analisi pagina di riproduzione), su richiesta diretta dell'utente — non l'analisi completa di entrambi i punti, che restano parzialmente aperti (sottotitoli, velocità di riproduzione, video suggeriti, copertina per gli stati non ancora scaricati).

**Scoping**: chiarito con l'utente che la "copertina" riguarda solo il player di `VideoDetailPage` per i video già `downloaded` (non le card in griglia, già a posto), e che deve sostituire la visualizzazione del player col primo frame prima di ogni interazione — non un indicatore di stato pausa/riproduzione. Decisione (di default, confermata): sparisce per sempre al primo avvio, non ricompare più in pausa — comportamento identico a Rumble/YouTube.

**Copertina "clicca per riprodurre"**: si è scoperto che l'attributo nativo `poster` di `<video>` sparisce già da solo per sempre dopo il primo avvio della riproduzione (comportamento nativo del browser, non richiede stato custom per quella parte) — ma da solo non basta per la modalità "Solo audio" già esistente, dove il `<video>` sottostante viene nascosto via `opacity:0`: in quello stato il `poster` diventerebbe invisibile insieme al video. Risolto con un `<button className="player-cover">` proprio, con una `<img>` della thumbnail e un tasto play stilizzato (cerchio semi-trasparente, diventa colore accento al hover), dipinto sopra tutto (`z-index:2`) finché uno stato `hasStarted` (via evento `onPlay` del `<video>`, non un click diretto — cattura qualunque modo in cui parta la riproduzione) resta `false`. `poster` resta comunque impostato sul `<video>` come fallback nativo corretto, anche se nella pratica il pulsante custom lo ricopre sempre finché non si preme play.

**Picture-in-Picture**: pulsante dedicato accanto a "Solo audio" (stesso pattern visivo), `requestPictureInPicture()`/`exitPictureInPicture()` sull'elemento `<video>` (via `ref`), con un secondo `useEffect` che ascolta gli eventi `enterpictureinpicture`/`leavepictureinpicture` per tenere il pulsante sincronizzato anche se l'utente chiude la finestra PiP nativa del sistema operativo invece di ricliccare il pulsante nell'app. Il pulsante compare solo se `document.pictureInPictureEnabled` (alcuni browser non supportano PiP).

### Due bug reali trovati e corretti in fase di verifica nel browser

1. **L'errore PiP cancellava l'intero player**: la prima versione di `togglePiP()` riusava lo stesso stato `error` usato per i fallimenti di caricamento del video — ma il componente ha un guard iniziale (`if (error) return <solo il messaggio d'errore>`) che sostituisce **tutta** la pagina, non solo mostra un avviso. Un fallimento PiP transitorio (es. cliccato troppo presto) cancellava quindi l'intero player invece di un piccolo avviso. Corretto separando uno stato dedicato `pipError`, mostrato come `notice error` locale accanto alle altre azioni, senza toccare il guard a piena pagina (riservato ai fallimenti reali di caricamento del video).
2. **`requestPictureInPicture()` falliva se cliccato prima di aver mai avviato il video**: l'API richiede che i metadati del video siano già caricati (`readyState >= 1`); senza mai premere play, il browser potrebbe non averli ancora caricati. Corretto in due parti: aggiunto `preload="metadata"` al `<video>` (il browser inizia a caricare i metadati appena la pagina si apre, non solo al primo play) e, per il caso limite in cui non bastasse (es. una tab in background, dove i browser sospendono deliberatamente il precaricamento media per risparmiare risorse — verificato essere proprio la causa nell'ambiente di test automatizzato usato per la verifica), `togglePiP()` ora aspetta l'evento `loadedmetadata` con un timeout di sicurezza di 5 secondi invece di fallire subito o restare bloccato all'infinito.

### Verifica eseguita (dati reali, browser reale via `claude-in-chrome`)

- Click sulla copertina di un video reale → riproduzione avviata, copertina sparita definitivamente; verificato che mettendo in pausa subito dopo la copertina **non** ricompare.
- "Solo audio" testato subito dopo l'avvio: nessun conflitto/doppia sovrapposizione con la copertina (già sparita a quel punto).
- Picture-in-Picture: click reale sul pulsante con il video in riproduzione → `document.pictureInPictureElement` popolato, pulsante cambia in "Esci da PiP"; click su "Esci da PiP" → ritorno al player principale, pulsante torna a "Picture in Picture". Round-trip completo verificato.
- Caso limite (PiP cliccato prima di aver mai premuto play) verificato **non più** rompere la pagina (nessun errore a piena pagina) dopo il fix — la verifica del successo effettivo dell'attivazione PiP in questo caso specifico è stata bloccata da una limitazione dell'ambiente di automazione (la tab del browser non risultava mai "visibile" a livello di sistema operativo durante l'automazione, quindi il browser non precarica mai i metadati indipendentemente da `preload`) — confermato però via `javascript_tool` che una chiamata diretta a `.play()` sullo stesso elemento fa salire `readyState` a 4 immediatamente, quindi il meccanismo di attesa non è mai realisticamente bloccante per un utente reale con la tab effettivamente aperta e visibile.
- Build di produzione pulita dopo ogni modifica.

## M17 — Rebrand: nome "Ondo", nuovo logo, colore d'accento

L'utente ha fornito un pacchetto di loghi pronto (`loghi.zip`, cartella `logo-ondo/`) con nome, icona, wordmark e colore già decisi — a differenza delle milestone precedenti (M14/M15/M16), qui non è servito uno scoping per definire il *cosa*, solo per due dettagli di applicazione lasciati aperti dal pacchetto.

**Contenuto del pacchetto**: wordmark "Ondo" (icona play-triangle + tre barre "waveform" verticali, a tema con un catalogo video/audio) in due varianti (fondo chiaro/scuro), icona da sola, app icon 512×512 con tessera arrotondata. Font indicato: **Sora 700**. Colore accento: **blurple**, `#9184d9` (variante per fondi scuri) / `#7b6fd0` (fondi chiari) — dato che l'app non ha mai avuto una modalità chiara (`--accent` è un'unica variabile, nessun `prefers-color-scheme`/`data-theme` nel CSS), si è usata la variante scura ovunque.

**Unico punto chiarito con l'utente**: il pacchetto logo usa Sora, il resto del sito usava ancora "Space Grotesk" (già segnalato poco leggibile nel punto 6 del backlog, mai affrontato a parte). L'utente ha scelto di sostituire Space Grotesk con Sora **in tutta l'interfaccia**, non solo nel logo — chiude quindi anche il punto 6 come effetto collaterale voluto, non un'estensione di scope non richiesta.

**Implementazione**:
- Copiati due SVG in una nuova `packages/web/public/` (cartella non esisteva ancora, convenzione Vite per asset statici serviti alla radice): `ondo-logo.svg` (wordmark, variante scura) e `favicon.svg` (app icon, variante scura) — **prima non esisteva alcun favicon**, colmato un buco.
- `index.html`: `<title>` da "Vídeon" (nome pre-esistente, inconsistente col testo "CINÉ." mostrato nel logo — un disallineamento che si è chiuso da sé col rebrand) a "Ondo"; aggiunto `<link rel="icon">`; sostituito il link Google Fonts da Space Grotesk a Sora.
- `Layout.jsx`: il testo hardcoded `CINÉ<span className="accent">.</span>` sostituito con `<img src="/ondo-logo.svg">`.
- `global.css`: `--accent`/`--accent-ink` da `oklch(...)` (arancione) agli hex esatti del pacchetto; `font-family` dei titoli/bottoni/chip da Space Grotesk a Sora; classe `.logo` ridisegnata per un'immagine invece che testo (rimossi `font-weight`/`font-size`/`color`, aggiunta `.logo img { height: 22px }`), rimossa `.logo .accent` (non più necessaria).
- Nessuna modifica alla CLI (nessun riferimento testuale al brand, confermato via ricerca nel repo) né ai nomi dei package npm (`@catalog/web`, ecc. — identificatori interni, non testo visibile, stessa filosofia già seguita in M15 per "canali"→"creator").

**Verifica eseguita**: build di produzione pulita (asset di `public/` copiati correttamente in `dist/`); nel browser reale — titolo scheda "Ondo", `GET /favicon.svg` → `200`/`image/svg+xml`, logo renderizzato nitido con Sora, colore d'accento confermato sia via `getComputedStyle(document.documentElement).getPropertyValue('--accent')` (`#9184d9`) sia visivamente su un pulsante primario reale.

### Bug reale trovato e corretto durante la verifica (pre-esistente, non introdotto da M17)

L'utente ha segnalato: "i bottoni in hover spariscono e diventano neri". Non riproducibile sui pulsanti normali (`Sincronizza tutte`, icone sync/elimina, sidebar) testati nel browser reale — tutti restavano leggibili. Chiesto all'utente di precisare: il problema riguardava specificamente i pulsanti **con sfondo colorato ad accento** (`.btn-primary`, es. "+ Aggiungi").

**Causa** (letta nel CSS, non indovinata): `.btn-primary { background: var(--accent); color: var(--accent-contrast) }` allo stato normale, ma la regola generica `.btn:hover { background: var(--panel2) }` (dichiarata prima nel file, stessa specificità: una classe + uno pseudo-elemento) **vince** in hover perché `.btn-primary:hover` non ridichiarava `background` — solo `filter: brightness(1.08)`. Risultato: sfondo che passa dal viola al quasi-nero di `--panel2` (`#18181c`), mentre il testo resta `--accent-contrast` (`#111`, quasi nero anch'esso, pensato per stare su un fondo chiaro) — testo scuro su sfondo scuro, illeggibile. Il bug esisteva **anche prima del rebrand** (stessa struttura CSS con l'accento arancione), solo mai notato/segnalato finora.

Corretto aggiungendo `background: var(--accent);` esplicito a `.btn-primary:hover`, così vince sulla regola generica indipendentemente dall'ordine nel file. Verificato nel browser reale: il pulsante "+ Aggiungi" resta viola e leggibile passando il mouse sopra.

## Pulizia dei "Punti aperti" in PIANO.md

Su richiesta dell'utente, rimossi dall'elenco "Punti aperti da definire e schedulare" tutti i punti ormai promossi a milestone o risolti (foto canali → M14, rinomina "canali"→"creator" → M15, font e logo/nome → M17): da 12 voci con diversi barrati a 7 voci, tutte ancora genuinamente aperte. La tabella delle milestone e la sezione "Bug risolti fuori milestone" restano invariate (storico del progetto, non "punti da fare").

## M18 — Velocità di riproduzione; sottotitoli analizzati ma rimandati

Analizzati insieme due elementi del vecchio punto 4 del backlog ("player nativo: sottotitoli, velocità — resta aperto dopo M16").

**Sottotitoli — fattibilità analizzata, non implementati**: verifica sui dati reali del catalogo prima di proporre qualunque design. `subtitleLanguagesAvailable` (già nello schema, popolato da `info.subtitles` di yt-dlp) traccia solo i sottotitoli **manuali** di YouTube — controllati 15 video reali del catalogo, **solo 2 ne avevano**, ed erano solo `live_chat` (replay della chat live, non sottotitoli veri). Per sottotitoli realmente utili servirebbero invece i **sottotitoli automatici** (`info.automatic_captions`, deliberatamente esclusi da `data/metadata.json` fin da M6 per il peso — ma quella era una decisione sulla *metadata inutile da salvare*, non sull'*utilità dei sottotitoli stessi*). Confermato con uno spike reale (`yt-dlp --skip-download -J` su un video del catalogo, prima della normale rimozione di `automatic_captions`): **157 lingue disponibili**, formato `vtt` incluso (supportato nativamente da `<track>`, mostrerebbe da solo il pulsante "CC" nativo del browser, nessuna UI custom necessaria per la UI di selezione). Implementarlo davvero richiederebbe: scaricare i file veri (oggi zero file scaricati, solo l'elenco lingue), una nuova `media/subtitles/`, nuovi flag yt-dlp (`--write-auto-subs --sub-langs ... --convert-subs vtt`), e una decisione su quali lingue scaricare per video (157 è chiaramente eccessivo). **L'utente ha deciso di non volerli ora** — l'analisi resta documentata in `PIANO.md` (punto 8 dei "Punti aperti") per essere riusata se si riprende in mano in futuro, invece di ripetere la ricerca da zero.

**Velocità di riproduzione — implementata**: a differenza di Picture-in-Picture (M16), il browser non espone un controllo nativo per la velocità nella barra `controls` standard — serve necessariamente un pulsante custom. Aggiunto in `VideoDetailPage.jsx` accanto a "Picture in Picture": un pulsante che cicla un array fisso `[1, 1.25, 1.5, 1.75, 2, 0.5, 0.75]` (si parte da 1x e prima si sale, poi si passa alle velocità ridotte, invece di un ordine puramente crescente/decrescente — riflette che rallentare è un caso meno comune di accelerare per questo tipo di contenuto) impostando `videoRef.current.playbackRate` a ogni click. Uno stato `speedIndex` si resetta a 0 (1x) a ogni cambio di `id` video, perché il browser stesso azzera `playbackRate` a 1x ogni volta che cambia il `src` del `<video>` — senza il reset, l'etichetta del pulsante avrebbe mentito sulla velocità reale passando da un video già accelerato a uno nuovo.

**Verifica eseguita** (browser reale, click veri): pulsante cicla correttamente `1x → 1.25x → 1.5x`, confermato ogni volta che `document.querySelector('video').playbackRate` combacia esattamente con l'etichetta mostrata (non solo visivamente, letto il valore reale della proprietà); passando a un secondo video reale, sia l'etichetta che la velocità effettiva tornano a 1x. Build di produzione pulita.

## M19 — Filtro + ordinamento in Home e pagina canale

Nessuna sorpresa tecnica: dato che `CatalogPage`/`ChannelPage` caricano già tutti i video in una volta sola (`listVideos()`/`listVideosByChannel()`, nessuna paginazione), ordinamento e filtro sono stati puro lavoro client-side — un `.sort()` su un array già in memoria, nessuna chiamata di rete aggiuntiva.

**`lib/sort.js`** (nuovo): `SORT_OPTIONS` (le 5 scelte confermate con l'utente) + `sortVideos(videos, criterion)`. Il criterio "per stato" usa una nuova `STATUS_PRIORITY` in `lib/status.js` — un ordine deliberatamente diverso da `STATUS_ORDER` (quello dei chip di filtro): non alfabetico/di schema, ma "quanto richiede attenzione ora" (falliti → in download → in coda → nuovi → scaricati → archiviati), scelto esplicitamente dall'utente tra due opzioni proposte.

**Filtro per canale**: aggiunto solo in `CatalogPage` (Home), non in `ChannelPage` (già intrinsecamente filtrata a un canale dalla rotta). Le opzioni del filtro sono derivate dai video già caricati in Home, **non** da `listChannels()` (l'endpoint già usato dalla sidebar) perché quest'ultimo di default considera solo i video `downloaded` — usarlo avrebbe impedito esattamente il caso d'uso che il filtro vuole coprire: vedere i video "nuovi"/"in coda" di un canale specifico senza scorrere tutti i canali mescolati insieme, cosa che oggi `ChannelPage` da sola non permette (mostra solo i `downloaded`).

**Verifica eseguita** (browser reale): filtro su "Sampurna ASMR" → esattamente 1 card (il conteggio reale di quel canale); ordinamento per titolo → primi 5 risultati in ordine alfabetico corretto; entrambi i controlli presenti e funzionanti su Home e pagina canale.

## M20 — Storico job: thumbnail del video + dettaglio errore

**Scoperta chiave emersa durante lo scoping** (prima di scrivere codice): un job `downloadSingle` ha sempre un solo video (`params.videoId`, già presente da M8, a costo zero da usare) — ma un job `downloadPending` scarica **un intero lotto** in un solo job, e il suo `summary` tracciava solo conteggi aggregati (`{downloaded, failed, total}`), **nessun elenco di quali id** avesse toccato. Mostrare una thumbnail per un job "Scarica in coda" richiedeva quindi una modifica reale al job, non un'aggiunta a costo zero come per il singolo — l'utente ha confermato di volerla comunque.

**`core/src/jobs/jobs/downloadPending.js`**: aggiunto un array `results: [{id, status}]` (status: `'downloaded'` o `'failed'`) accumulato durante il loop già esistente, incluso nel valore di ritorno insieme ai conteggi già presenti. Nessuna modifica al comportamento di download stesso, solo tracciamento in più.

**`packages/server/src/lib/publicJob.js`** (nuovo, ricalca il pattern già usato per video/canali — `publicVideo.js`): `toPublicJob(job)` arricchisce ogni job con `thumbnails`/`thumbnailsMore`. Per `downloadSingle`, una singola thumbnail da `params.videoId`. Per `downloadPending`, i primi 4 id con esito `downloaded` in `summary.results` (non i falliti — mostrare la miniatura di un download fallito non aggiunge informazione, il conteggio testuale "N falliti" già esistente resta invariato), con `thumbnailsMore` calcolato come `total - quanti mostrati` (copre sia i successi oltre il tetto di 4 sia i falliti). Ogni lookup video è avvolto in un try/catch silenzioso: un video sparito dal catalogo dopo che il job è girato non deve rompere il resto dello storico. Job già esistenti prima di questa modifica non hanno `summary.results` → nessuna thumbnail per i loro eventuali job batch, coerente con la scelta già presa altrove (M14) di "solo da qui in avanti", non un recupero retroattivo.

**Dettaglio errore**: `job.error.message` esisteva già ma era visibile solo espandendo la riga; ora compare anche nella vista collassata per i job falliti (`job-error-inline`), senza duplicare — nella vista espansa resta anche nel log.

**Verifica eseguita senza scaricare nulla di reale**: due job "finti" scritti direttamente come file JSON in `data/jobs/` (stessa cartella/formato che userebbe un job vero — l'arricchimento non sa né gli importa come un job è stato creato, legge solo `summary`/`params` dal suo JSON), referenziando id di video reali già scaricati nel catalogo dell'utente. Un batch da 6 id (5 `downloaded`, 1 `failed`) → confermato via `fetch` diretto a `GET /api/jobs` che l'API risponde `thumbnails: 4` (il tetto) e `thumbnailsMore: 2` (6 totali − 4 mostrate) — esattamente il calcolo atteso. Un singolo `failed` → thumbnail presente e `error.message` presente. Verificato poi anche visivamente nel browser: storico mostra correttamente 4 miniature + "+2 altri" per il batch, thumbnail + riga d'errore in rosso (senza dover espandere) per il singolo fallito. I due job di test rimossi al termine, nessun impatto sullo storico reale.

## M21 — Dati tecnici del video in un box a fine descrizione

Il più semplice dei tre: tutti i campi richiesti erano già nel catalogo (popolati dal download fin dalle prime milestone), semplicemente mai mostrati in `VideoDetailPage`. Nessuna modifica a schema, core o server — solo lettura di campi già presenti nella risposta già ricevuta dal client.

Nuovi helper in `lib/format.js`: `formatBytes` (B/KB/MB/GB/TB, un decimale sopra il byte) e `formatBitrate` (Kbps sotto i 1000, altrimenti Mbps con un decimale). Il box riusa **la stessa classe `.d-desc`** del box "Descrizione" già esistente (richiesto esplicitamente "un suo box uguale alla descrizione"), con un piccolo layout a griglia (`.tech-grid`) per le coppie etichetta/valore. Ogni campo è mostrato solo se ha un valore (`.filter((f) => f.value)`), per non mostrare mai un "undefined" nei rari casi di dati mancanti. `sha256` escluso su richiesta esplicita dell'utente (resta comunque nel catalogo/API per altri usi).

**Verifica eseguita** (browser reale, video scaricato reale): box "Dati tecnici" mostrato correttamente con valori reali e ben formattati (`1920×1080 · 30fps`, codec video/audio, `2.4 Mbps`, `183.4 MB`, formato `mkv`, versione yt-dlp), visivamente identico al box descrizione sopra di esso.

## M22 — Fix del falso positivo "da spostare" in "Riorganizza libreria"

**Causa reale, trovata sul catalogo dell'utente** (punto 6 del backlog, "cosa significa 'da spostare'?"): un video scaricato *dopo* la migrazione M9.2 (`Gq4aN6KnJoE`, titolo `ASMR | Full Check-Up With OVERLY REPEATED Instructions`) risultava comunque "da spostare" a ogni apertura di "Riorganizza libreria", pur essendo già nella cartella creator corretta. Confrontando `video.title` col vero nome file su disco è emerso che yt-dlp sanifica i caratteri non validi su Windows **a modo suo**: il `|` (pipe normale) diventa `｜` (pipe a tutta larghezza, U+FF5C), non uno spazio. Il sanitizzatore proprio del progetto (`sanitizeName()` in `libraryService.js`) invece sostituisce quello stesso carattere con uno spazio. `reorganizeLibrary()` confrontava il path *esatto* ricalcolato da `targetRelPath()` (che usa `sanitizeName()`) col path reale su disco (nominato da yt-dlp): due sanitizzazioni diverse → mismatch cosmetico → falso "da spostare", per ogni futuro titolo con un carattere non ammesso su Windows, non un caso isolato del passato.

**Decisione esplicita dell'utente**: *"teniamo il titolo generato da yt-dlp in modo da non dover mai più allineare nessun video. Nella gui mostriamo invece il titolo originale scaricato da yt. Nella cli se non è possibile mostrare quel titolo mostriamo quello generato da yt-dlp"* — tre conseguenze concrete:

1. **Core (`libraryService.js`)**: nuova `isAlreadyOrganized(current, videoId)` — un file è considerato "già a posto" se si trova in una sottocartella (creator) **e** il nome contiene il marker `[<id>]`, senza più richiedere che coincida carattere per carattere con `targetRelPath()`. Il nome scelto da yt-dlp al momento del download resta quello buono per sempre; non viene più "corretto" per farlo combaciare col sanitizzatore del progetto. `targetRelPath()`/`sanitizeName()` restano invariati e continuano a servire solo come nome di ripiego per i file ancora piatti nella radice (vecchio layout, mai organizzati). Effetto collaterale positivo: anche una cartella-creator con un nome leggermente diverso da quello che il progetto ricalcolerebbe oggi (es. un canale rinominato) non viene più forzata a un rename — coerente con lo stesso principio "non toccare ciò che già funziona".
2. **GUI web**: nessuna modifica necessaria — verificato che `VideoCard`, `ChannelPage`, `SearchPage`, `VideoDetailPage` mostravano già tutte `video.title ?? video.id` (il titolo originale raw, mai derivato dal filename).
3. **CLI (`cli.js`)**: nuovo helper `displayTitle(video)` — normalmente il titolo originale; se assente, deriva un titolo leggibile dal nome file già scelto da yt-dlp (`video.video.localPath`, tolti estensione e suffisso `" [<id>]"`); solo come ultimissima risorsa l'id nudo. Sostituisce tutte le 8 occorrenze di `v.title ?? v.id` nel file (menu "Rivedi novità", "Guarda", "Cerca", "Catalogo", conferme di decisione). Le due occorrenze di `result.title ?? result.videoId` in `singleDownloadFlow` (oggetto di esito del download singolo, non un video completo con `localPath`) sono state lasciate invariate.

**Verifica eseguita sul catalogo reale dell'utente** (nessun dato di test, il caso era già presente): `reorganizeLibrary({dryRun:true})` prima del fix → 1 pianificato (`Gq4aN6KnJoE`), 62 già a posto; dopo il fix → `moved:0, planned:[], alreadyOk:63`. Server riavviato (processo Node non ricarica codice sorgente modificato) e verificato nel browser reale su `/library`: banner "0 da spostare · 63 già a posto". Verificato `/videos/Gq4aN6KnJoE`: titolo mostrato con il `|` normale originale (non il `｜` del filename). `displayTitle()` verificato in isolamento per i 3 casi (titolo presente; titolo assente con ripiego riuscito sul filename; né l'uno né l'altro → id). `node --check` pulito su entrambi i file modificati.


## M23 — Pagina "Libreria" svuotata (ritiro di "Riorganizza libreria" dal web)

Nasce da una domanda dell'utente durante l'analisi del punto 6 del backlog: "la parte 'sposta file' di Riorganizza libreria si può rimuovere? non mi sembra serva più — cosa mostra ancora?". Analisi confermata: dopo la migrazione una tantum dell'archivio (M9.2, 52 file) e il criterio strutturale di M22, ogni nuovo download nasce già nel layout canonico `<Creator>/<Titolo> [id].ext`, quindi la lista "da spostare" è **strutturalmente sempre vuota** (verificato in M22: `planned:[]`, 63 già a posto). Il pulsante "Sposta N file" era permanentemente disabilitato. L'unico readout con un minimo di valore residuo ("N non trovati su disco") è comunque ridondante con l'auto-guarigione di `syncSource`.

**Decisione esplicita dell'utente**: *"svuota completamente la pagina e rinominala in 'Libreria', cambia anche l'icona. Per il momento lasciala vuota."* — la pagina non viene rimossa ma **parcheggiata come placeholder** per un uso futuro (lo slot in navigazione e la rotta `/library` restano).

Modifiche, tutte lato `packages/web`:
- **`pages/LibraryPage.jsx`**: riscritta come contenitore vuoto — `page-head` "Libreria" + un `.empty-state` "Questa sezione sarà popolata in futuro.". Rimossi il dry-run automatico all'apertura, il banner con i conteggi, la lista `from → to` e il pulsante "Sposta". Rimossi gli import ormai inutili (`reorganizeLibrary` dal client, `FolderTree` da lucide-react).
- **`components/Layout.jsx`**: la voce di sidebar passa da `Wrench` + "Riorganizza libreria" a `Library` (icona libri su scaffale, coerente col nome) + "Libreria".

**Cosa resta invariato di proposito**: la funzione core `reorganizeLibrary()` (`libraryService.js`), l'endpoint `POST /api/library/reorganize` e la voce CLI "Riorganizza libreria (per creator)" **non sono stati toccati** — la direttiva era esplicitamente sulla pagina web. La riorganizzazione resta quindi disponibile come utility di manutenzione (via CLI o via API diretta) se un giorno servisse una nuova migrazione dell'archivio, senza però ingombrare l'interfaccia web dove non ha più nulla da fare. La voce CLI resta un candidato a una futura ripulitura, da decidere separatamente con l'utente.

**Verifica eseguita**: build di produzione del pacchetto web pulita (`vite build`, 0 errori — conferma che tutti gli import si risolvono); `Library` confermata come export reale di `lucide-react` (`typeof === 'object'`) e nessun riferimento residuo a `Wrench` o a "Riorganizza" nel codice web (solo il commento storico dentro `LibraryPage.jsx`). La verifica visiva nel browser non è stata eseguita in automatico: in questa sessione non era disponibile alcuno strumento di automazione browser — dichiarato apertamente invece di darla per fatta.

## M24 — Punto 6: storico download sempre visibile, cancellazione job, storage consolidato

Il punto 6 del backlog chiedeva due cose per la pagina "Scarica video singolo": (a) vedere **sempre** lo storico dei download (non solo durante un download, com'era — la pagina rediregeva a `/jobs` e non mostrava nulla di suo), e (b) poter **cancellare** i job dallo storico, singolarmente e in blocco (funzionalità prima assente ovunque). In corso d'opera l'utente ha aggiunto tre affinamenti: niente redirect (input sempre disponibile per accodare più download), durante il download **solo la barra di avanzamento** (niente box di log testuale), e — separatamente — il consolidamento dello storage in un unico file JSON.

**Decisioni prese con l'utente** (via domande mirate): cancellazione = **solo il record storico** (video e file su disco restano intatti); storico nella pagina "Scarica video" = **tutti i job** (non solo i singoli); cancellazione in blocco = **"Svuota storico"** (un pulsante). Vincolo tecnico: un job `running`/`queued` **non è cancellabile** — `jobManager` non ha un meccanismo di abort, quindi cancellarne il record lascerebbe il worker orfano; il cestino compare solo sui terminati.

**core (`jobs/jobManager.js`)** — due aggiunte + un cambio di storage:
- `deleteJob(id)`: rifiuta i `running`/`queued`, altrimenti rimuove il job dalla Map in memoria e riscrive lo store. `clearJobs()`: cancella tutti i terminati in un colpo (un solo persist), lasciando gli attivi.
- **Storage consolidato in `data/jobs.json`** (prima: un file per job in `data/jobs/<id>.json`). Su richiesta esplicita dell'utente. Lo store è caricato in memoria una sola volta (`ensureLoaded()`) e riscritto per intero a ogni mutazione con **scrittura atomica** (`jobs.json.tmp` + `renameSync`). A differenza di `catalogStore.js` **non serve il mutex asincrono**: le mutazioni dei job avvengono in modo sincrono dentro il worker single-thread (nessun `await` tra la modifica della Map e il persist), quindi due persist non possono interlacciarsi nello stesso processo. Resta valido il trade-off che l'utente ha accettato consapevolmente rispetto al layout un-file-per-job: ogni flush di log riscrive l'intero storico, e due processi (server + CLI) che scaricano in contemporanea si sovrascriverebbero — mitigato dalla scrittura atomica e dalla regola generale "riavvia il processo dopo modifiche esterne".
- **Migrazione una tantum trasparente**: al primo `ensureLoaded()`, se `data/jobs.json` non esiste ma c'è la vecchia cartella `data/jobs/` con file per-job, li legge tutti, scrive il consolidato e **rimuove i vecchi file**. `config.js` non crea più la cartella `data/jobs/` (il path `jobsDir` resta esposto solo per la migrazione). `data/jobs.json` aggiunto al `.gitignore`.

**server**: `DELETE /api/jobs/:id` (→ `deleteJob`) e `DELETE /api/jobs` (→ `clearJobs`, svuota i terminati); gli errori di `core` (es. job in corso) diventano `400` via `asyncRoute`. `publicJob.js` arricchisce ora ogni job anche col **`title`** del video: per `downloadSingle` dal `params.videoId` (stessa chiamata `getVideo` già usata per la thumbnail, nessun costo aggiuntivo); per i batch `downloadPending` resta `null` (sono più video, la UI mostra il label del tipo). Un video sparito dal catalogo → `title` `null`, ripiego graceful.

**web**: nuovo componente condiviso **`components/JobHistory.jsx`** (evita di duplicare la stessa lista in due pagine). Ogni item dello storico ha, come richiesto, la **copertina del video a tutta altezza** dell'item (flex `align-items: stretch`, `object-fit: cover`, larghezza fissa 132px) a sinistra e il **titolo del video** a destra, con riga stato/ora, cestino (solo sui terminati) e log espandibile al click. In cima, "Svuota storico" (con `confirm`). Usato da:
- `JobsPage`: card live in alto (log dettagliato via SSE, invariata) + `JobHistory` sotto (il job evidenziato è escluso finché è in corso, poi ricompare nello storico al cambio di `live.status`).
- `SingleDownloadPage`: **ridisegnata** secondo le richieste — input sempre presente (nessun `navigate`, l'URL si svuota dopo l'invio per accodare il prossimo), durante il download **solo `.progress-bar`** alimentata da `useJobStream` (niente box di log), `JobHistory` sempre visibile sotto. Il job attivo è escluso dallo storico solo mentre è in corso (mostrato come barra), poi vi ricompare.

**Verifica eseguita**:
- *Migrazione reale* (23 job dell'utente): prima 23 file in `data/jobs/`, `jobs.json` assente; dopo `listJobs()` → `data/jobs.json` (version 1) con **23 job**, **0 file residui** in `data/jobs/`, 0 job malformati, conteggio invariato.
- *deleteJob* (su job finti terminati, poi ripuliti): terminato → `{deleted:1}` e file/record rimosso; `running` → **rifiutato** con messaggio chiaro; conteggio job prima/dopo invariato (nessun residuo di test).
- *Arricchimento* su dati reali via `toPublicJobs(listJobs())`: `downloadSingle` con titolo reale ("ASMR Gina Carla 🥼 Dr. G's Treatment! Roleplay!") + copertina; `downloadPending` batch → `title: null` (ripiego sul label). 13/18 single con titolo (gli altri hanno il video non più in catalogo → ripiego gestito).
- Build di produzione web pulita; `node --check` su `jobManager.js`/`config.js`/`publicJob.js`.
- La verifica visiva/click nel browser **non è stata eseguita in automatico**: in questa sessione non era disponibile alcuno strumento di automazione browser (dichiarato apertamente, non spuntato come fatto).

**Nota operativa**: durante la verifica è emerso che un server era già in ascolto sulla `:3001` con il codice pre-migrazione (la nuova istanza dava `EADDRINUSE` e le richieste colpivano quello vecchio, che mostrava 1 solo job e nessun titolo). È il caso classico del `CLAUDE.md` sui processi da riavviare: **il server e/o CLI già in esecuzione vanno riavviati** per caricare il nuovo `jobManager` e leggere `data/jobs.json`.

## M25 — Modello di stato a flag ortogonali + migrazione

Riscrittura del "punto 1" del progetto (l'area sorgenti + il download), prima tappa di un piano a quattro (M25→M28, vedi `PIANO.md`). Il modello a **singolo `status` lineare** (`new/pending/downloading/downloaded/failed/excluded`) non sapeva esprimere stati che nella realtà **coesistono**: un video può essere insieme "presente su YouTube" *e* "scaricato"; "nascosto" è indipendente dall'essere scaricato. M25 smonta `status` in **assi ortogonali** sullo schema del video.

**Decisione di fondo** (scelta con l'utente tra le opzioni consigliate): tre assi indipendenti invece di un enum unico —

- `presence`: `'present' | 'removed'` (presenza su YouTube, la aggiorneranno le sync in M27) + `removedAt`.
- `download`: `'none' | 'downloading' | 'downloaded' | 'failed'` (l'ex pipeline di download lato server).
- `hidden`: booleano ("nascosto", sostituisce l'ex `excluded`).

Il flag `local`/Electron, inizialmente previsto, è stato **rimosso dal piano** su richiesta dell'utente: resta fuori finché non si affronterà quel lato del progetto (lo schema resta comunque estendibile).

**Categoria derivata** (`videoCategory` in `catalogSchema.js`): un unico punto nel core collassa i tre assi in una categoria a una dimensione (`available/downloaded/downloading/failed/hidden/removed`) per le viste/badge/ordinamenti che mostrano un solo indicatore. Priorità: `removed > downloading > failed > hidden > downloaded > available`. Così CLI e web (adapter) **non reimplementano la regola** — la consumano soltanto (principio ribadito dall'utente: la logica vive nel core).

### Core (il grosso del lavoro)

- **`catalogSchema.js`**: nuove costanti `PRESENCE`/`DOWNLOAD_STATE`/`VIDEO_CATEGORY`, `videoCategory()`/`isDownloaded()`, `createNewVideoStub()` ora crea i flag (`present/none/hidden:false`, niente più `status`/`decidedAt`), e `migrateVideoToFlags()` (migrazione idempotente dal vecchio `status`: mappa `downloaded→{present,downloaded}`, `new`/`pending→{present,none}`, `excluded→{present,none,hidden}`, `failed→{present,failed}`, `downloading→{present,none}`; cancella `status`/`decidedAt`).
- **`catalogStore.js`**: `reconcileOnLoad()` ora migra ogni video ai flag al primo avvio (una tantum, trasparente, stesso pattern di M14/M24) e la reconciliation degli interrotti passa da `downloading→pending` a `downloading→none`.
- **`decisionService.js`**: `decideVideo` (ciclo new/pending/excluded, rimosso) sostituito da `setVideoHidden(id, hidden)` — l'unico stato "deciso" persistente è ora nascondi/mostra; scaricare è un'azione via job, non una decisione.
- **`videoService.js`**: `listVideos({presence, download, hidden})` filtra per flag (AND); `listNew()` → `listAvailable()` (present+none+non nascosto); `listChannels`/`listVideosByChannel` filtrano per `{download:'downloaded'}`.
- **Job**: `downloadSingle.js` usa l'asse `download`; `downloadPending.js` **rifatto** — riceve una lista esplicita `params.videoIds` (la selezione multipla di M28) invece di scansionare lo stato `pending`, che non esiste più.
- **`singleVideoService.js`**: `prepareSingleVideoDownload(input, { download = true })` — con `download:false` aggiunge solo lo stub `present/none` senza lanciare job (base per il checkbox "Download immediato" di M29); un id già in libreria ma non scaricato ora è scaricabile direttamente (niente più rimando a "Rivedi novità").
- **`playbackService.js`**/**`libraryService.js`**/**`syncService.js`**/**`channelAvatarService.js`**: adeguati all'asse `download` (guarigione file sparito: `downloaded→none`).
- **`index.js`**: esporta `setVideoHidden`, `listAvailable`, `videoCategory`, `VIDEO_CATEGORY`, `PRESENCE`, `DOWNLOAD_STATE`; rimossi `decideVideo`/`listNew`.

### Adapter (server → web → CLI)

- **Server**: `publicVideo.js` aggiunge `category` (derivata nel core) a ogni video, oltre ai flag grezzi già presenti; `videos.routes.js` — `/videos` non filtra più server-side (il frontend filtra per categoria), nuovo `POST /videos/:id/hidden` al posto di `/decision`, `/videos/download-single` accetta `download` (default true), `listNew`→`listAvailable`.
- **Web**: `lib/status.js` riscritto per **categorie** (`CATEGORY_ORDER/LABEL/LABEL_PLURAL/PRIORITY/COLOR_VAR`), nuovo colore `--st-removed` (ambra); `lib/reviewActions.js` → `actionsFor(video)` che deriva le azioni dai flag (`download`/`hide`/`unhide`); `StatusBadge`/`StatusChips` per categoria; `VideoCard`/`CatalogPage`/`SearchPage`/`VideoDetailPage` usano `video.category` e le nuove azioni (icone `Download`/`EyeOff`/`Eye`); rimosso il banner "Scarica in coda" (niente più coda pending); `SingleDownloadPage` senza il ramo `already-tracked`, con i nuovi esiti `added`/`already-present`.
- **CLI** (`cli.js`): mappe icona/etichetta per categoria (via `core.videoCategory`), `cliActions(video)` deriva le azioni dai flag, `applyReviewDecision` scarica direttamente (job) o nasconde/mostra, `runDownloadQueue` raccoglie gli id `available`/`failed` e li passa a `downloadPending({videoIds})`, `catalogFlow` filtra per categoria.

### Verifica end-to-end reale eseguita

- **Migrazione sintetica**: tutte e sei le vecchie categorie mappate correttamente ai flag + categoria derivata; idempotente al secondo giro; `createNewVideoStub` genera i nuovi flag e non i vecchi campi.
- **Migrazione reale sul catalogo dell'utente** (backup `data/catalog.backup-M25-*.json` fatto prima): **64/64 video migrati, 0 residui `status`/`decidedAt`, stessi id, 3 sorgenti intatte**, tutti categoria `downloaded`, schema conforme al 100%. Conteggio prima/dopo invariato.
- **Operazioni core**: `setVideoHidden` reale (categoria `downloaded↔hidden`) con ripristino; `prepareSingleVideoDownload(download:false)` su id già scaricato → `already-downloaded` senza mutazioni.
- **Server (istanza di test su :3002, per non toccare quella dell'utente su :3001)**: `GET /api/videos` porta `category`+flag e nessun `status`; `POST /videos/:id/hidden` commuta correttamente; `download-single {download:false}` su già scaricato → `already-downloaded`; `/channels` ok.
- **Build**: build di produzione web pulita; `node --check` su tutti i file core/server/cli toccati.
- **Non eseguito**: la verifica visiva/click nel browser a stack completo — il server dell'utente occupava la `:3001` con codice pre-M25 (dichiarato apertamente, non spuntato come fatto). L'API e la build sono verificate; l'UI renderizzata no.

**Nota operativa (concorrenza `CLAUDE.md`)**: durante la verifica un server era già in ascolto sulla `:3001` con il **codice pre-M25** e il **catalogo in memoria pre-migrazione**. Va **riavviato** per caricare il codice M25 e il catalogo migrato. Nessun rischio di perdita dati: la migrazione è idempotente e rieseguita a ogni avvio del codice nuovo — se il vecchio server riscrivesse lo schema vecchio nel frattempo, il riavvio lo ri-migra. Il file di backup resta in `data/` finché l'utente non lo rimuove.

## M26 — Ingest a due fasi con metadati completi + barra sul Sync

Seconda tappa del ridisegno. Prima di M26 una fonte portava solo i metadati **leggeri** dell'enumerazione flat-playlist (id/titolo/durata/canale) e i metadati completi arrivavano **solo al download**. Ora l'ingest è a **due fasi**:

1. **Fase 1 (istantanea)**: `addSource`/`syncSource` popolano subito la libreria con i metadati leggeri (invariato) — i video compaiono immediatamente.
2. **Fase 2 (background, con progresso)**: un nuovo job **`enrichSource`** estrae i **metadati completi** per-video (descrizione, tag, capitoli, risoluzione, statistiche) e **cacha la copertina** in `media/thumbnails/<id>.jpg`, senza scaricare il video. Emette avanzamento `i/total` sull'`EventEmitter` del job manager.

**Perché cachare le copertine subito**: un video poi "rimosso" da YouTube (M27) conserva così la propria copertina anche quando l'URL originale muore — coerente con l'obiettivo di preservazione.

### Core

- **`ytdlpWrapper.fetchVideoMetadata(videoId, url, {onLog})`** (nuova): `yt-dlp --skip-download --write-info-json --write-thumbnail --convert-thumbnails jpg -o media/thumbnails/%(id)s.%(ext)s`. Legge l'info.json, mappa i campi curati con `mapInfoJsonToVideoFields` (riuso), consolida il grezzo in `data/metadata.json` e cancella il sidecar; pulisce eventuali thumbnail intermedie (`.webp`) lasciando solo la `.jpg`. Ritorna i campi curati **escluso l'oggetto `video`** (nessun file scaricato: lo stato di download non va toccato).
- **`jobs/jobs/enrichSource.js`** (nuovo): arricchisce i video `present`, non scaricati/in-download e non ancora arricchiti (`!enrichedAt`), opzionalmente filtrati per `params.sourceId`. Idempotente (un secondo Sync non rifà nulla), tollerante ai fallimenti per-video (uno fallito non blocca il batch). Fonde i metadati nella entry con `Object.assign(current, meta, {enrichedAt, updatedAt})`, senza toccare `presence`/`download`/`hidden`/`source`.
- **`catalogSchema.createNewVideoStub`**: nuovo campo `enrichedAt: null` (marker di idempotenza).
- **`index.js`**: registrato `enrichSource`.

### Adapter

- **Server** (`sources.routes.js`): `POST /sources` dopo `addSource` lancia `enrichSource({sourceId})` e torna `{...result, jobId}`; `POST /sync` esegue la fase 1 (flat, sincrona) e poi lancia `enrichSource` (per la fonte o per tutte), tornando `{results, jobId}`.
- **Web** (`SourcesPage`): "Sincronizza"/"Aggiungi" ora seguono il `jobId` con `useJobStream` e mostrano una **barra di avanzamento** ("Arricchimento metadati e copertine…") che si riempie fino a fine job; a fine job ricaricano l'elenco fonti.
- **CLI** (`cli.js`): `addSourceFlow`/`syncFlow` lanciano `enrichSource` via `runJobToCompletion` con log live (helper `enrichAfterIngest`).

### Verifica reale eseguita

- **Arricchimento end-to-end** su un video pubblico ("Me at the zoo", `jNQXAC9IVRw`): aggiunto come `present/none` (via `prepareSingleVideoDownload(download:false)`), poi `enrichSourceJob` → `enrichedAt` valorizzato, descrizione/tag/39 thumbnails/durata popolati, **copertina `.jpg` scritta su disco** (webp intermedio ripulito), entry in `data/metadata.json`, **`download` resta `none`** (categoria ancora `available`). Idempotenza confermata (secondo giro: 0 arricchiti). **Cleanup completo**: catalogo tornato a 64, nessuna thumbnail/metadata/entry di test residua.
- **Job manager**: `triggerJob('enrichSource', {})` sul catalogo reale (tutti scaricati → 0 candidati) → `status: success`, `summary {enriched:0}` — registrazione ed eventi ok.
- **Build** web di produzione pulita; `node --check` su tutti i file toccati.
- **Non eseguito**: il click reale su "Sincronizza" nel browser con una fonte che porta video nuovi (mutarebbe il catalogo reale dell'utente e richiede il server riavviato) — da confermare dall'utente dopo il riavvio. Logica e wiring verificati.

## M27 — Detection "Rimosso" nel refresh

Terza tappa. Una sync (`syncSource`) ora rileva i video **spariti dalla fonte** e li marca `presence: 'removed'` (+ `removedAt`), **senza mai cancellare** file o metadati — è il cuore dell'obiettivo di preservazione: un creator cancella un video da YouTube, ma la nostra copia e la sua scheda restano.

**Dove**: tutto in `syncService.ingestPlaylistEntries` (nessuna logica negli adapter). Dopo aver processato gli entries trovati:
- **Sweep dei rimossi**: ogni video con `source.sourceId === <questa fonte>` **non presente** tra gli entries e ancora `present` → `presence: 'removed'`, `removedAt: now`. Non tocca `download` né i file su disco.
- **Ripristino reversibile**: se un video prima `removed` **ricompare** tra gli entries, torna `presence: 'present'`, `removedAt: null`.

Scelta (opzione A concordata): **reattivo al primo refresh mancante**, accettando possibili falsi positivi transitori (glitch di YouTube, video privato a tempo) perché **reversibili** al refresh successivo. `getPlaylistEntries` fallisce con eccezione se yt-dlp non enumera (rete/errore), quindi non si arriva mai al sweep con una lista vuota "per errore".

`ingestPlaylistEntries` ora ritorna anche `removedCount`/`restoredCount`, esposti nei messaggi di CLI (`syncFlow`) e web (`SourcesPage`). `addSource` (primo ingest di una fonte nuova) non ha video preesistenti → detection no-op lì.

La categoria derivata di un video rimosso è `removed` (la presenza vince sullo stato di download nella priorità di `videoCategory`): anche un video **scaricato** poi rimosso si mostra come "Rimosso", pur mantenendo il file riproducibile.

### Verifica reale eseguita

Test unitario della funzione pura su catalogo sintetico in memoria (nessun dato reale toccato, dir video temporanea):
- **Sync 1** (R1 non più nella fonte): R1 → `removed` + `removedAt`; D1 (scaricato, ancora in fonte) resta `present`/`downloaded`, file su disco intatto. `removedCount:1`.
- **Sync 2** (anche il video scaricato D1 sparisce): D1 → `removed`, ma **`download` resta `downloaded`, `localPath` intatto, file NON cancellato** — la copia locale sopravvive alla rimozione da YouTube.
- **Sync 3** (R1 e D1 ricompaiono): entrambi ripristinati a `present`, `removedAt: null`, D1 ancora `downloaded`. `restoredCount:2`.

`node --check` su `syncService.js`/`cli.js` ok. Verifica reale con una playlist che perde davvero un video: da confermare dall'utente su una fonte reale (non forzata per non mutare il catalogo).

## M28 — Pagina "Libreria"

Quarta tappa: la pagina `/library` (finora placeholder vuoto, M23) diventa la **vista centrale** sull'intero catalogo, sfruttando il modello a flag di M25.

**Contenuto** (`packages/web/src/pages/LibraryPage.jsx`):
- **Filtri**: chip per categoria derivata (riuso `StatusChips`: Su YouTube / Scaricati / In download / Falliti / Nascosti / Rimossi) + dropdown **creator** (derivato dai video caricati) + dropdown **sorgente** (da `listSources`, più "Singoli (senza sorgente)" per `source.sourceId === null`).
- **Ordinamento**: riuso `lib/sort.js` (M19).
- **Azioni rapide per-video**: stesse di Home (`actionsFor` → Scarica/Nascondi/Mostra), via `VideoCard`.
- **Selezione multipla → download in blocco**: `VideoCard` esteso con checkbox opzionale (`selected`/`onToggleSelect`); una barra "N selezionati" con "Scarica selezionati" lancia `triggerJob('downloadPending', { videoIds })` (il job salta i già scaricati/in-download) e porta alla pagina Job. "Seleziona scaricabili (N)" seleziona in un colpo tutti i non-scaricati in vista.

**"Novità" come filtro derivato**: non è più uno stato persistito né una vista dedicata — è semplicemente il filtro categoria "Su YouTube" (`available`). Il vecchio ciclo "Rivedi novità"/coda del web era già stato smontato in M25 (banner "Scarica in coda" rimosso); qui la Libreria lo sostituisce del tutto come luogo dove si rivede e si agisce.

La logica di filtro/ordinamento è tutta client-side su dati già caricati (nessuna modifica server), coerente con M19; la categoria arriva già calcolata dal core (`video.category`).

### Verifica eseguita

- **Download in blocco** via job manager: `triggerJob('downloadPending', { videoIds })` con 3 id già scaricati → il job li salta (`total:0`, `status:success`) — conferma il percorso della selezione multipla end-to-end.
- `listSources` restituisce le 3 fonti reali con nome e conteggio (usate dal filtro sorgente).
- Build di produzione web pulita; nuovo CSS `.card-select`/`.card.selected` (checkbox in alto a destra, non sovrapposta alla badge in alto a sinistra).
- **Verifica browser rimandata alla sessione combinata finale** (M28+M29+M30) su porte libere: il server dell'utente occupa la :3001 con codice pre-M25, quindi un test browser full-stack per-milestone non è pulito. Logica e build verificate.

## M29 — Aggiunta rapida in Libreria + riorganizzazione navigazione

Quinta tappa. L'aggiunta di un video singolo si sposta **in testa alla Libreria**, e la vecchia pagina "Scarica video" diventa **"Cronologia"**.

**Aggiunta rapida** (`LibraryPage`, in cima): un campo "incolla un link" + checkbox **"Download immediato"** (default acceso) + "Aggiungi".
- **Download immediato acceso**: `downloadSingle(url, true)` → azione `download`, parte il job e una **barra di avanzamento** inline segue il progresso (via `useJobStream`); a fine job la libreria si ricarica.
- **Download immediato spento**: `downloadSingle(url, false)` → azione `added`, il video viene solo **aggiunto** alla libreria come `presence:'present'`/`download:'none'` (categoria "Su YouTube"), **senza scaricarlo** — poggia sull'opzione `{download}` di `prepareSingleVideoDownload` già introdotta in M25 e sul relativo passaggio nel route server (M26). Gestiti anche gli esiti `already-downloaded`/`already-downloading`/`already-present`.

**Navigazione riorganizzata**:
- Nuova `HistoryPage` (`/history`, "Cronologia"): solo lo storico job (`JobHistory`), niente più form. `SingleDownloadPage.jsx` rimosso.
- Sidebar (`Layout`): "Scarica video" (in alto, icona `Download`) → rimossa; "Cronologia" (icona `History`) aggiunta **in basso**, dopo "Libreria". Ordine: Home · Sorgenti · Libreria · Cronologia.
- `MobileNav`: il pulsante "+" ora punta a `/library` (dove si aggiunge), non più a `/download`.

### Verifica eseguita

- Core dell'aggiunta senza download (`prepareSingleVideoDownload(download:false)` → `added`, stub `present/none`) già verificato in M26; il passaggio del flag `download` nel route `/videos/download-single` in M25.
- Build di produzione web pulita; nessun riferimento residuo a `SingleDownloadPage`/rotta `/download` (solo l'endpoint API `download-single`, invariato).
- **Verifica browser rimandata alla sessione combinata finale** (M28+M29+M30).

## M30 — "Vuoi tenere il video?" quando si nasconde un video scaricato

Sesta e ultima tappa del ridisegno. Nascondere un video **scaricato** ora chiede **"Vuoi tenere il video?"**: **Sì** → resta scaricato ma nascosto; **No** → viene cancellato **solo il file sul disco** (`download → none`), ma **il video resta in libreria** (scheda, metadati grezzi e copertina intatti). Nessuna domanda se il video non è scaricato.

### Core

`libraryService.deleteVideoFile(id)` (nuova, esposta da `index.js`): cancella il file `video.localPath` dal disco, rimuove la sottocartella creator se rimasta vuota (mai la root `videosDir`), riporta `download:'none'` e azzera i soli campi legati al file fisico dell'oggetto `video` (localPath/codec/size/sha256/downloadedAt/…). **Non tocca** entry di catalogo, metadati grezzi (`data/metadata.json`) né copertina. Rifiuta con errore se il video non è `downloaded`.

### Adapter

- **Server**: `DELETE /api/videos/:id/file` → `deleteVideoFile`, ritorna il video pubblico aggiornato.
- **Web**: nuovo hook condiviso `hooks/useHideWithPrompt.jsx` — `requestHide(video)` nasconde direttamente i non-scaricati, mentre per gli scaricati apre un **modale** "Vuoi tenere il video?" (Annulla / Cancella il file / Tieni il video). Usato da `LibraryPage`, `CatalogPage`, `SearchPage`, `VideoDetailPage`: la logica del prompt vive in un solo posto, le pagine chiamano `requestHide` e renderizzano `{modal}`. Nuovo client `deleteVideoFile(id)`. CSS `.modal-overlay`/`.modal`.
- **CLI**: in `applyReviewDecision`, nascondere un video scaricato chiede via `confirm` "Vuoi tenere il video? (No = cancella il file dal disco)"; No → `deleteVideoFile` + `setVideoHidden(true)`.

### Verifica reale eseguita

Test su video **fittizio** creato apposta (mai un file reale dell'utente): file dummy + entry `downloaded` in una sottocartella `__M30TEST__` →
- `deleteVideoFile`: **file cancellato dal disco**, **cartella creator vuota rimossa**, `download:'none'`, `localPath:null`, categoria `available`; **entry ancora in libreria con titolo e copertina conservati**.
- **Guardia**: `deleteVideoFile` su un video non scaricato → errore (rifiutato).
- **Cleanup**: catalogo tornato a 64, nessuna entry/cartella di test residua.

`node --check` su core/server/CLI ok; build web pulita. Verifica browser del modale nella sessione combinata finale (senza mai cliccare "Cancella il file" su dati reali).

## M31 — Riorganizzazione UI e navigazione (flag-first)

Round di richieste dell'utente che ridefiniscono la navigazione web attorno al principio "il download è solo un flag: l'interfaccia lavora sui metadati". Raccolte e implementate insieme.

**Menu ⋮ sulle card** (`VideoCard`): al posto dei pulsanti inline in hover, un menu a tendina in stile YouTube con icone — *Scarica video*, *Archivia*↔*Ripristina* (contestuale a `hidden`), *Mostra profilo* (link alla pagina creator). Le voci di azione derivano da `actionsFor(video)`; "Mostra profilo" è un link a `/channels/:key`. Chiusura con backdrop a schermo intero. La card resta interamente popolata dai metadati (titolo, copertina cachata, creator) anche per i video solo "disponibili".

**Home** (`CatalogPage`) = libreria attiva: **esclude gli archiviati** (i nascosti vivono in "Archiviati"). Chip filtro ridotte a **Tutti / Da scaricare / Falliti** (`StatusChips` ora accetta un set di categorie personalizzato via prop `options`). Aggiunti il **filtro per sorgente** (oltre a creator e ordinamento).

**Sorgenti** (`SourcesPage`) = unico punto di ingresso: l'input **riconosce** se è una *playlist* (contiene `list=` senza `v=`, o `/playlist?`) → nuova fonte, o un *singolo video* (watch/`youtu.be`/id/altri siti) → aggiunto o scaricato, con il checkbox **"Download immediato"**. In fondo alla pagina lo **storico dei download** (`JobHistory`).

**"Libreria" → "Archiviati"** (`ArchivedPage`, ex `LibraryPage`): mostra **solo** i video archiviati/nascosti, con le **copertine in bianco e nero** (`.grayscale-grid`, colore al passaggio del mouse); ordinamento + filtro creator; niente chip categoria, form o selezione multipla. Da qui si ripristina (menu ⋮ → Ripristina), si scarica o si va al profilo.

**Pagina "Cronologia" rimossa** (`HistoryPage`/rotta `/history` eliminate): il suo storico vive ora in fondo a Sorgenti. Sidebar: `Home · Sorgenti · Archiviati`; il "+" del menu mobile punta a `/sources`.

### Bug corretti nello stesso round

- **Creator/video invisibili senza download**: `listChannels`/`listVideosByChannel` avevano default `download:'downloaded'` → un creator con soli video "disponibili" (es. una fonte appena aggiunta, 0 scaricati) non compariva né in sidebar né nella sua pagina. Ora il default è **tutti** i video; i contesti "solo scaricati" (Guarda nel CLI) passano esplicitamente `{download:'downloaded'}`. `ChannelPage` mostra tutti i video del creator (esclusi i nascosti) con badge di stato.
- **Foto profilo non scaricata per il nuovo creator**: `syncChannelAvatars` era limitato ai creator con video scaricati. Ora copre **tutti** i creator, e viene eseguito **automaticamente a fine `enrichSource`** (`force:false` → scarica solo le mancanti), così aggiungendo una fonte l'avatar arriva senza un'azione manuale separata.
- **Cronologia "senza dati di download"**: lo storico era invaso dai job `enrichSource` (arricchimento metadati lanciato dalle sync), privi di titolo/copertina. `JobHistory` ora **filtra via** i job `enrichSource`: la Cronologia mostra solo i job di download (con copertina e titolo, come sempre).

### Verifica

Build di produzione web pulita; `node --check` su tutti i file core toccati; `/api/channels` restituisce 10 creator (incluso quello con soli video "disponibili"); `/api/jobs` — i job `enrichSource` presenti vengono nascosti dalla Cronologia lato client. Server riavviato per caricare i cambi core (`videoService`/`channelAvatarService`/`enrichSource`). Verifica visiva completa nel browser a carico dell'utente (il server dell'utente occupa la :3001).

## M32 — Rifiniture UX (grazia sui rimossi, menu ⋮ esteso, badge a pallino, archivia defilato)

Round di rifiniture su richiesta dell'utente, sopra M31.

**"Rimosso" con periodo di grazia**: prima un video assente da una sync veniva marcato `removed` subito (falsi positivi su glitch temporanei di YouTube — l'utente ne ha notati 2). Ora `syncService.ingestPlaylistEntries` conta le assenze consecutive (`missCount`, nuovo campo nello stub) e marca `removed` solo al raggiungimento di **`REMOVED_MISS_THRESHOLD = 2`** (un paio di tentativi). Al primo ritrovamento `missCount` si azzera e, se era `removed`, si ripristina `present`.

**Menu ⋮ esteso** (`VideoCard`) con due voci:
- **"Aggiorna metadati"** (`refreshVideoMetadata`, nuova in `metadataService`, esposta via `POST /api/videos/:id/metadata/refresh`): ri-scarica metadati completi + copertina. Mostrata **anche sui rimossi**, dove funge da **ri-verifica**: se il video è di nuovo raggiungibile viene ripristinato (`present`), se resta irraggiungibile ed era `removed` **non si tocca nulla** (stato confermato); su un video non rimosso un errore reale viene propagato.
- **"Cancella video"** = `deleteVideoFile` (M30): cancella **solo il file** dal disco (`download→none`), lasciando scheda, metadati e copertina. Mostrata solo per gli scaricati e **mai sui rimossi** (i rimossi vanno preservati). Conferma via `window.confirm`.

**Badge a pallino** (`StatusBadge` + `badgeState` in `lib/status`): il badge sulla copertina non è più una pillola di testo ma un **pallino colorato**, e — punto chiave — è **indipendente dal flag `hidden`** (quello lo comunicano la pagina Archiviati e il bianco/nero). Regole: scaricato = **nessun badge** (è lo standard), *Su YouTube* = **verde** (nuova var `--st-available`), *rimosso* = **arancione**, *errore download* = **rosso**, in download = accento. Inline (ricerca/placeholder) mostra pallino + etichetta.

**Pagina video**: il tasto per archiviare era troppo accessibile (in mezzo alle azioni di riproduzione). Spostato in una riga **a sé sotto**, allineato a sinistra, stile **rosso mattone** (`.btn-brick`) e **con conferma** (per gli scaricati la conferma è il modale "Vuoi tenere il video?" di M30; per gli altri un `window.confirm`). Le azioni di download/riproduzione restano a destra; "Ripristina" (per un archiviato) resta un pulsante normale. Inoltre il placeholder **"Non ancora disponibile per la riproduzione"** ora mostra la **copertina del video molto scurita** (overlay nero all'82%) invece delle bande oblique, così la scritta resta leggibile.

### Verifica

Test unitario del periodo di grazia su catalogo sintetico: sync assente 1 → `present/miss1`; assente 2 → `removed/miss2`; ricompare → `present/miss0` (ripristinato). Build di produzione web pulita; `node --check` su core/server toccati. Server riavviato per i cambi core (grace period, `refreshVideoMetadata`). Verifica visiva nel browser a carico dell'utente (server utente su :3001).

### Backlog aggiornato

Aggiunti: titolo scheda browser dinamico; anteprima video sulla card/player (da ragionare); foto profilo del creator più grande.
