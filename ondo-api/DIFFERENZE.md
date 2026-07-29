# Differenze rispetto all'API Express

L'API originale (`packages/server` sul branch `main`, Express, 35 endpoint in 6 file)
è stata **riscritta**, non portata: buona parte descriveva un modello di dati che
questo branch non ha più. Questo documento tiene il conto di cosa è cambiato, così
chi conosce la vecchia API sa dove guardare e cosa non cercare.

Regola generale: se un endpoint non c'è, è perché **la libreria non ha la funzione**
sotto — non perché non si è avuto tempo di scriverlo. L'API non inventa logica.

## Endpoint

Legenda: **=** stesso lavoro · **≈** stesso lavoro, forma diversa · **✗** non
portato.

| Express (`main`) | `ondo-api` | |
|---|---|---|
| `GET /api/videos` | `GET /api/videos?filter=…` | = |
| `GET /api/videos/available` | `GET /api/videos?filter=pending` | ≈ significato diverso, vedi «categorie» |
| `GET /api/videos/:id` | `GET /api/videos/{id}` | = |
| `GET /api/videos/:id/metadata` | `GET /api/videos/{id}/metadata` | = |
| `POST /api/videos/:id/favorite` | `POST /api/videos/{id}/favorite` | = corpo `{"value":bool}` |
| `POST /api/videos/:id/hidden` | `POST /api/videos/{id}/archived` | ≈ rinominato: nel core il flag è `archived` |
| `POST /api/videos/:id/download` | `POST /api/videos/{id}/download?maxHeight=` | ≈ la qualità è per-download |
| `POST /api/videos/download-single` | `POST /api/queue` | ≈ un link nuovo è un link in coda |
| `DELETE /api/videos/:id` | `DELETE /api/videos/{id}?deleteFiles=` | ≈ un endpoint invece di due |
| `DELETE /api/videos/:id/file` | — | ✗ il core cancella entry+file insieme, non solo il file |
| `GET /api/search` | `GET /api/search?q=` | = |
| `GET /api/channels` | `GET /api/authors` | ≈ rinominato: il core parla di **autori**, non di canali (un video può venire da un sito qualunque) |
| `GET /api/channels/:key/videos` | `GET /api/authors/{name}/videos` | ≈ la chiave è il nome dell'autore |
| `POST /api/videos/analyze-download` | — | ✗ analisi dei formati prima di scaricare: il core non la espone |
| `POST /api/videos/:id/metadata/refresh` | — | ✗ facile da aggiungere (sono i passi 1-2 del sentinel), non c'è ancora |
| `POST /api/channels/avatars/sync` | — | ✗ gli avatar degli autori non esistono nel core |
| `GET/POST/DELETE /api/sources`, `POST /api/sync` | — | ✗ **il concetto di fonte non esiste**: il core scarica link singoli, non playlist da sincronizzare |
| `GET /api/jobs` | `GET /api/jobs` | ≈ è lo stato dei job **di questa sessione**, non uno storico su disco |
| `GET /api/jobs/:id` | — | ✗ `GET /api/jobs` restituisce tutto: l'elenco è corto per costruzione |
| `POST /api/jobs` | `POST /api/queue` | ≈ non esiste un "tipo" di job da scegliere: c'è il download |
| `DELETE /api/jobs`, `DELETE /api/jobs/:id` | — | ✗ niente storico da cancellare |
| `POST /api/jobs/:id/cancel` | — | ✗ il pool oggi annulla **tutto**, non un job singolo (servirebbe `Downloader::cancel(job)`) |
| `GET /api/jobs/:id/stream` (SSE) | `GET /api/events` (SSE) | ≈ **un solo** flusso per tutti i job, non uno per job |
| `POST /api/library/reorganize` | — | ✗ il layout è canonico per costruzione; non c'è una funzione che ri-allinei file spostati a mano |
| `GET /api/backup`, `POST /api/backup/restore` | — | ✗ lo zip scritto a mano non è stato riportato |
| `GET /api/config` | `GET /api/config` | ≈ forma nuova (qualità a tre facce, stato dei binari) |
| `POST /api/config/cookies`, `/media-root`, `/videos-root` | `PATCH /api/config` | ≈ un endpoint per tutte le impostazioni |
| `/media/videos/*`, `/media/thumbnails/*` | `/media/videos/*`, `/media/covers/*` | ≈ `thumbnails` → `covers` |
| `/media/avatars/*` | — | ✗ non ci sono avatar |

Nuovi, senza corrispondente su `main`:

| | |
|---|---|
| `GET /api/stats` | i conteggi per ogni vista, per i chip della home, in una chiamata |
| `GET /api/queue` · `DELETE /api/queue` | i link incollati ma non ancora risolti (prima non esistevano: senza id non erano rappresentabili) |

## Differenze di schema

**Lo stato.** L'API originale esponeva `presence` / `download` / `hidden` (flag
ortogonali, M25) più una `category` derivata. Qui il record ha `state`
(`pending`/`downloading`/`downloaded`/`failed`) più i flag `favorite`, `archived`,
`removed`; la **`category` derivata resta**, con gli stessi sei valori, perché è
l'unica cosa che il frontend guarda.

Una categoria ha cambiato significato: **`available`** era «presente su YouTube e non
scaricato», e dipendeva dalle sincronizzazioni. Senza fonti nessuno verifica la
presenza, quindi qui `available` vuol dire semplicemente **da scaricare**.

`removed` esiste come campo e come filtro, ma **nessuno lo imposta**: come accorgersi
che un video è stato rimosso è una decisione rimandata.

**Precedenza della categoria**: `downloading` → `failed` → `removed` → `hidden` →
`downloaded` → `available`. Chi richiede attenzione adesso vince: un video in
download lo dice anche se è archiviato.

**I percorsi.** Nel record `file`, `cover` e `metadata` sono relativi **alla loro
cartella** (non alla radice), e l'API aggiunge `videoUrl` e `coverUrl` già codificati
segmento per segmento — i nomi canonici contengono spazi, accenti ed emoji.
`thumbnailUrl` c'è come **alias di compatibilità** di `coverUrl`, così il frontend non
cambia per un nome.

**Campi aggiunti** dall'API: `category`, `durationLabel`, `videoUrl`, `coverUrl`,
`thumbnailUrl`, `fileExists`.

## Differenze di comportamento

**Gli eventi.** Su `main` ogni job aveva il suo `GET /api/jobs/:id/stream`. Qui c'è
**un solo** `GET /api/events` con tutti gli eventi di tutti i download, ognuno
etichettato col numero del job: è lo stesso flusso che la console della CLI disegna.
Un client lento perde i messaggi più vecchi invece di rallentare il server.

**I job non sopravvivono al riavvio.** Non c'è `jobs.json`: lo stato dei job vive nel
pool, per la durata del processo. I *video* invece sono su disco come sempre — se un
download era in corso, alla riapertura torna «da scaricare».

**I video passano dall'API** (`/media/…`, dentro lo stesso processo), servita a
pacchetti: verificato che un file da 600 MB si trasferisce con la memoria del server
che passa da 8,0 a 9,4 MB, cioè non viene caricato. Le Range request funzionano
(`206` con `content-range`), le condizionali pure (`304` con `If-None-Match`).

Due differenze misurate rispetto a `express.static`:

- **multi-range** (`Range: bytes=0-9,20-29`): qui `416`, Express rispondeva `200` col
  file intero. Nessun browser lo usa per un `<video>`; certi gestori di download sì.
- **nessun `cache-control`**: ci sono `etag` e `last-modified`, quindi il browser fa
  una richiesta di verifica che finisce in `304`. Deliberato: un `max-age` farebbe
  servire un video **vecchio** dopo un riscaricamento che sostituisce il file allo
  stesso percorso, e su localhost un `304` non costa niente.

**Le cartelle sono fissate all'avvio**: si montano una volta, quindi cambiarle dalle
impostazioni richiede un riavvio del server. Era così anche con `express.static`.

**Un solo processo per libreria.** Ogni processo tiene `library.json` in memoria e lo
riscrive quando salva: server e CLI aperti insieme si sovrascrivono a vicenda. È una
regola, non un vincolo imposto dal codice.

## Cosa serve al core prima di poter riportare il resto

- **fonti + sync** → `SourcesPage` e i 4 endpoint `/sources`;
- **annullare un job** (`Downloader::cancel(job)`) → il pulsante di annullamento;
- **storico dei job su disco** → il pannello con la cronologia;
- **rilevazione dei rimossi** → il filtro «rimossi da YouTube», oggi sempre vuoto;
- **backup zip**, **reorganize**, **avatar degli autori** → le rispettive pagine.
