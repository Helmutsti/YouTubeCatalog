# CLAUDE.md

Ondo: archivio locale di video (yt-dlp). Una libreria e le sue interfacce, in
cartelle separate — **`ondo-core/`** è la libreria (che contiene anche il sentinel, su
un thread), **`cli/`** è l'interfaccia a menu, **`ondo-web/api/`** è il server HTTP e
**`ondo-web/fe/`** la web app React. Le dipendenze vanno in una direzione sola: le
interfacce chiamano `ondo-core`, mai il contrario.
L'architettura, il protocollo e le milestone stanno in **`ARCHITETTURA.md`**: leggilo
prima di lavorare, aggiornalo quando cambia il presente.

## Regole di lavoro

- **Fattibilità reale, non presunta**: leggi il codice vero, e per i dubbi su
  yt-dlp/ffmpeg fai uno spike sui binari e sui dati reali invece di indovinare.
- **Verifica end-to-end reale**: una cosa è "fatta" solo dopo averla vista girare
  (`cargo build` + un download vero), non dopo che compila.
- **Pulizia dei dati di prova**: ogni verifica su file reali si chiude riportando
  tutto come prima.
- **Commit e push solo su richiesta esplicita.** I messaggi spiegano il *perché*.
- **Niente memoria esterna**: l'unica fonte di verità sono i file del progetto.
- **Non scrivere fuori dalla cartella del progetto** senza autorizzazione.
- **Progetto auto-portante**: nessun percorso assoluto macchina-specifico; i binari
  si risolvono a runtime per sistema operativo.
- La logica sta nella **libreria**. Le interfacce (CLI, web, …) chiamano e non
  duplicano.

## Ambiente

- Windows 11, PowerShell. I binari esterni stanno in `tools/` (`yt-dlp.exe`,
  `ffmpeg.exe`, `ffprobe.exe`) e non sono versionati.
- La libreria dell'utente vive in `ondo-data/` (o dove dice `ONDO_ROOT`): non è
  versionata e **contiene i suoi video**. Non toccarla per fare prove — per quelle
  si usa una radice di scarto (`ONDO_ROOT=...`), perché due processi sulla stessa
  libreria si sovrascrivono a vicenda.
