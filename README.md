# YouTube Catalog (Ondo)

Archivio personale e locale dei video YouTube dei tuoi creator preferiti: scarica i video per non perderli, li cataloga in un file JSON e li rende sfogliabili/riproducibili tramite una web GUI o un CLI a menu.

Strumento **locale, single-user** (pensato per Windows). Un unico linguaggio (Node.js), nessun Python.

---

## 1. Prerequisiti

Prima di installare, procurati:

1. **Node.js 20 o superiore** — <https://nodejs.org> (include `npm`). Verifica: `node --version`.
2. **`yt-dlp.exe`** — il motore di download. Scaricalo dalle release ufficiali di yt-dlp e mettilo in `tools/yt-dlp.exe` (vedi passo 3).
3. **ffmpeg** — richiesto da yt-dlp per unire video+audio alla massima qualità (e per convertire le copertine). Due modi, a scelta:
   - **Senza toccare il sistema** *(consigliato)*: metti `ffmpeg.exe` e `ffprobe.exe` in `tools/` (accanto a `yt-dlp.exe`). L'app li rileva da sola e li passa a yt-dlp (`--ffmpeg-location`) — niente da installare.
   - **Oppure** installa ffmpeg e mettilo nel **PATH** di sistema (verifica: `ffmpeg -version`).
4. **VLC** *(facoltativo)* — serve solo per la riproduzione tramite VLC (menu "Guarda" del CLI). La web GUI usa il player del browser e non ne ha bisogno.

---

## 2. Installazione (passo per passo)

**Passo 1 — Ottieni il progetto e installa le dipendenze**

Dalla cartella del progetto:

```bash
npm install
```

Installa in un colpo solo le dipendenze di tutti i pacchetti (core, server, CLI, web) grazie agli npm workspaces.

**Passo 2 — Metti `yt-dlp.exe` al suo posto**

Crea la cartella `tools/` (se non c'è) e copiaci dentro il binario:

```
tools/yt-dlp.exe
```

**Passo 3 — Crea il file di configurazione**

Copia il file di esempio e rinominalo:

```
data/config.example.json   ->   data/config.json
```

> Se salti questo passo, `data/config.json` viene comunque creato in automatico con i valori di default al primo avvio. Copiare l'esempio serve solo se vuoi personalizzarlo subito.

Apri `data/config.json` e regola se necessario:

| Campo | A cosa serve |
|-------|--------------|
| `mediaRoot` | Cartella di copertine e avatar (default `./media`, dentro il progetto). |
| `videosRoot` | Cartella dei **file video** (default `null` = `mediaRoot/videos`). Impostalo a un percorso assoluto per tenere i video su un altro disco, es. `"D:\\YouTube\\Video"`. |
| `port` | Porta del server API (default `3001`). |
| `playback.vlcPath` | Percorso di `vlc.exe` (solo per la riproduzione via VLC). |
| `ytdlp.cookiesFile` | Lascia `null` per usare `core/cookies.txt` se presente (vedi sotto). |

> Attenzione: nei percorsi Windows dentro il JSON usa la doppia backslash, es. `"D:\\YouTube\\Video"`.

Le cartelle di `media/` e i file dati in `data/` vengono creati automaticamente al primo avvio: non devi crearli a mano.

**File che scrivi tu, e dove:**

| File | Obbligatorio? | Dove |
|------|---------------|------|
| `tools/yt-dlp.exe` | Sì | binario yt-dlp |
| `tools/ffmpeg.exe` + `tools/ffprobe.exe` | Facoltativo | ffmpeg dentro il progetto invece che nel PATH (vedi Prerequisiti) |
| `data/config.json` | Consigliato (altrimenti auto-creato) | copia da `data/config.example.json` |
| `core/cookies.txt` | Facoltativo | vedi sezione Cookie |

---

## 3. Cookie per video privati / non listati (facoltativo)

Se la tua playlist "da scaricare" contiene video **privati o non listati** del tuo account, yt-dlp deve autenticarsi coi cookie della tua sessione YouTube.

1. Nel browser esporta i cookie di YouTube in **formato Netscape** (es. con l'estensione "Get cookies.txt LOCALLY").
2. Salva il file esportato come:

```
core/cookies.txt
```

Fatto: quando il file è presente viene passato automaticamente a ogni chiamata di yt-dlp. Se il file non c'è, tutto funziona lo stesso (semplicemente niente autenticazione). Il file **non** viene versionato (è in `.gitignore`).

> In alternativa puoi indicare un percorso diverso in `data/config.json` → `ytdlp.cookiesFile`.

---

## 4. Backup e ripristino del catalogo

Il backup crea un **archivio `.zip`** con i file dati del catalogo — **`catalog.json` + `metadata.json` + `jobs.json`**. **NON** include i file video (che restano dove sono) né `config.json`/`cookies.txt` (specifici della macchina).

**Come si fa:**

- **Dalla web GUI** → pagina **Impostazioni**:
  - **Scarica backup .zip** — scarica l'archivio.
  - **Ripristina da file…** — carica un `.zip` di backup.
- **Dal CLI** → menu **Backup / Ripristino** → *Salva backup su file…* / *Ripristina da file…* (indichi un percorso su disco).

**Cosa succede al ripristino:** i file dati attuali vengono prima **copiati in una cartella di sicurezza** (`data/pre-restore-<data-ora>/`), poi sostituiti con quelli dell'archivio. Nulla viene cancellato.

> ⚠️ Dopo un ripristino **riavvia il server** (e/o il CLI): lo stato è tenuto in memoria e caricato all'avvio, quindi le modifiche hanno effetto solo dopo il riavvio.

---

## 5. Come avviare e usare GUI + API e CLI

Ci sono due interfacce, entrambe costruite sulle stesse funzioni di `core`. Usa quella che preferisci.

### Web GUI + API

Servono **due processi** (in due terminali):

```bash
npm run server      # API su http://localhost:3001
npm run web         # Web GUI su http://localhost:5173
```

Poi apri **<http://localhost:5173>** nel browser. La GUI parla con l'API sulla porta `3001` (in sviluppo Vite fa da proxy).

- L'**API** è il server su `:3001` (rotte sotto `/api/...`, media sotto `/media/...`): la usa la GUI, ma è interrogabile anche direttamente (es. `curl http://localhost:3001/api/videos`).

### Uso in rete locale (LAN)

Due modalità, a seconda che tu voglia o no che l'API sia raggiungibile direttamente da altri dispositivi. `cli`, `server` (API) e `web` (GUI) restano comunque tre cartelle indipendenti che non si parlano mai tra loro a livello di codice — CLI e API importano entrambe (separatamente) solo `@catalog/core`, la GUI parla con l'API solo via HTTP.

**Modalità A — "gui+proxy api" (consigliata): l'API non è mai esposta in rete**

```bash
npm run server:local   # API legata SOLO a 127.0.0.1 — irraggiungibile da altri dispositivi
npm run web:lan         # GUI raggiungibile in LAN
```

La GUI resta pienamente funzionante: il proxy di sviluppo di Vite gira sulla stessa macchina del server e raggiunge comunque `127.0.0.1:3001` da lì. Nessun dispositivo remoto tocca mai l'API — solo la porta `5173` è esposta. Verificato dal vivo: `curl http://<ip-lan>:3001/api/videos` fallisce (connessione rifiutata), `curl http://<ip-lan>:5173/api/videos` funziona (passa dal proxy).

**Modalità B — "api+gui": entrambe esposte, comunicazione diretta (niente proxy)**

```bash
npm run server          # API su tutte le interfacce, raggiungibile in LAN
npm run web:lan
```

Serve anche impostare, in `packages/web/.env.local` (già presente nel progetto, con la riga commentata di default — decommentala e correggi l'IP):

```
VITE_API_BASE_URL=http://<ip-lan-del-pc-col-server>:3001
```

Con questa variabile impostata la GUI parla con l'API **direttamente** con l'IP indicato, senza passare dal proxy di Vite — utile, ad esempio, in vista di un futuro client separato (Electron) che deve raggiungere l'API senza un dev server in mezzo. Richiede **riavviare** `web:lan` dopo aver modificato `.env.local` (Vite legge le variabili solo all'avvio).

> **Usa sempre l'IP, non il nome del PC** (in entrambe le modalità, per raggiungere la GUI). Un indirizzo tipo `http://nome-pc:5173` spesso **non** si raggiunge da altri dispositivi (telefoni, smart TV, altri PC) perché la risoluzione del nome macchina Windows (NetBIOS) non è affidabile su tutta la rete — non è un problema di firewall, è proprio il nome che non si risolve in un IP. Caso reale verificato: `http://pc-sala:5173` irraggiungibile, `http://192.168.5.44:5173` (stessa macchina) funzionante da subito. Se anche l'IP diretto non si raggiunge, allora sì il sospetto si sposta sul **firewall di Windows** (verifica una regola inbound "Allow" per Node.js sul profilo di rete attivo, `Get-NetFirewallRule -Direction Inbound | Where DisplayName -match node`) o su un eventuale isolamento tra dispositivi della rete Wi-Fi (comune sulle reti "ospiti").

### CLI

Un solo comando, menu navigabile con le **frecce** (nessun comando da digitare):

```bash
npm run cli
```

Da qui puoi gestire le fonti (playlist), sincronizzare, rivedere le novità, scaricare, cercare, guardare (con VLC), fare backup/ripristino e impostazioni. Il CLI **non** richiede che il server sia avviato.

> Nota: se modifichi i dati con uno strumento mentre un altro processo (server o CLI) è già in esecuzione, **riavvia** quel processo — ognuno tiene il catalogo in memoria e lo ricarica solo all'avvio.
