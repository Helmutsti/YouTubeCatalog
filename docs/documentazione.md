# documentazione.md — stato attuale del progetto (Ondo · catalogo YouTube locale)

> **Cos'è questo file.** Il **presente** del progetto in forma sintetica e viva: com'è fatto e *perché*, pensato per essere riletto a distanza di tempo (o da un'altra macchina) senza scorrere tutta la storia. Contiene il **core**, le **decisioni correnti** ancora valide, i **funzionamenti controintuitivi** da ricordare, e le **decisioni "negative"** (cose deliberatamente non fatte, col perché).
>
> **Non è un log storico.** Si aggiorna e si sfoltisce per riflettere lo stato corrente. La cronologia integrale di tutte le milestone e decisioni prese vive in **`storico.md`** (append-only). Le regole/architettura di dettaglio vivono in **`progetto.md`**; il futuro (milestone/backlog/bug) in **`PIANO.md`**.

---

## Core del progetto

Tool personale, locale, single-user (Windows) per **preservare i video dei propri creator YouTube** (che a volte spariscono): li scarica, li cataloga e li rende sfogliabili/riproducibili. Stack **Node.js**, un solo linguaggio.

**Architettura a strati (invariante fondamentale):**
- **`/core`** = libreria di funzioni pure ("mini API"), nessuna dipendenza da HTTP. È il cuore: tutta la logica di dominio vive qui.
- **`packages/cli`** = consuma `core` **in-process** (import diretto). È l'unico che importa `core`.
- **`packages/server`** = thin wrapper Express attorno a `core` (espone le stesse funzioni via `/api`).
- **`packages/web`** = SPA React, **client HTTP puro del server** (non tocca mai `core`).
- Dati in `data/`: `catalog.json` (verità curata), `metadata.json` (grezzo yt-dlp), `config.json` (locale, non versionato), `jobs.json` (storico job). Video in `media/` (o in `videosRoot` configurabile).
- Download via `tools/yt-dlp.exe` + merge `tools/ffmpeg.exe`; riproduzione via VLC (solo CLI).

**Principio ribadito:** ogni nuova funzionalità si costruisce **principalmente nel `core`**; CLI/server/web restano adapter sottili che chiamano le stesse funzioni, senza duplicare regole.

## Decisioni correnti chiave

- **Modello di stato a flag ortogonali** (non più un `status` lineare): `presence` (`present`/`removed`) · `download` (`none`/`downloading`/`downloaded`/`failed`) · `hidden` (bool) · `favorite` (bool). La categoria a una dimensione per badge/viste è **derivata** in `videoCategory()` (nel core), mai reimplementata negli adapter.
- **Le fonti sono etichette, non proprietà.** `video.sources` è un **array** di `{sourceId, name}` (zero/una/più). Un video esiste a sé (come un download singolo); una playlist è un'etichetta che porta, non un vincolo di appartenenza. `sources: []` è lo stato normale, non un orfano.
- **Scelta della risoluzione a ogni download** (M56): il download **non è più sempre al massimo**; prima di ogni download di singolo video l'utente sceglie la risoluzione (radio button web / `select` CLI) tra quelle realmente disponibili. La più alta = "(massima)" → `maxHeight` `null` (nessun cap); le altre cappano. Il download in blocco resta al massimo.
- **Coda di riproduzione effimera** (M52), non playlist persistenti: vive solo client-side (`queueStore`, sessionStorage), mai in `catalog.json`.
- **Due soli tipi di card** (M53): `VideoCard` con `layout='grid'|'row'`, entrambe adattive allo stato e col menu ⋮ — mai una card scritta a parte (causò un bug in passato).
- **Backup/ripristino** in `.zip` (catalogo+metadati+job, non i video); **cartelle media/video** riposizionabili da Impostazioni; **cookie** YouTube caricabili da Impostazioni.

## Funzionamenti controintuitivi (da ricordare!)

Questi sono i punti che a distanza di tempo trarrebbero in inganno:

- **Il catalogo è tenuto in memoria da ogni processo** e non ricaricato da disco. Se uno script esterno modifica `catalog.json` **o cambia il codice `core`** mentre un server/CLI gira, **quel processo va riavviato**, altrimenti la sua cache sovrascrive le modifiche o gira con codice vecchio. (Per pulizie a mano sul catalogo: farle **a server spento**.)
- **Client YouTube (`player_client=default,android_vr,web_embedded`).** Non è ridondanza: YouTube mette dei video dietro un "PO-token" e i client normali (web/tv/ios) falliscono con 403; `android_vr` bypassa ma a volte espone **solo 360p**; **`web_embedded`** è quello che sblocca i formati DASH pieni (1080p+audio) su quei video gated (verificato: senza di lui l'utente "vedeva solo 360p"). Tutti supplementari, non sostitutivi.
- **Esclusione AV1** (`vcodec!*=av01`) nel selettore: workaround per un 403 sistematico di YouTube sull'AV1. Nessun compromesso di qualità (stessa risoluzione in VP9). L'ultimo fallback `/b` non applica il filtro (per i siti non-YouTube).
- **`--js-runtimes node`** obbligatorio: senza un runtime JS, yt-dlp fallisce i download recenti con 403 a metà.
- **Primo tentativo di download SENZA cookie**, poi retry con cookie: i cookie + client mobile insieme vengono trattati come sospetti dalla CDN (403). I cookie servono solo per video privati/non listati del proprio account.
- **`--download-archive` va ripulito prima di ri-scaricare** (`removeFromDownloadArchive`, chiamato in `downloadVideo`): una riga residua fa **saltare** il download a yt-dlp (esce ok senza scrivere l'info.json) → il video finirebbe `failed` pur avendo un file. Per ri-scaricare un video già scaricato: confirm "Elimina e ri-scarica" (→ `deleteVideoFile`, che pulisce file+archivio+reset).
- **Il mux video+audio (Opzione B / `merged`) è una rete di sicurezza dormiente.** Serviva quando l'estrazione dava video HD senza audio-only separato (yt-dlp non sa fondere video-only + audio di un combinato con un solo `-f`). Con `web_embedded` gli audio-only ricompaiono, quindi `needsAudioChoice` quasi non scatta più e il ramo mux/dialog A/B resta inerte — ma copre i casi limite residui.
- **`qualityNote`** ("segnala soltanto"): un download ≤360p viene marcato con una nota di qualità ridotta (badge nel dettaglio), senza far fallire — su YouTube il 360p è quasi sempre un ripiego.
- **Percorsi relativi a `mediaRoot`**: `video.localPath` segue il layout **`<Creator>/<Titolo> [<id>].<ext>`** (id sempre nel nome → nessuna collisione di titoli); le thumbnail restano piatte `<id>.jpg`. `metadata.json` è separato dal catalogo e **senza `automatic_captions`** (gonfierebbe tutto).
- **Limite dell'automazione browser**: in queste sessioni il browser automatizzato **non raggiunge `localhost`** → la verifica visiva della UI la fa l'utente via HMR, dichiarandolo. (Il server/logica core si verificano via `curl`/`node`.)
- **VLC** su questa macchina è nel path a **32 bit** (`Program Files (x86)`), non a 64 bit — non assumere il default.
- **Un solo `<video>`, sopra il router (M54).** Il player non vive più dentro `VideoDetailPage` (che React smonta al cambio route) ma in `components/MiniPlayer.jsx`, montato in `Layout` fuori dall'`<Outlet/>`: sopravvive alla navigazione. Il nodo del `<video>` non viene mai ricreato — è **spostato con `appendChild`** (via un nodo stabile + `createPortal`) tra lo slot della pagina (`#player-dock-slot`) e il riquadro flottante, così la riproduzione non si taglia. Chi deve agire sull'elemento (speed/PiP in `VideoDetailPage`) lo prende da `playerStore.getVideoEl()`, non da un ref locale.
- **Mini-player: `floating` deve diventare vero SINCRONO al cambio pagina.** Se dipendesse da uno stato impostato in un effetto dopo il commit, per un frame il player si smonterebbe e il video ripartirebbe da capo. Perciò `floating` usa `playing` (già nello store, sincrono); `detached` lo mantiene in pausa, `minimized` è il "minimizza" manuale (forza il flottante **restando sulla pagina**, senza navigare). Preferenza on/off in `localStorage` (`ondo:miniPlayerEnabled`, default ON); **desktop-only** (gate `isDesktopViewport()` + `@media`).
- **PiP ≠ mini-player**: il Picture-in-Picture nativo resta una feature a sé (finestra di sistema); il mini-player persistente è il riquadro in-page di Ondo. Sono indipendenti.
- **Avanzamento coda: un solo percorso (M57).** Il passaggio al video successivo — sia automatico a fine video (`MiniPlayer.onEnded`) sia manuale (pulsante "Successivo", presente sia nei comandi del player sia nell'header del box "In coda") — passa dallo stesso hook `hooks/useQueueAdvance.js`: se il player è agganciato alla pagina si naviga al successivo, se sta suonando nel riquadro flottante lo si carica **senza cambiare pagina**. Nessun "Precedente" (coda FIFO consumata, niente storico).

## Decisioni "negative" (deliberatamente NON implementato)

- **Modalità "Solo audio"**: implementata e poi **rimossa** — puramente presentazionale (non riduce banda/spazio) e non ottenibile coi comandi nativi come voleva l'utente.
- **Client desktop Electron**: decisioni architetturali fissate (client HTTP puro, cache locale client-side), ma **non implementato**; restano da definire endpoint offline/cache/packaging.
- **Sottotitoli**: **scartati** — servirebbero gli automatici (157 lingue/video), troppo per il beneficio; i manuali sono quasi sempre assenti.
- **Provider "canale" (monitoraggio interi canali)**: **scartato per ora** — non esiste ancora un vero seam di provider; oggi c'è solo `playlistProvider` hardcoded.
- **Multi-risoluzione / transcodifica (HLS/DASH)**: **scartata** — pensata per client eterogenei su banda pubblica, fuori scope per un tool single-user; 2-3× lo spazio disco.
- **Manipolazione playlist su YouTube / OAuth**: fuori scope (solo lettura/download).

---

*Per il dettaglio storico di ogni milestone, scoperta e bug risolto: **`storico.md`**. Per il lavoro futuro: **`PIANO.md`**. Per regole/architettura: **`progetto.md`**.*
