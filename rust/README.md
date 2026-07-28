# rust/ — `ondo-core` e `ondo-cli`

Porting in Rust del core e del CLI. Progetto complessivo, contratto FFI e strategia
di migrazione: [`../docs/rust-core.md`](../docs/rust-core.md). Milestone: `../docs/PIANO.md`.

**Branch `rust-core`.** Il ramo `main` resta l'implementazione JavaScript funzionante:
questo lavoro non la sostituisce e non la modifica.

## Prerequisiti

Toolchain Rust stabile (MSVC su Windows):

```bash
rustup default stable
```

## Comandi

Dalla radice del progetto:

```bash
npm run rust:build       # compila in release
npm run rust:test        # test unitari (39)
npm run rust:difftest    # banco differenziale JS ↔ Rust su una fixture
npm run cli:rust         # avvia il menu a frecce in Rust
```

Oppure direttamente con cargo, da `rust/`:

```bash
cargo test
cargo run -p ondo-cli
cargo run -p ondo-core --example dump    # dump JSON usato dal banco differenziale
```

## Stato del porting

| Modulo JS | Rust | Stato |
|---|---|---|
| `catalog/catalogSchema.js` | `schema.rs` | ✅ portato |
| `catalog/catalogStore.js` | `store.rs` | ✅ portato |
| `config.js` + `preflight.js` | `config.rs` | ✅ portato |
| `services/searchService.js` | `search.rs` | ✅ portato |
| `services/videoService.js` + assi hidden/favorite | `query.rs` | ✅ portato |
| `services/libraryService.js` | `library.rs` | ⚠️ solo nomi/percorsi e risoluzione file |
| `ytdlp/ytdlpWrapper.js` | — | ❌ non portato |
| `jobs/jobManager.js` + `jobs/jobs/*` | — | ❌ non portato |
| `services/{sync,source,single,metadata,channelAvatar,backup}Service.js` | — | ❌ non portato |
| `lib/zip.js` | — | ❌ non portato |

**Conseguenza pratica:** il CLI in Rust oggi **legge** il catalogo (sfoglia, cerca,
raggruppa per creator, riproduce con VLC) e muta i soli assi `hidden`/`favorite`.
**Non scarica video** e non tocca `jobs.json` — per quello serve ancora il CLI in
Node (`npm run cli`). I due possono convivere: leggono e scrivono lo stesso
`data/catalog.json` nello stesso formato, ed è esattamente ciò che il banco
differenziale verifica.

## Il banco differenziale

È l'attrezzo che rende sicura la migrazione: esegue le stesse operazioni sullo
stesso `data/catalog.json` con entrambe le implementazioni e **diffa** i risultati.
Distingue un bug di porting da un cambio voluto, cosa che nessun test unitario può
fare.

```bash
npm run rust:difftest
```

Copre: ordine e flag derivati di `listVideos`, filtri per asse, raggruppamento per
canale, l'ordine dei risultati di 8 query (quindi implicitamente i punteggi di
ricerca), `sanitizeName` sui casi limite, e i percorsi canonici — più la verifica
che `catalog.json` resti **byte-identico** dopo il passaggio di entrambi.

La fixture include deliberatamente i casi che hanno storia nel progetto: emoji e
accenti nei titoli e nei nomi dei creator, caratteri invalidi per Windows, nomi
riservati (`CON`), titoli da 400 caratteri, video senza titolo, assi ortogonali che
coesistono (rimosso *e* scaricato), e due entry nel formato legacy da migrare.

Il banco è stato validato **al negativo**: alterando `MAX_TITLE_LEN` da 150 a 149
segnala la differenza su un solo carattere di un solo percorso.

## Scelte di progetto da conoscere prima di modificare

- **`Video` avvolge una mappa JSON, non è una struct tipizzata.** Garantisce che i
  campi non modellati sopravvivano e che l'ordine delle chiavi non cambi — la
  Regola 2 della migrazione. Vedi il commento in testa a `schema.rs`.
- **La ricerca lavora su UTF-16.** JavaScript misura `length` e taglia `slice()` in
  unità UTF-16; per ottenere gli *stessi* punteggi su titoli con emoji serve la
  stessa unità di misura. Vedi `search.rs`.
- **Niente cache del catalogo per processo.** Il JS tiene il catalogo in memoria e
  non lo rilegge: è la causa del "riavvia il processo" documentato in
  `documentazione.md` e di una perdita di stato reale (83 video, `storico.md`).
  Qui si rilegge sotto lock. Vedi `store.rs`.
- **La radice del progetto si cerca, non si assume.** Un binario non può usare il
  trucco di `__dirname` del JS. Ordine: `ONDO_ROOT` → risalita dalla directory
  corrente → risalita dall'eseguibile. Vedi `config.rs`.
- **`ondo-core` non ha dipendenze di interfaccia.** `dialoguer`/`console` stanno solo
  in `ondo-cli`, come `@inquirer/prompts` sta solo in `packages/cli`.
