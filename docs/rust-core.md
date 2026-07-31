# rust-core.md — progetto di `ondo-core` in Rust (libreria + ABI C)

> **Stato: progetto su carta. Nessun codice scritto.** Documento di design richiesto
> dall'utente prima di iniziare. Le milestone operative che ne derivano (M67-M73) sono
> elencate in `PIANO.md`, che rimanda qui per il dettaglio.
>
> Da leggere **dopo** la voce "Riscrittura del core in C/C++/Rust" negli **Scartati** di
> `PIANO.md`: quella registra il rifiuto della riscrittura **per motivi di prestazioni**,
> misurato in M66 e tuttora valido. Questo documento risponde a un movente **diverso** —
> la compatibilità — che quel benchmark non tocca. Le due cose non sono in contraddizione:
> non si riscrive per andare più veloce (non serve), si riscrive per essere richiamabili
> da altro e per smettere di dipendere da Node.

---

## 1. Obiettivi (scelti dall'utente)

Tre, selezionati insieme:

1. **Richiamabile da altri linguaggi/client** — poter scrivere domani un client .NET, mobile,
   Python o altro sopra la stessa logica. Oggi impossibile: la logica è chiusa in moduli ESM.
2. **Girare su più piattaforme/hardware** — NAS ARM, macchine senza Node, sistemi minimali.
3. **Indipendenza da Node come runtime** per il cuore del progetto.

**Perché insieme funzionano, e separatamente no.** L'obiettivo 2 da solo sarebbe un
peggioramento: oggi `git clone && npm install` basta ovunque, mentre un `cdylib` impone
build precompilate per ogni tripla e una pipeline CI che le pubblichi. Ma unito al 3, il
conto torna: se il cuore non richiede più il runtime Node, l'immagine Docker per il NAS
passa da `node:22-bookworm-slim` + `npm ci` a un binario statico su base minima, e le build
multi-target smettono di essere un costo puro. **L'obiettivo 2 è quindi giustificato solo
se si arriva fino al 3** (M72). Se il programma si fermasse prima, avremmo pagato il costo
senza incassare il beneficio — vedi §9.

**Obiettivo esplicitamente NON perseguito**: la performance. M66 ha misurato che alla scala
reale non c'è alcun collo di bottiglia in JavaScript. L'unico guadagno prestazionale atteso
è un effetto collaterale gratuito: il porting della ricerca fuzzy risolve da sé il degrado a
grande scala annotato in "Forse".

---

## 2. Il vincolo che limita tutto: yt-dlp resta esterno

`ytdlpWrapper.js` è 731 righe (il 24% del core) che **lanciano un binario esterno e ne
leggono lo stdout**. yt-dlp è Python impacchettato con PyInstaller; ffmpeg è un eseguibile a
sé. Nessuna riscrittura in Rust li elimina.

**Conseguenza da accettare consapevolmente:** `ondo-core` non sarà mai un artefatto unico
autosufficiente. Sarà *sempre* una libreria + due eseguibili esterni procurati da
`npm run setup` (M64) o equivalente. L'indipendenza da Node è raggiungibile; l'indipendenza
da processi esterni no.

Ridimensiona la promessa ma non la annulla: il vantaggio resta reale, perché oggi le
dipendenze esterne sono **tre** (Node + yt-dlp + ffmpeg) e diventerebbero due, e soprattutto
perché l'orchestrazione di quei processi diventa richiamabile da qualunque linguaggio.

---

## 3. Architettura di arrivo

```
                      ┌─────────────────────────────────────┐
                      │  ondo-core  (crate Rust, logica)    │
                      │  schema · store · search · library  │
                      │  config · backup · ytdlp · jobs     │
                      └──────────────┬──────────────────────┘
                                     │
        ┌────────────────┬───────────┴───────────┬──────────────────┐
        │                │                       │                  │
   ondo-ffi         ondo-node               ondo-server        (futuri)
   cdylib, ABI C    napi-rs                 binario HTTP       binding diretti
   2 simboli        addon .node             Axum/Hyper         C# · Python · Swift
        │                │                       │
        │        packages/cli (invariato)   sostituisce packages/server
        │        packages/server (transizione)   → niente Node a runtime
        │
   C · C++ · C# · Python · Java · Go · Swift · Kotlin
                                     │
                                     ▼
                    packages/web — client HTTP puro, MAI toccato
```

**La proprietà che rende fattibile tutta la migrazione**: `packages/web` parla col server
**solo via REST** e non ha mai importato `core` (invariante del progetto fin dall'inizio).
Quindi il contratto `/api/...` è uno **strato isolante**: qualunque cosa succeda sotto —
core JS, core Rust via napi, o server Rust nativo — la web app non cambia di una riga. Vale
lo stesso per un futuro client Electron, per cui la decisione architetturale era già presa.

---

## 4. Che cosa si porta, e che cosa no

Inventario delle 3.031 righe di `core/src`, classificate per portabilità reale.

### Da portare in Rust

| Modulo JS | righe | Modulo Rust | Note |
|---|---:|---|---|
| `catalog/catalogSchema.js` | 195 | `schema` | **Il vero valore del progetto**: flag ortogonali, `videoCategory()`, migrazioni. Logica pura. |
| `services/searchService.js` | 109 | `search` | Pura. Il porting risolve anche il degrado a scala (M66). |
| `services/videoService.js` | 60 | `query` | Filtri puri. |
| `services/libraryService.js` | 289 | `library` | Layout dei path + spostamenti su disco. ⚠️ Unicode, vedi §8. |
| `catalog/catalogStore.js` | 87 | `store` | Mutex + scrittura atomica. **Punto di massimo rischio di drift.** |
| `catalog/metadataStore.js` | 75 | `store` | Stesso pattern. |
| `config.js` | 245 | `config` | Include `expectedToolNames()` (M64). |
| `lib/zip.js` + `services/backupService.js` | 324 | `backup` | Lo zip è già scritto a mano: si **porta**, non si sostituisce con un crate (§5). |
| `ytdlp/ytdlpWrapper.js` | 731 | `ytdlp` | Il blocco più grosso. Spawn + parsing stdout: portabile ma laborioso. |
| `jobs/jobManager.js` + `jobs/jobs/*` | ~450 | `jobs` | Coda single-worker. **API a polling, non a callback** (§6). |
| `services/*` restanti (source, sync, decision, single, metadata, avatar) | ~400 | `services` | Costruiti sopra i precedenti. |

### Da lasciare all'host (adapter, non core)

| Cosa | Perché |
|---|---|
| Bridge SSE (`jobs.routes.js`) | È un adapter di trasporto: il suo posto è nel server, qualunque linguaggio abbia. |
| Route Express, `publicVideo.js`, `asyncRoute.js` | Idem: forma HTTP del contratto, non dominio. |
| `packages/cli/cli.js` (menu `@inquirer/prompts`) | Resta Node e resta in-process, via napi-rs. Nessun motivo di toccarlo. |
| `packages/web` | Client HTTP puro. Mai toccato. |

---

## 5. La questione delle dipendenze — decisione richiesta

Il progetto ha un'invariante esplicita: **«`core` non deve avere dipendenze esterne»**. È
stata presa con motivazioni concrete (rifiutata `fuzzysort`, rifiutati `yt-dlp-wrap` e
sqlite) e ha prodotto codice scritto a mano tuttora funzionante: la ricerca fuzzy e il
lettore/scrittore ZIP.

**Proposta: mantenere lo spirito, non la lettera.** Quell'invariante nasce dal rischio di
supply chain di npm — centinaia di transitive per un pacchetto banale. L'ecosistema Cargo
ha un profilo diverso e, soprattutto, `serde`/`serde_json` sono di fatto infrastruttura
standard: riscriverli a mano sarebbe un errore, non una virtù.

Allowlist proposta, deliberatamente minima:

| Crate | Perché indispensabile |
|---|---|
| `serde` + `serde_json` | Serializzazione. È l'intero contratto FFI e il formato del catalogo. |
| `sha2` | sha256 dei video. (In JS era `createHash`, cioè OpenSSL: non è "una dipendenza in più".) |
| `napi` / `napi-derive` | Solo nel crate `ondo-node`, non in `ondo-core`. |
| server HTTP (`axum` o simile) | Solo nel crate `ondo-server` (M72), non in `ondo-core`. |

**Deliberatamente NON aggiunti:**

- **`tokio` o qualunque runtime async.** La coda job è **single-worker FIFO**: un
  `std::thread` più un channel bastano. Evitarlo elimina l'attrito fra async e FFI, riduce
  il binario e i tempi di build. Decisione importante, non un dettaglio.
- **Un crate `zip`.** `lib/zip.js` è già scritto, testato e sufficiente al bisogno: si porta
  quel codice. Coerente con la scelta storica.
- **Un crate di ricerca fuzzy.** Stessa ragione per cui fu rifiutata `fuzzysort`.

> ⚠️ **Questa è una modifica a un'invariante originale del progetto e va confermata
> esplicitamente** prima di iniziare. Se preferisci l'invariante alla lettera (zero
> dipendenze anche in Rust), è fattibile ma costa un parser JSON scritto a mano: dillo e
> lo mettiamo nel piano.

---

## 6. Il contratto FFI

### Due soli simboli

```c
char* ondo_call(const char* request_json);
void  ondo_free(char* ptr);
```

**Perché due e non una funzione per servizio.** La superficie pubblica ha ~40 funzioni. Una
funzione esportata ciascuna significa 40 binding × N linguaggi, ognuna con la sua firma,
i suoi tipi e i suoi bug. Con JSON-in/JSON-out ogni linguaggio deve solo saper passare una
stringa e liberare un puntatore — cose che sanno fare tutti. È anche lo stesso contratto che
`core/src/index.js` ha già di fatto: funzioni che prendono e restituiscono oggetti.

Costo accettato: si perde il controllo di tipo a compile-time attraverso il confine, e ogni
chiamata paga una serializzazione. Irrilevante qui — le chiamate sono poche e i payload
piccoli (l'unica eccezione, `listVideos` sull'intero catalogo, resta nell'ordine dei
millisecondi misurati in M66).

### Forma dei messaggi

```jsonc
// richiesta
{ "op": "searchVideos", "params": { "query": "asmr", "limit": 20 } }

// risposta, successo
{ "ok": true, "data": [ /* ... */ ] }

// risposta, errore  (mai un panic attraverso il confine)
{ "ok": false, "error": "Video non trovato: abc123", "kind": "not_found" }
```

Regole non negoziabili del confine:

- **Mai un panic attraverso FFI**: ogni `ondo_call` è avvolta in `catch_unwind`; un panic
  diventa `{"ok":false,"kind":"internal"}`. Un unwind oltre il confine è undefined behaviour.
- **Sempre UTF-8**, sempre `NUL`-terminato; il chiamante **deve** chiamare `ondo_free`.
- **`kind`** è un codice stabile e machine-readable; `error` è il messaggio in italiano già
  usato oggi. Serve perché i client non debbano fare parsing di stringhe localizzate.
- L'inizializzazione (percorso del progetto, config) è un'`op` come le altre
  (`{"op":"init"}`), non un terzo simbolo.

### I job: polling, non callback

```jsonc
{ "op": "jobs.trigger", "params": { "type": "downloadSingle", "videoId": "..." } }
// → { "ok": true, "data": { "jobId": "..." } }

{ "op": "jobs.poll", "params": { "jobId": "...", "sinceSeq": 42 } }
// → { "ok": true, "data": { "status": "running", "progress": 0.37,
//                            "logs": ["..."], "nextSeq": 57 } }
```

**Perché non le callback.** Richiamare l'host da un thread Rust significa affrontare il GIL
in Python, `AttachCurrentThread` in JNI, il vincolo del thread-loop in Node — moltiplicato
per ogni linguaggio da supportare. È la singola scelta che rende o rompe la portabilità
multi-linguaggio. Il polling è banale ovunque.

**Non si perde nulla di ciò che esiste oggi**: `jobManager` è già una coda single-worker, e
l'adapter Node può ricostruire l'`EventEmitter` (e quindi il bridge SSE, e quindi
`useJobStream` lato web) facendo polling internamente. Il numero di sequenza `sinceSeq`
garantisce che nessuna riga di log si perda fra due poll — proprietà che l'`EventEmitter`
attuale, essendo fire-and-forget, non ha.

---

## 7. Strategia di migrazione: strangolamento + test differenziale

Hai **66 milestone di comportamento funzionante** e un catalogo reale di 274 video / 94GB.
Una riscrittura in blocco è il modo sicuro di perdere entrambi.

### Le due regole

**Regola 1 — un solo proprietario per volta.** Ogni modulo è implementato in JS **oppure**
in Rust, mai in entrambi come codice vivo. Si commuta atomicamente, modulo per modulo. Il
rischio numero uno di questo progetto non è scrivere Rust: è avere due implementazioni della
logica di stato che divergono in silenzio, con `catalog.json` di mezzo.

**Regola 2 — il formato su disco non cambia durante la migrazione.** `catalog.json`,
`metadata.json`, `jobs.json` restano identici byte per byte nella semantica. Eventuali
evoluzioni dello schema si fanno **prima** o **dopo**, mai durante: altrimenti un bug di
porting è indistinguibile da un cambio voluto.

### L'attrezzo: il runner differenziale

Prima di qualunque porting si costruisce un banco che, data la **stessa** richiesta e lo
**stesso** `catalog.json`, esegue l'implementazione JS e quella Rust e **diffa il JSON di
uscita**. Corpus:

- il catalogo **reale** dell'utente (274 video: titoli veri, emoji, accenti, canali con
  caratteri non-ASCII — è il corpus che conta);
- i cataloghi **sintetici** già generati per M66 (274 / 2.000 / 10.000), per la scala;
- casi limite: catalogo vuoto, video senza titolo, `sources: []`, `presence: removed`.

Per i moduli con stato il confronto non è sull'output ma sul **file dopo la scrittura**, più
la verifica che l'atomicità regga (interruzione simulata a metà).

Un modulo si considera portato solo quando il diff è vuoto su tutto il corpus.

---

## 8. Rischi, con il rimedio

| Rischio | Perché è concreto qui | Rimedio |
|---|---|---|
| **Unicode e path** | ⚠️ Il rischio più sottovalutato. Il layout è `<Creator>/<Titolo> [<id>].<ext>` con **spazi, accenti ed emoji reali** nei nomi; Windows usa UTF-16, Rust usa `OsString`, JS usa stringhe UTF-16 con surrogati. Anche `sanitizeName()` deve produrre **esattamente** gli stessi nomi, o i file esistenti diventano irraggiungibili. | Test differenziale sui nomi reali dei 274 video **prima** di portare `library`; confronto sui byte del path, non sulla stringa renderizzata. |
| **Drift fra le due implementazioni** | Il rischio numero uno (§7). | Regola 1 + runner differenziale. |
| **Scrittura atomica** | `rename()` è atomico su NTFS e POSIX ma con dettagli diversi (destinazione esistente, handle aperti su Windows). Oggi funziona ed è dato per scontato. | Test dedicato per piattaforma, non solo su Windows. |
| **glibc vecchia sui NAS** | Un binario compilato su Ubuntu recente non parte su un QNAP con glibc datata. E musl non è un'alternativa: `yt-dlp_linux` è PyInstaller/glibc, come già documentato per il Dockerfile. | Build contro una glibc vecchia (container tipo manylinux, o `cargo-zigbuild`), verificata sul NAS reale. |
| **Rottura di `git clone && npm install`** | Se le build multi-target non ci sono dal primo giorno, l'invariante "auto-portante" salta subito. | La CI è dentro **M67**, non rimandata a dopo. Nessun porting comincia prima. |
| **Programma abbandonato a metà** | Il caso peggiore: costo pagato, beneficio zero, e due linguaggi da mantenere. | Vedi §9: ogni milestone deve lasciare il progetto in uno stato spedibile. |

---

## 9. Il punto di non ritorno, dichiarato in anticipo

Il piano ha un punto in cui **fermarsi diventa la scelta peggiore di entrambe**: dopo aver
introdotto Rust ma prima di M72, il progetto ha due linguaggi, la CI multi-target da
mantenere, e ancora bisogno di Node a runtime — cioè tutti i costi e nessuno dei tre
obiettivi pienamente raggiunto.

Due conseguenze operative:

- **Ogni milestone chiude in uno stato spedibile**: l'app funziona, la web non cambia, il
  CLI non cambia. Nessuna milestone lascia il progetto rotto.
- **M67 è deliberatamente uno spike verticale sottile** (solo `searchVideos`): serve a
  scoprire *presto e a basso costo* se ABI, CI, binding e distribuzione funzionano davvero
  su questa macchina e sul NAS. Se lì emerge un ostacolo, si abbandona avendo speso una
  milestone e non sei.

**Stima onesta dello sforzo**: 3.031 righe di logica da riportare, più ABI, binding, CI
multi-target e un banco di test differenziale. È un programma di lavoro paragonabile a una
frazione consistente di tutto ciò che il progetto ha accumulato finora — non una milestone
grande. Vale la pena solo se gli obiettivi 1/2/4 sono desideri reali e duraturi, non
curiosità del momento.

---

## 10. Le milestone (dettaglio in `PIANO.md`)

| # | Cosa | Perché in quest'ordine | Stato spedibile a fine milestone |
|---|---|---|---|
| **M67** | **Fondamenta + spike verticale.** Workspace Cargo (`ondo-core`/`ondo-ffi`/`ondo-node`), i 2 simboli ABI, binding napi-rs, CI multi-target con pubblicazione per tripla, runner differenziale. Unico modulo portato: `searchVideos`. | Valida *tutta* l'infrastruttura su un modulo puro, senza stato, isolato — e su cui un errore non può corrompere dati. | La ricerca gira in Rust da CLI e server; risultati identici al JS sul catalogo reale; `npm install` continua a funzionare. |
| **M68** | **`schema` + `query`**: flag ortogonali, `videoCategory()`, migrazioni, filtri. | Il cuore concettuale, ancora logica pura (nessuna scrittura su disco): massimo valore, rischio ancora contenuto. | Le derivazioni di stato vengono da Rust; badge e filtri identici nella web. |
| **M69** | **`store` + `config`**: lettura/scrittura atomica, mutex, reconciliation all'avvio. | ⚠️ Il passaggio critico: da qui Rust **possiede** il catalogo su disco. Fatto solo dopo che il differenziale è rodato. | Il catalogo è letto e scritto da Rust; backup di sicurezza prima del passaggio. |
| **M70** | **`library` + `backup`**: layout path, riorganizzazione, zip. | Prima dei job perché è dove vive il rischio Unicode (§8) e va isolato. | Riorganizzazione e backup/ripristino da Rust, verificati sui file veri. |
| **M71** | **`ytdlp` + `jobs`**: spawn, parsing progresso, coda single-worker, API a polling; l'adapter Node ricostruisce l'`EventEmitter` per l'SSE. | Il blocco più grosso, affrontato quando tutto il resto sotto è già solido. | I download girano attraverso Rust; SSE e barra di avanzamento invariati nella web. |
| **M72** | **`ondo-server`: binario HTTP standalone.** Stesso contratto `/api` + `/media` + web statica. Immagine Docker senza Node. | **Qui si incassano gli obiettivi 2 e 4.** | Il NAS gira senza runtime Node; la web app non se ne accorge. |
| **M73** | **Ritiro del core JS** e binding di riferimento per un secondo linguaggio (es. C# o Python), a prova dell'obiettivo 1. | Chiude la Regola 1 in via definitiva: un solo proprietario della logica. | Una sola implementazione. Il CLI Node resta, via napi-rs. |

---

## 11. Cosa non cambia, mai

Da rileggere ogni volta che si è tentati di allargare lo scope:

- **`packages/web`** — client HTTP puro, non tocca il core né oggi né mai.
- **Il contratto REST `/api/...`** — è lo strato isolante che rende possibile tutto il resto.
- **Il formato di `catalog.json`** — durante la migrazione (§7, Regola 2).
- **L'UX del CLI** — menu a frecce, in-process, funzionante senza server acceso.
- **Il modello di stato a flag ortogonali** — si porta, non si ridisegna.
