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

### Due cartelle, e vanno tenute separate

È l'unica cosa da capire prima di cominciare, e ti risparmia il pasticcio più comune:

```
C:\OndoWeb\                  ← L'INSTALLAZIONE. Usa e getta: la rifai in un minuto
  docker-compose.yml
  config\web.json               impostazioni: qualità, parallelismo, porta

D:\MiaLibreria\              ← LA LIBRERIA. Preziosa: ci sono i tuoi video
  videos\  thumbnails\  avatars\
  data\  →  libreria.json (il catalogo), conf.json, metadata.json, jobs.json
```

Perché separate: la libreria la apri anche dalla CLI, la copi per il backup, la sposti su un altro disco quando cresce. Metterla dentro la cartella del deploy significa mescolare la cosa che butti con quella che tieni.

### 1. Prepara l'installazione

Crea una cartella qualsiasi — per esempio `C:\OndoWeb` — e mettici dentro un file di testo chiamato **`docker-compose.yml`**:

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

Una riga sola da personalizzare: **`D:\MiaLibreria`**, che è dove vuoi tenere l'archivio. Può essere su qualunque disco; se non è `C:`, va prima condiviso in Docker Desktop (Settings → Resources → File sharing).

Le due cartelle (`config` qui, e la libreria) non devi crearle: nascono al primo avvio. Se la libreria è vuota o non esiste, viene inizializzata da sé.

> Se salvi con il Blocco note, nella finestra di salvataggio scegli «Tutti i file»: altrimenti ti ritrovi un `docker-compose.yml.txt` e Docker non lo trova.

### 2. Avvia

Apri il terminale **dentro la cartella dell'installazione** (click destro → «Apri nel terminale») e dai:

```bash
docker compose up -d
```

La prima volta scarica l'immagine — qualche centinaio di MB, una volta sola. Gli avvii successivi sono immediati.

### 3. Controlla e apri

```bash
docker compose logs
```

Devi leggere `@catalog/server in ascolto su http://localhost:3001`. Se la libreria era nuova, vedrai anche `Libreria inizializzata in /library` — ed è un buon modo di accorgersi subito se ha aperto la cartella sbagliata.

Poi: <http://localhost:3001>

Aggiungi un canale da **Sorgenti**, oppure incolla il link di un video per scaricarlo subito.

Per il backup basta copiare `library/`: è autoportante. (Dalla web app, **Impostazioni → Backup**, scarichi anche un archivio del solo stato, senza i video.)

### Le operazioni di tutti i giorni

Tutti da dare nella cartella del `docker-compose.yml`:

| Cosa vuoi fare | Comando |
|---|---|
| Vedere se sta girando | `docker compose ps` |
| Leggere i log dal vivo | `docker compose logs -f` |
| Fermarla / riavviarla | `docker compose stop` / `docker compose start` |
| **Aggiornarla** | `docker compose pull` e poi `docker compose up -d` |
| **Cambiare libreria** | modifica il percorso `/library` nel compose, poi `docker compose up -d` |
| Disinstallarla | `docker compose down` (la libreria resta dov'è: è una cartella tua) |

L'aggiornamento non tocca i tuoi dati, e ti porta anche una versione recente di yt-dlp: vale la pena farlo ogni tanto, perché YouTube cambia spesso e un yt-dlp vecchio prima o poi smette di scaricare.

Per lavorare su **due librerie insieme** basta un secondo servizio nello stesso compose, con nome, porta e `config` diversi:

```yaml
  archivio2019:
    image: ghcr.io/helmutsti/youtubecatalog-web:latest
    container_name: ondo-2019
    ports: ["3002:3001"]
    volumes:
      - D:\Archivio2019:/library
      - ./config-2019:/config
```

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

**Imporre una versione tua di yt-dlp**, senza aspettare un'immagine nuova: mettila in `config\tools\` (la cartella accanto al compose, già montata) col nome `yt-dlp_linux`. Ha la precedenza su quella dell'immagine. Deve essere il binario **Linux**: un `.exe` di Windows nel container non parte.

### Se qualcosa non va

| Sintomo | Da guardare |
|---|---|
| La pagina non si apre | `docker compose ps` deve dire `running`. Se no, `docker compose logs` spiega perché. |
| I download falliscono tutti | Quasi sempre è yt-dlp da aggiornare: `docker compose pull` e `docker compose up -d`. Per vedere quale versione hai: `docker exec youtubecatalog-web yt-dlp --version` |
| L'app parte ma il catalogo è vuoto | Sta guardando un'altra cartella. `docker compose logs` mostra su quale libreria ha aperto; controlla il percorso a sinistra di `:/library`. |
| «Libreria inizializzata» quando non te lo aspettavi | Il percorso `/library` puntava a una cartella vuota o inesistente: quasi sempre un disco esterno scollegato, o una lettera di unità sbagliata. |

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
npm run setup    # scarica yt-dlp + ffmpeg + ffprobe in config/tools/
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

### Dove finiscono impostazioni e binari

Non nella libreria: appartengono all'**installazione**, quindi `ondo setup` si fa una volta e vale per tutte le librerie. Stanno insieme, nella stessa cartella:

| Sistema | Cartella |
|---|---|
| Windows | `%APPDATA%\ondo\` → `ondo.json` + `tools\` |
| macOS | `~/Library/Application Support/ondo/` |
| Linux | `$XDG_CONFIG_HOME/ondo/` (o `~/.config/ondo/`) |

Con `npm install -g` finiscono lì e non dentro il pacchetto, perché npm riscrive la propria cartella a ogni aggiornamento: così aggiornare la CLI non ti fa perdere impostazioni né ti obbliga a riscaricare yt-dlp. `ONDO_CONFIG_DIR` sposta tutto, se preferisci decidere tu.

> **Attenzione ai percorsi in `ondo.json`.** È un file JSON, quindi le backslash vanno **raddoppiate**:
> ```json
> { "vlcPath": "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" }
> ```
> Con una sola backslash il file diventa illeggibile e ogni comando si ferma. In genere non serve nemmeno impostarlo: `null` significa «cercalo», e VLC viene trovato da sé nelle posizioni standard.

```bash
ondo               # apre il menu
ondo --help
```

Per disinstallarlo:

```bash
npm uninstall -g @catalog/ondo-cli
```

La cartella delle impostazioni resta: cancellala a mano se vuoi ripulire. Le librerie non vengono toccate.

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

`ondo.json` per la CLI, `web.json` per la web app, nella cartella **`config/` dell'installazione** — insieme a `config/tools/`, dove finiscono yt-dlp e ffmpeg. Impostazioni e binari stanno nello stesso posto perché sono la stessa categoria di cosa: «il programma su questa macchina». Duplicare un'installazione ne duplica entrambi.

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

> **I percorsi dei binari non si configurano affatto: si trovano.** yt-dlp e ffmpeg si cercano in `config/tools/` (accanto alle impostazioni) e poi nel PATH di sistema; il file dei cookie sta sempre in `core/cookies.txt`. Seguono l'**installazione**, non la libreria: dieci librerie condividono un solo yt-dlp, e una libreria su un disco esterno non deve pretendere di avere i binari accanto ai video.

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
