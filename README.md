# YouTube Catalog (Ondo) — core, CLI e web app

Archivio personale e locale dei video YouTube dei tuoi creator preferiti: li scarica per non perderli, li cataloga e li rende sfogliabili e riproducibili — da un menu a terminale o dal browser.

Strumento **locale, single-user**. Un solo linguaggio (Node.js), nessun Python.

Due modi di usarlo, che condividono lo stesso archivio:

| | Come si installa |
|---|---|
| **Web app** (browser) | Docker, un comando — [guida qui sotto](#installare-la-web-app-sul-tuo-pc-con-docker) |
| **CLI** (comandi + menu a frecce) | Node.js, un comando — [guida](#la-cli-da-terminale-senza-clonare-il-repo) |

---

## Installare la web app sul tuo PC con Docker

Guida completa e autonoma: **non serve leggere il resto di questo README**, non serve clonare il repo, non serve installare Node.js, e non serve procurarsi yt-dlp o ffmpeg — sono già dentro l'immagine.

### Cosa ti serve

Solo **Docker Desktop**: <https://www.docker.com/products/docker-desktop/> (Windows, macOS, Linux). Installalo, avvialo, e aspetta che l'icona nella barra dica che è in esecuzione.

### 1. Prepara la cartella

Scegli dove tenere archivio e video — per esempio `C:\Catalog` — e crea dentro un file di testo chiamato **`docker-compose.yml`**, con questo contenuto:

```yaml
services:
  web:
    image: ghcr.io/helmutsti/youtubecatalog-web:latest
    container_name: youtubecatalog-web
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - D:\MiaLibreria:/library
      - ./config:/config
```

Sostituisci `D:\MiaLibreria` con la cartella dove vuoi tenere l'archivio: può essere su qualunque disco, e **non deve stare dentro questa cartella**. Il motivo è pratico: questa cartella (compose più impostazioni) la rifai in un minuto, la libreria contiene tutti i tuoi video.

Nessuna delle due cartelle va creata a mano: nascono al primo avvio.

### 2. Avvia

Apri il terminale **dentro quella cartella** (su Windows: click destro nella cartella → «Apri nel terminale») e dai:

```bash
docker compose up -d
```

La prima volta scarica l'immagine — qualche centinaio di MB, una volta sola. Gli avvii successivi sono immediati.

### 3. Apri la web app

<http://localhost:3001>

È tutto. Aggiungi un canale da **Sorgenti**, oppure incolla il link di un video per scaricarlo subito.

### Dove finiscono i tuoi file

Dentro la cartella che hai scelto al passo 1:

```
library/            ← il tuo archivio: copialo e hai copiato tutto
  videos/             i video, in una sottocartella per creator
  thumbnails/         le copertine
  avatars/            le foto profilo dei canali
  data/
    libreria.json     il catalogo
    conf.json         dove sono i video (l'unico percorso che contiene)
    metadata.json, jobs.json …
config/
  web.json          ← impostazioni dell'applicazione (qualità, parallelismo, porta)
```

Per il backup basta copiare `library/`: è autoportante. (Dalla web app, **Impostazioni → Backup**, scarichi anche un archivio del solo stato, senza i video.)

### Le operazioni di tutti i giorni

Tutti da dare nella cartella del `docker-compose.yml`:

| Cosa vuoi fare | Comando |
|---|---|
| Vedere se sta girando | `docker compose ps` |
| Leggere i log dal vivo | `docker compose logs -f` |
| Fermarla / riavviarla | `docker compose stop` / `docker compose start` |
| **Aggiornarla** | `docker compose pull` e poi `docker compose up -d` |
| Disinstallarla | `docker compose down` (i tuoi file restano: sono in `data/` e `videos/`) |

L'aggiornamento non tocca i tuoi dati, e ti porta anche una versione recente di yt-dlp: vale la pena farlo ogni tanto, perché YouTube cambia spesso e un yt-dlp vecchio prima o poi smette di scaricare.

### Personalizzazioni comuni

**La porta 3001 è già occupata.** Cambia solo il numero a **sinistra**: con `- "8080:3001"` la web app risponde su <http://localhost:8080>. Quello a destra è interno al container, lascialo com'è.

**Tenere l'archivio su un altro disco.** Cambia solo la parte a **sinistra** del primo volume:

```yaml
      - D:\MiaLibreria:/library
```

Su Docker Desktop il disco deve essere fra quelli condivisi (Settings → Resources → File sharing). Se è un disco esterno, tienilo collegato: quando il percorso non esiste, l'app non parte.

**Solo i video su un altro disco** (l'archivio resta dov'è, i file pesanti no): aggiungi un mount e poi indica quel percorso in `library/data/conf.json`, che esiste esattamente per questo:

```yaml
      - D:\Video:/videos
```
```json
{ "videosRoot": "/videos" }
```

**Video privati o non listati.** Esporta i cookie di YouTube in formato Netscape (per esempio con l'estensione «Get cookies.txt LOCALLY») e caricali dalla web app in **Impostazioni → Cookie**. Vanno ricaricati dopo un aggiornamento dell'immagine.

### Se qualcosa non va

| Sintomo | Da guardare |
|---|---|
| La pagina non si apre | `docker compose ps` deve dire `running`. Se no, `docker compose logs` spiega perché. |
| I download falliscono tutti | Quasi sempre è yt-dlp da aggiornare: `docker compose pull` e `docker compose up -d`. Per vedere quale versione hai: `docker exec youtubecatalog-web yt-dlp --version` |
| L'app parte ma non trova i video già scaricati | Controlla che il percorso a sinistra di `:/library` sia quello giusto e che il disco sia collegato. |

### In alternativa: costruire l'immagine dai sorgenti

Se preferisci compilarla tu invece di scaricarla già fatta, clona il repo, apri il suo `docker-compose.yml` e **togli il commento alle tre righe della sezione `build:`** (senza quelle non c'è nulla da compilare). Poi, dalla cartella del repo:

```bash
docker compose up -d --build
```

Ricordati di mettere il percorso della tua libreria nel volume `/library`. La build scarica yt-dlp e ffmpeg da sé: non serve `npm run setup`.

---

## Installazione

Da qui in avanti si parla dell'installazione **dai sorgenti**, quella che serve per la CLI e per lo sviluppo. Se ti interessa solo la web app nel browser, la guida Docker qui sopra è tutto quello che ti serve.

Serve **Node.js 20 o superiore** (<https://nodejs.org>, include `npm`). Nient'altro: yt-dlp e ffmpeg se li procura il progetto.

Dalla cartella del progetto, tre comandi:

```bash
npm install      # dipendenze (solo @inquirer/prompts: il core non ne ha nessuna)
npm run setup    # scarica yt-dlp + ffmpeg + ffprobe in tools/ (per il tuo sistema)
npm run cli      # apre il menu a terminale (= ondo menu)
```

La cartella del repo è già una libreria dopo un `npm run ondo -- init` (o lo è già, se l'hai usata prima): vedi «La libreria è la cartella in cui ti trovi» qui sotto.

> **Aggiornare yt-dlp.** YouTube cambia spesso e un yt-dlp vecchio smette di scaricare. Se i download iniziano a fallire, esegui `npm run setup -- --force`: riscarica l'ultima versione.

> **Se hai già ffmpeg installato** nel sistema, `npm run setup` se ne accorge e non lo riscarica.

---

## La CLI da terminale (senza clonare il repo)

Dalle [Release](https://github.com/Helmutsti/YouTubeCatalog/releases) viene pubblicato un pacchetto standalone con **tutta** la CLI: i sotto-comandi *e* il menu a frecce. Serve solo **Node.js 20 o superiore**.

```bash
npm install -g https://github.com/Helmutsti/YouTubeCatalog/releases/download/<tag>/ondo-cli-<tag>.tgz
ondo setup   # scarica yt-dlp + ffmpeg + ffprobe (per il tuo sistema)
```

(sostituisci `<tag>` con la versione che vuoi, es. `v1.0.0`)

### La libreria è la cartella in cui ti trovi

`ondo` lavora sulla libreria della cartella corrente — come `git` col repository. Se lì non c'è una libreria, si ferma e te lo dice: non ne crea una per sbaglio.

```bash
cd D:\MiaLibreria
ondo init          # solo la prima volta: crea la libreria qui
ondo menu          # l'interfaccia a frecce su QUESTA libreria
ondo video list    # i sotto-comandi, sempre su questa libreria
```

Le librerie possono essere quante ne vuoi: sono cartelle, ci si va con `cd`. Nessun elenco da gestire, nessuna libreria «predefinita» che potrebbe sorprenderti. Due sole scorciatoie, per gli script:

| | |
|---|---|
| `ondo --library D:\Altra video list` | lavora su un'altra libreria senza spostarti |
| `ONDO_LIBRARY=/percorso` | la stessa cosa, da variabile d'ambiente |

Attenzione a una conseguenza voluta: **non si risale**. Dentro `D:\MiaLibreria\videos` non sei nella libreria, sei in una sua sottocartella, e `ondo` si ferma dicendoti quale cartella ha guardato.

I binari (yt-dlp, ffmpeg) appartengono all'**installazione**, non alla libreria: `ondo setup` si fa una volta e vale per tutte le librerie.

```bash
ondo               # apre il menu
ondo --help
```

Per disinstallarlo:

```bash
npm uninstall -g @catalog/ondo-cli
```

---

## Uso

```bash
npm run cli
```

Tutto navigabile con le **frecce**, nessun comando da digitare. Quattro voci:

| Voce | Cosa fa |
|---|---|
| **Cerca** | Ricerca esatta su titolo, autore, tag e descrizione; dai risultati si agisce sul video. |
| **Libreria** | Tutti i video, per autore, preferiti, da scaricare, archiviati, rimossi da YouTube, falliti. Su un video: riproduci (VLC), solo audio, preferito, archivia, togli dalla libreria. |
| **Download rapido** | Incolli uno o più link e guardi le barre di avanzamento dal vivo. Esc torna al menu **senza fermare i download**. |
| **Impostazioni** | Stato e percorsi (cartelle, binari, runtime JS, VLC), qualità predefinita, quanti download in parallelo. |

I download continuano mentre navighi. Uscire con download attivi te lo chiede prima.

**Tasti**: le frecce per muoverti, Invio per scegliere, **`Esc` per tornare indietro** (da qualsiasi elenco, senza scorrere fino a «← indietro»), **`Ctrl-C` per uscire** dal programma.

---

## Configurazione

Ci sono **due** file di configurazione, con due ruoli distinti. La regola per sapere dove sta una cosa è una sola: *la libreria descrive l'archivio, l'applicazione descrive come lo si usa su questo computer.*

### 1. La libreria — `<libreria>/data/conf.json`

La libreria è una cartella qualsiasi, dove vuoi nel sistema, fatta così:

```
<libreria>/
  videos/                 i file video (o altrove: vedi conf.json)
  thumbnails/             le copertine
  avatars/                le foto profilo dei canali
  data/
    libreria.json         il catalogo
    conf.json             le impostazioni della libreria
    metadata.json         i metadati grezzi di yt-dlp
    jobs.json             lo storico dei download
```

E `conf.json` ha un campo, uno solo:

| Campo | A cosa serve |
|---|---|
| `videosRoot` | Cartella dei **file video**. `null` = la cartella `videos/` dentro la libreria, il caso *autoportante*: copi la cartella e hai copiato tutto. Altrimenti un percorso **assoluto**, per tenere i file pesanti su un disco dedicato: `"D:\\YouTube\\Video"`. |

È l'unica cosa che la libreria non può dedurre da sé, e per questo l'unica che si porta dietro. Nei percorsi Windows dentro il JSON serve la **doppia** backslash.

### 2. L'applicazione — un file per programma

`ondo.json` per la CLI, `web.json` per la web app, nella cartella **`config/` dentro l'installazione** — accanto al codice e a `tools/` con i binari, perché sono roba dell'applicazione: duplicare un'installazione ne duplica anche le impostazioni.

Nel caso Docker il codice sta nell'immagine, quindi l'installazione sull'host è la cartella col `docker-compose.yml`, e il `config/` che monti su `/config` è il suo.

| Variabile | A cosa serve |
|---|---|
| `ONDO_CONFIG_DIR` | Sposta la cartella delle impostazioni. Usata dall'immagine (`/config`), e utile quando la cartella d'installazione non è scrivibile: in quel caso, da sé, il programma ricade sulla cartella utente e lo dice. |
| `ONDO_LIBRARY` | Impone la libreria su cui lavorare, invece di prenderla dalla cartella corrente. Usata dall'immagine (`/library`), dove **è obbligatoria**: la cartella di lavoro del container è `/app`, che non è una libreria. |

| Campo | A cosa serve |
|---|---|
| `quality` | Qualità predefinita: `"best"`, `"ask"` (chiede a ogni download) o `{ "height": 1080 }`. |
| `jobs.parallel` | Quanti download insieme (default `1`). Si può cambiare a caldo. |
| `ytdlp.format` / `mergeOutputFormat` / `maxHeight` | Come scaricare: selettore dei flussi, contenitore d'uscita, tetto di risoluzione. |
| `vlcPath` | `null` = VLC si cerca da sé. Un percorso lo impone, se lo tieni in un posto non standard. |
| `port` | Porta dell'API/web app (default `3001`). Solo `web.json`. |

Quasi tutto si cambia dal menu **Impostazioni** (o dalla pagina Impostazioni della web app), senza aprire i file.

> **Perché divisi.** Qualità, parallelismo e percorsi di programmi sono scelte di chi usa il computer, non proprietà dell'archivio: tenerle nella libreria la rendeva intrasportabile — copiata su un altro PC o montata in un container si portava dietro la porta di quel container e un percorso di VLC che lì non esisteva. Ora la libreria contiene solo ciò che è suo, e si sposta senza portarsi dietro niente di estraneo.

> **I percorsi dei binari non si configurano affatto: si trovano.** yt-dlp e ffmpeg si cercano nella cartella `tools/` dell'installazione e poi nel PATH di sistema; il file dei cookie sta sempre in `core/cookies.txt`. Nota che `tools/` segue l'**installazione**, non la libreria: i binari sono del computer, e una libreria su un disco esterno non deve pretendere di avere yt-dlp accanto ai video.

> **Se il disco di `videosRoot` non è collegato, l'app non parte** (`ENOENT ... mkdir`). È un difetto noto, registrato in [`docs/PIANO.md`](docs/PIANO.md) → "Bug noti". Ripiego: ricollega il disco, o rimetti `videosRoot` a `null`.

---

## Video privati o non listati (facoltativo)

Se ti servono video privati o non listati del tuo account, yt-dlp deve autenticarsi:

1. Esporta i cookie di YouTube in **formato Netscape** (es. con l'estensione "Get cookies.txt LOCALLY").
2. Salva il file come `core/cookies.txt`.

Se il file non c'è, tutto funziona lo stesso. Non viene mai versionato.

---

## Altro

| | |
|---|---|
| Come funziona e perché (stato attuale) | [`docs/documentazione.md`](docs/documentazione.md) |
| Regole di progetto e architettura | [`docs/progetto.md`](docs/progetto.md) |
| Cosa manca da fare | [`docs/PIANO.md`](docs/PIANO.md) |
| Storia completa, milestone per milestone | [`docs/storico.md`](docs/storico.md) |
| Progetto del core in Rust (ABI C) — su carta, abbandonato | [`docs/rust-core.md`](docs/rust-core.md) |

> **Piattaforme.** Nato e usato su **Windows**. `npm run setup` e il codice scelgono i binari giusti anche su **Linux** e **macOS**, ma il supporto lì non è ancora verificato end-to-end.
