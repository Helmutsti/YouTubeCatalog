//! Le funzioni di lettura, i filtri, la coda e ciò che `apply` fa allo stato: su
//! una libreria vera su disco, ma finta — nessun download, nessuna rete.

use std::path::PathBuf;

use ondo::{Event, Filter, Library, State, Update};

/// Una radice temporanea con due video: `aaa` scaricato e con il file davvero
/// presente, `bbb` scaricato ma con il file sparito.
fn radice(nome: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("ondo-test-{nome}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("videos/Autore Uno")).unwrap();
    std::fs::write(root.join("videos/Autore Uno/Presente [aaa].mp4"), b"finto mp4").unwrap();
    std::fs::create_dir_all(root.join("covers")).unwrap();
    std::fs::write(root.join("covers/aaa.jpg"), b"finto jpg").unwrap();
    std::fs::write(
        root.join("library.json"),
        r#"{
          "version": 1,
          "videos": {
            "aaa": {
              "id": "aaa", "title": "Presente", "author": "Autore Uno",
              "description": "una lezione di grammatica", "tags": ["asmr"],
              "upload_date": "2009-10-25",
              "file": "Autore Uno/Presente [aaa].mp4", "size_bytes": 9,
              "cover": "aaa.jpg", "added_at": 100, "state": "downloaded"
            },
            "bbb": {
              "id": "bbb", "title": "Sparito", "author": "Autore Due",
              "upload_date": "2020-01-01",
              "file": "Autore Due/Sparito [bbb].mp4", "added_at": 200,
              "state": "downloaded"
            }
          },
          "queue": []
        }"#,
    )
    .unwrap();
    root
}

#[test]
fn legge_lo_stato_da_disco() {
    let root = radice("lettura");
    let lib = Library::open(&root).unwrap();

    assert_eq!(lib.len(), 2);
    // Dall'ultimo pubblicato, non dall'ultimo aggiunto.
    assert_eq!(ids(lib.list(Filter::All)), ["bbb", "aaa"]);
    assert_eq!(lib.authors(), vec![("Autore Due".into(), 1), ("Autore Uno".into(), 1)]);
    assert_eq!(lib.by_author("Autore Uno").len(), 1);
    assert_eq!(lib.get("aaa").unwrap().title, "Presente");
    assert!(lib.get("zzz").is_none());

    let presente = lib.get("aaa").unwrap();
    assert!(lib.file_path(presente).is_file(), "il percorso è ancorato alla cartella dei video");
    assert!(lib.cover_path(presente).unwrap().is_file());

    // È il file mancante, non l'entry mancante, che si vuole sapere.
    assert_eq!(lib.missing_files(), vec!["bbb".to_string()]);

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn la_ricerca_trova_per_titolo_autore_tag_e_descrizione() {
    let root = radice("ricerca");
    let lib = Library::open(&root).unwrap();

    assert_eq!(ids(lib.search("presente")), ["aaa"]);
    assert_eq!(ids(lib.search("uno")), ["aaa"], "l'autore è cercabile");
    assert_eq!(ids(lib.search("asmr")), ["aaa"], "i tag sono cercabili");
    assert_eq!(ids(lib.search("grammatica")), ["aaa"], "la descrizione è cercabile");
    assert!(lib.search("presente bicicletta").is_empty(), "AND: una parola fuori posto esclude");
    assert!(lib.search("   ").is_empty(), "una query vuota non è una ricerca");
    assert_eq!(ids(lib.search("autore")).len(), 2);

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn i_flag_diventano_viste() {
    let root = radice("filtri");
    let mut lib = Library::open(&root).unwrap();

    assert_eq!(lib.count(Filter::Downloaded), 2);
    assert_eq!(lib.count(Filter::Favorites), 0);

    assert!(lib.set_favorite("aaa", true).unwrap());
    assert!(lib.set_archived("bbb", true).unwrap());
    assert!(!lib.set_favorite("zzz", true).unwrap(), "un id che non c'è non è un errore");

    assert_eq!(ids(lib.list(Filter::Favorites)), ["aaa"]);
    assert_eq!(ids(lib.list(Filter::Archived)), ["bbb"]);
    assert_eq!(ids(lib.list(Filter::All)), ["aaa"], "gli archiviati escono da «tutti»");
    assert_eq!(lib.authors().len(), 1, "e anche dagli autori");
    assert_eq!(
        ids(lib.search("sparito")),
        ["bbb"],
        "ma restano cercabili: si cerca proprio quando non si sa dove sia finito"
    );

    // Un fallito torna in coda con `retry`, e l'errore se ne va.
    lib.apply(&errore("bbb", "https://esempio/bbb", "Video unavailable")).unwrap();
    assert_eq!(lib.get("bbb").unwrap().state, State::Failed);
    assert_eq!(lib.get("bbb").unwrap().attempts, 1);
    assert_eq!(ids(lib.list(Filter::Failed)), ["bbb"]);
    assert_eq!(lib.retry("bbb").unwrap().as_deref(), Some(""), "l'url del record, qui vuoto");
    assert_eq!(lib.get("bbb").unwrap().state, State::Pending);
    assert!(lib.get("bbb").unwrap().error.is_none());
    assert_eq!(ids(lib.list(Filter::Pending)), ["bbb"]);

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn la_coda_tiene_i_link_che_non_hanno_ancora_un_id() {
    let root = radice("coda");
    let mut lib = Library::open(&root).unwrap();
    let url = "https://esempio/nuovo";

    lib.enqueue(url).unwrap();
    lib.enqueue(url).unwrap();
    assert_eq!(lib.queue().len(), 1, "lo stesso link non si accoda due volte");

    // Un fallimento prima della risoluzione non ha un id a cui attaccarsi:
    // resta sul link, che è l'unica cosa che si sa.
    lib.apply(&Update {
        job: 1,
        url: url.into(),
        id: None,
        event: Event::Error { message: "link illeggibile".into() },
    })
    .unwrap();
    assert_eq!(lib.queue()[0].error.as_deref(), Some("link illeggibile"));
    assert_eq!(lib.count(Filter::Failed), 0, "nessun video finto per un link mai risolto");

    // Alla risoluzione il link diventa un video e lascia la coda.
    lib.apply(&Update {
        job: 2,
        url: url.into(),
        id: Some("ccc".into()),
        event: Event::Resolved {
            id: "ccc".into(),
            title: "Nuovo".into(),
            author: "Autore Tre".into(),
            duration: Some(12.0),
        },
    })
    .unwrap();
    assert!(lib.queue().is_empty());
    assert_eq!(lib.get("ccc").unwrap().state, State::Downloading);
    assert_eq!(lib.get("ccc").unwrap().url, url);

    // Riaprendo, un «in corso» non ha più nessun sentinel dietro: torna in coda.
    drop(lib);
    let lib = Library::open(&root).unwrap();
    assert_eq!(lib.get("ccc").unwrap().state, State::Pending);

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn rimuovere_puo_lasciare_o_cancellare_i_file() {
    let root = radice("rimozione");
    let mut lib = Library::open(&root).unwrap();
    let video = root.join("videos/Autore Uno/Presente [aaa].mp4");

    // Senza `delete_files` esce dalla libreria ma resta sul disco.
    assert!(lib.remove("bbb", false).unwrap());
    assert!(!lib.remove("bbb", false).unwrap(), "un id che non c'è non è un errore");
    assert!(video.is_file());

    assert!(lib.remove("aaa", true).unwrap());
    assert!(!video.is_file(), "il file va via");
    assert!(!root.join("covers/aaa.jpg").is_file(), "e anche la copertina");
    assert!(!video.parent().unwrap().exists(), "la cartella dell'autore, ora vuota, sparisce");

    // Lo stato è stato salvato, non solo cambiato in memoria.
    assert!(Library::open(&root).unwrap().is_empty());

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn una_cartella_vuota_e_una_libreria_vuota() {
    let root = std::env::temp_dir().join(format!("ondo-test-nuova-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let lib = Library::open(&root).unwrap();
    assert!(lib.is_empty());
    assert!(lib.queue().is_empty());
    assert!(root.is_dir(), "la radice viene creata");
    std::fs::remove_dir_all(&root).unwrap();
}

/// Un yt-dlp finto: risponde al `-J` con dei metadati minimi e, al download,
/// scrive un file dove gli dice `ONDO_TEST_OUT`.
///
/// Serve perché il percorso **riuscito** non era coperto da nessun test: i test del
/// pool forzavano solo errori, e così è passato inosservato un `Event::Done` che non
/// veniva più emesso — il job non si chiudeva mai e chi aspettava restava lì.
#[cfg(windows)]
const FINTO_YTDLP: &str = r#"@echo off
echo %* | findstr /C:"--skip-download" >nul
if not errorlevel 1 (
  echo {"id":"FINTO1","title":"Video finto","channel":"Autore Finto","webpage_url":"https://esempio/finto","extractor_key":"Test","duration":12,"upload_date":"20240102","width":1920,"height":1080}
  exit /b 0
)
echo [download]  50.0%% of 1MiB
echo [download] 100.0%% of 1MiB
> "%ONDO_TEST_OUT%" echo finto
exit /b 0
"#;

#[cfg(windows)]
#[test]
fn un_download_riuscito_chiude_il_job_e_organizza_i_file() {
    use std::time::{Duration, Instant};

    use ondo::{Config, Downloader, Event};

    let root = std::env::temp_dir().join(format!("ondo-test-finto-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let finto = root.join("finto-ytdlp.cmd");
    std::fs::write(&finto, FINTO_YTDLP).unwrap();
    // Il primo `push` è il job 1, quindi il suo staging è prevedibile.
    std::env::set_var("ONDO_TEST_OUT", root.join("staging").join("job-1").join("FINTO1.mp4"));

    let mut cfg = Config::for_root(&root);
    cfg.ytdlp = finto;
    cfg.parallel = 1;
    let mut lib = Library::with_config(cfg).unwrap();

    // Si guida il pool come fa la CLI: si accoda, si aspetta l'evento terminale,
    // si applica. Con un `recv_timeout` invece di un'attesa infinita, così se il
    // job non si chiude il test **fallisce** invece di restare appeso.
    let mut dl = Downloader::start(lib.config());
    lib.enqueue("https://esempio/finto").unwrap();
    dl.push("https://esempio/finto");

    let scadenza = Instant::now() + Duration::from_secs(30);
    let mut chiuso = false;
    while Instant::now() < scadenza && !chiuso {
        if let Some(u) = dl.recv_timeout(Duration::from_millis(200)) {
            if let Event::Error { message } = &u.event {
                panic!("il finto yt-dlp non ha funzionato: {message}");
            }
            chiuso = matches!(u.event, Event::Done { .. });
            lib.apply(&u).unwrap();
        }
    }
    assert!(chiuso, "il job non si è chiuso con un evento terminale");

    let v = lib.get("FINTO1").expect("entrato in libreria");
    assert_eq!(v.state, State::Downloaded);
    assert_eq!(v.title, "Video finto");
    assert_eq!(v.author, "Autore Finto");
    assert_eq!(v.upload_date.as_deref(), Some("2024-01-02"));
    assert_eq!(v.file, "Autore Finto/Video finto [FINTO1].mp4", "layout canonico");
    assert!(lib.file_path(v).is_file(), "il file è stato spostato al suo posto");
    assert!(lib.metadata_path(v).unwrap().is_file(), "i metadati sono stati conservati");
    assert!(v.cover.is_none(), "senza copertina nei metadati non se ne inventa una");
    assert!(lib.queue().is_empty(), "il link risolto lascia la coda");
    // Senza ffprobe la misura del file non si può fare: si tengono i numeri dei
    // metadati invece di non averne.
    assert_eq!((v.width, v.height), (Some(1920), Some(1080)));
    assert!(!root.join("staging").join("job-1").exists(), "lo staging è stato svuotato");

    dl.shutdown();
    drop(lib);
    std::fs::remove_dir_all(&root).unwrap();
}

fn errore(id: &str, url: &str, message: &str) -> Update {
    Update {
        job: 9,
        url: url.into(),
        id: Some(id.into()),
        event: Event::Error { message: message.into() },
    }
}

fn ids(videos: Vec<&ondo::Video>) -> Vec<String> {
    videos.into_iter().map(|v| v.id.clone()).collect()
}
