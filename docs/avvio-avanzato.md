# Avvio avanzato — modalità di sviluppo e uso in rete locale

> Materiale spostato qui dal `README.md` (M65), che è stato ridotto all'essenziale.
> Per installare e partire bastano i tre comandi descritti nel README; questa pagina
> serve solo per **sviluppare** sulla web app o per **raggiungerla da altri dispositivi**.

---

## Modello di esecuzione: un solo server

Il modo canonico è **un unico processo**: `packages/server` espone l'API (`/api`), i
media (`/media`) **e** la web app compilata, sullo stesso host e porta.

```bash
npm run serve       # = npm run build && npm start
```

`npm run build` compila la web in `packages/web/dist`; `npm start` avvia il server,
che la serve same-origin. L'API resta interrogabile direttamente
(`curl http://localhost:3001/api/videos`). Dopo aver modificato il codice della web,
rilancia `npm run build` (o `npm run serve`) per aggiornare la build servita.

Le cartelle del repo (`core/`, `packages/server/`, `packages/web/`, `packages/cli/`)
restano **distinte**: cambia il modo di eseguire, non l'architettura a strati.

---

## Sviluppo con hot-reload (due processi)

Per lavorare sulla web con ricarica automatica servono **due terminali**:

```bash
npm run server      # API su http://localhost:3001
npm run web         # Vite dev server su http://localhost:5173 (proxy di /api e /media)
```

Apri <http://localhost:5173>. La web usa path relativi, quindi lo stesso codice
funziona sia qui (proxy di Vite) sia in produzione (same-origin), senza modifiche.

---

## Uso in rete locale (LAN)

**In produzione è immediato:** avvia `npm run serve` e apri da un altro dispositivo
`http://<IP-della-macchina>:3001`. Un solo processo serve web app + API e l'ascolto è
già su tutte le interfacce. È la modalità consigliata per l'uso in casa (ed è ciò che
fa anche il container Docker). Le due modalità qui sotto riguardano solo lo **sviluppo**
a due processi.

### Modalità A — "gui+proxy api" (consigliata): l'API non è mai esposta in rete

```bash
npm run server:local   # API legata SOLO a 127.0.0.1 — irraggiungibile da altri dispositivi
npm run web:lan        # GUI raggiungibile in LAN
```

La GUI resta pienamente funzionante: il proxy di sviluppo di Vite gira sulla stessa
macchina del server e raggiunge comunque `127.0.0.1:3001` da lì. Nessun dispositivo
remoto tocca mai l'API — solo la porta `5173` è esposta. Verificato dal vivo:
`curl http://<ip-lan>:3001/api/videos` fallisce (connessione rifiutata),
`curl http://<ip-lan>:5173/api/videos` funziona (passa dal proxy).

### Modalità B — "api+gui": entrambe esposte, comunicazione diretta

```bash
npm run server          # API su tutte le interfacce, raggiungibile in LAN
npm run web:lan
```

Serve anche impostare, in `packages/web/.env.local` (il file `.env.example` accanto
mostra la riga da copiare e decommentare):

```
VITE_API_BASE_URL=http://<ip-lan-del-pc-col-server>:3001
```

Con questa variabile la GUI parla con l'API **direttamente**, senza passare dal proxy
di Vite — utile in vista di un futuro client separato (Electron) che deve raggiungere
l'API senza un dev server in mezzo. Richiede **riavviare** `web:lan` dopo la modifica
(Vite legge le variabili solo all'avvio).

---

## ⚠ Usa sempre l'IP, non il nome del PC

Per raggiungere la GUI da un altro dispositivo, in **entrambe** le modalità. Un
indirizzo tipo `http://nome-pc:5173` spesso **non** si raggiunge da telefoni, smart TV
o altri PC, perché la risoluzione del nome macchina Windows (NetBIOS) non è affidabile
su tutta la rete — non è un problema di firewall, è proprio il nome che non si risolve
in un IP.

Caso reale verificato: `http://pc-sala:5173` irraggiungibile, `http://192.168.5.44:5173`
(stessa macchina) funzionante da subito.

Se anche l'**IP diretto** non si raggiunge, allora il sospetto si sposta sul **firewall
di Windows** — verifica una regola inbound "Allow" per Node.js sul profilo di rete attivo:

```powershell
Get-NetFirewallRule -Direction Inbound | Where DisplayName -match node
```

…oppure su un eventuale **isolamento tra dispositivi** della rete Wi-Fi (comune sulle
reti "ospiti").

---

## Nota sulla concorrenza

Se modifichi i dati con uno strumento mentre un altro processo (server o CLI) è già in
esecuzione, **riavvia** quel processo: ognuno tiene il catalogo in memoria e lo ricarica
solo all'avvio. Vale anche dopo un ripristino da backup e dopo aver cambiato il codice
di `core`.
