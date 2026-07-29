# CLAUDE.md

Ondo: archivio locale di video (yt-dlp) — una libreria Rust e un processo sentinel.
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
- `data/` e `media/` contengono l'archivio storico dell'utente: non toccarli.
