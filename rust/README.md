# rust/ — `ondo-core` e `ondo-cli`

Core e CLI in Rust. **Autonomi**: non richiedono l'API né il frontend, che sono
stati messi fuori scope. Progetto complessivo: [`../docs/rust-core.md`](../docs/rust-core.md).

**Branch `rust-core`.** Il ramo `main` resta l'implementazione JavaScript completa
(core + API + web GUI): questo lavoro non la sostituisce e non la modifica.

## Prerequisiti

- Toolchain Rust stabile (`rustup default stable`; su Windows serve il toolchain MSVC).
- `tools/yt-dlp*` + ffmpeg — li procura `npm run setup` dalla radice del progetto.
- **`node` nel PATH**: yt-dlp lo usa come runtime JavaScript (`--js-runtimes node`)
  per decifrare le firme dei formati. È l'unica dipendenza da Node che resta, e non
  è eliminabile finché il motore di download è yt-dlp.

## Comandi

Dalla radice del progetto:

```bash
npm run rust:build       # compila in release
npm run rust:test        # 60 test unitari
npm run rust:difftest    # banco differenziale JS ↔ Rust su una fixture
npm run cli:rust         # avvia il menu a frecce
```

Da `rust/`, direttamente:

```bash
cargo run -p ondo-cli
cargo run -p ondo-core --example dump              # dump JSON per il banco differenziale
cargo run -p ondo-core --example e2e_download      # prova reale del download, con pulizia
```

## Stato del porting

**~88% della logica JS coperta.** 5.808 righe di Rust (+936 di test) per ~3.050 delle
3.481 righe di `core/src`.

| JS | Rust | |
|---|---|---|
| `catalog/catalogSchema.js` | `schema.rs` | ✅ |
| `catalog/catalogStore.js` | `store.rs` | ✅ |
| `catalog/metadataStore.js` | `metadata.rs` | ✅ |
| `config.js` + `preflight.js` | `config.rs` | ✅ |
| `services/searchService.js` | `search.rs` | ✅ |
| `services/videoService.js` + `decisionService.js` | `query.rs` | ✅ |
| `services/libraryService.js` | `library.rs` | ✅ |
| `ytdlp/ytdlpWrapper.js` | `ytdlp.rs` | ✅ |
| `services/syncService.js` | `sync.rs` | ✅ **+ due bug corretti** |
| `services/sourceService.js` + `singleVideoService.js` | `sources.rs` | ✅ |
| `jobs/jobManager.js` + `jobs/jobs/*` | `tasks.rs` | ♻️ **sostituito**, non portato |
| `services/channelAvatarService.js` | `tasks.rs` | 🟡 risolve l'URL, non scarica il file |
| `services/metadataService.js` | `metadata.rs` | 🟡 manca `refreshVideoMetadata` |
| `services/backupService.js` + `lib/zip.js` | — | ❌ non portati |

### Cosa manca, concretamente

- **Backup e ripristino `.zip`** (~324 righe). L'unica funzionalità del CLI JS che
  qui non esiste. Nel frattempo: copiare a mano `data/*.json`.
- **Download del file avatar** dei creator: si risolve e si registra l'URL, ma
  l'immagine non viene salvata in locale. Serve un client HTTP fra le dipendenze
  (`ureq`) — non aggiunto per una funzione che un CLI non mostra.
- **`refreshVideoMetadata`** su un singolo video (l'arricchimento in blocco c'è).

## Le decisioni che il cambio di tecnologia ha reso possibili

Quattro punti in cui il porting **non** è una traduzione: è una versione migliore.

**1. La coda dei job è sparita** (`tasks.rs` al posto di `jobManager.js`).
`jobManager` esisteva per alimentare via SSE un pannello job nel browser: serviva
una coda in background, un `EventEmitter`, uno storico persistito e un
`AbortController`. Senza frontend, il CLI è l'unico consumatore ed è bloccante per
progetto — le operazioni girano in primo piano con una barra di avanzamento.
Guadagno oltre alle ~600 righe in meno: **nessun job può restare orfano**.
`reconcileOrphanJobs()` esisteva perché un processo morto lasciava job `running`
per sempre, né interrompibili né cancellabili; senza coda in background quello
stato non è nemmeno rappresentabile. Lo storico resta, scritto nello stesso
`data/jobs.json`.

**2. Lock di scrittura fra processi** (`lock.rs`, non esiste in JS). Il mutex JS
proteggeva solo *dentro* un processo: due processi che scrivevano insieme si
sovrascrivevano. È la radice dell'incidente reale del 2026-07-25 (83 video
azzerati). `documentazione.md` lo gestiva come **convenzione umana** («riavvia il
processo»); ora è una garanzia tecnica, con rilevamento dei lock abbandonati.

**3. Due bug noti corretti nel porting** invece di riportati (`sync.rs`) —
`PIANO.md` → "Bug noti" #1:
- **guardia sul disco**: se la cartella dei video è vuota o irraggiungibile, la
  sync **salta** l'auto-guarigione invece di declassare a `none` un'intera fonte.
  Il JS trattava "NAS scollegato" come "file cancellato";
- **riconciliazione inversa**: un video `none` il cui file **ricompare** su disco
  torna `downloaded` da sé. Nel JS l'operazione era a senso unico, ed è per questo
  che nel 2026-07-25 rimettere il disco non recuperò nulla.

**4. Niente cache del catalogo per processo** (`store.rs`): si rilegge sotto lock.
M66 aveva misurato che il parsing costa 1,4ms; il costo di sbagliare no.

## Scelte tecniche da conoscere prima di modificare

- **`Video` avvolge una mappa JSON, non è una struct tipizzata.** Garantisce che i
  campi non modellati sopravvivano e che l'ordine delle chiavi non cambi. Vedi il
  commento in testa a `schema.rs`.
- **La ricerca lavora su UTF-16.** JavaScript misura `length` e taglia `slice()` in
  unità UTF-16; per ottenere gli *stessi* punteggi su titoli con emoji serve la
  stessa unità di misura.
- **`ytdlp.rs` drena stderr in un thread dedicato.** Leggere stdout fino a EOF
  mentre stderr si riempie porta a un **deadlock** delle pipe — problema che in
  Node non esiste e in Rust va affrontato subito.
- **Niente `tokio`.** Le operazioni sono sequenziali e bloccanti: un runtime async
  non servirebbe a nulla e complicherebbe un eventuale confine FFI.
- **La radice del progetto si cerca, non si assume**: `ONDO_ROOT` → risalita dalla
  directory corrente → risalita dall'eseguibile. Il trucco di `__dirname` non
  funziona per un binario.
- **`ondo-core` non ha dipendenze di interfaccia**: `dialoguer`/`console` stanno
  solo in `ondo-cli`.
- **Interruzione = Ctrl-C.** Le operazioni sono in primo piano, quindi la console
  recapita il segnale a tutto il gruppo di processi, yt-dlp compreso. Chiude anche
  il CLI: semplice e prevedibile. Il catalogo non resta incoerente — un video
  interrotto risulta `downloading` e la reconciliation all'avvio lo riporta a `none`.

## Verifiche

- **60 test unitari** (`npm run rust:test`).
- **Banco differenziale JS ↔ Rust verde** (`npm run rust:difftest`): stesse
  operazioni sullo stesso catalogo, output diffati, più la verifica che
  `catalog.json` resti byte-identico dopo il passaggio di entrambi. Fixture con
  emoji e accenti, caratteri invalidi Windows, nomi riservati, titoli da 400
  caratteri, assi che coesistono, entry legacy da migrare. Validato **al negativo**:
  alterando `MAX_TITLE_LEN` da 150 a 149 segnala la differenza di un carattere.
- **End-to-end reale** (`examples/e2e_download.rs`): download vero di un video,
  con due flussi separati fusi da ffmpeg, verifica di sha256 contro la dimensione
  reale del file, consolidamento dei metadati grezzi, assenza di sidecar residui, e
  pulizia completa a fine prova.
- **Non verificato**: il menu a frecce richiede un TTY reale, che l'ambiente di
  automazione non fornisce. La prova visiva è a carico dell'utente.
