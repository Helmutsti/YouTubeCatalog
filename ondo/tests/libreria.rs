//! Le funzioni di lettura e di rimozione, su una libreria vera su disco (ma
//! finta: nessun download, nessuna rete).

use std::path::PathBuf;

use ondo::Library;

/// Una radice temporanea con due video dentro, di cui uno con il file davvero
/// presente e uno con il file mancante.
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
              "file": "videos/Autore Uno/Presente [aaa].mp4", "size_bytes": 9,
              "cover": "covers/aaa.jpg", "added_at": 100
            },
            "bbb": {
              "id": "bbb", "title": "Sparito", "author": "Autore Due",
              "file": "videos/Autore Due/Sparito [bbb].mp4", "added_at": 200
            }
          }
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
    // Dal più recente: `bbb` ha added_at più alto.
    assert_eq!(lib.list().iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), ["bbb", "aaa"]);
    assert_eq!(lib.authors(), vec![("Autore Due".into(), 1), ("Autore Uno".into(), 1)]);
    assert_eq!(lib.by_author("Autore Uno").len(), 1);
    assert_eq!(lib.get("aaa").unwrap().title, "Presente");
    assert!(lib.get("zzz").is_none());

    let presente = lib.get("aaa").unwrap();
    assert!(lib.file_path(presente).is_file(), "il percorso è ancorato alla radice");
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
    assert!(root.is_dir(), "la radice viene creata");
    std::fs::remove_dir_all(&root).unwrap();
}

fn ids(videos: Vec<&ondo::Video>) -> Vec<String> {
    videos.into_iter().map(|v| v.id.clone()).collect()
}
