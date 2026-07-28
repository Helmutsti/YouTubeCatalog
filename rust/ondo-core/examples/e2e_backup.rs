//! Prova end-to-end reale di backup e ripristino.
//!
//! Verifica ciò che i test unitari non possono: che l'archivio prodotto sia leggibile,
//! che il ripristino rimetta esattamente ciò che c'era, e che la copia di sicurezza
//! esista davvero prima che qualcosa venga sovrascritto.
//!
//! Uso:  cargo run -p ondo-core --example e2e_backup

use std::fs;

use ondo_core::library::{metadata, schema, state};
use ondo_core::ops;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = ondo_core::config::get_paths()?;

    println!("== 1. stato di partenza ==");
    let before = state::read()?;
    println!("   {} video, {} autori, {} sorgenti", before.videos.len(), before.authors.len(), before.sources.len());

    // Si crea un po' di stato riconoscibile, così il confronto è significativo anche
    // su un catalogo vuoto.
    println!("\n== 2. creo stato di prova ==");
    state::transaction(|st| {
        for (id, autore) in [("prova000001", "Autore Uno"), ("prova000002", "Créatôr 🎧")] {
            let v = schema::new_video(schema::NewVideo {
                id,
                title: Some("Titolo di prova — con accenti é e emoji 🎬"),
                channel_name: Some(autore),
                channel_id: Some(autore),
                duration_seconds: Some(212.0),
                playlist_index: None,
                playlist_id: None,
                playlist_title: None,
                source_id: None,
                webpage_url: None,
                original_url: None,
                extractor: None,
            });
            st.upsert_author_from_video(&v);
            st.videos.insert(id.to_string(), v);
        }
        st.sources.insert(
            "PLprova".into(),
            schema::Source::new_playlist("PLprova", "Playlist di prova", "https://y/playlist?list=PLprova"),
        );
        Ok(())
    })?;
    metadata::set("prova000001", &serde_json::json!({
        "id": "prova000001", "title": "grezzo", "formats": [{ "height": 1080 }],
        "automatic_captions": { "it": ["deve sparire"] }
    }))?;
    fs::write(paths.covers_dir.join("prova000001.jpg"), b"\xFF\xD8\xFF\xE0finta-jpeg")?;

    let st = state::read()?;
    println!("   ora: {} video, {} autori, {} sorgenti", st.videos.len(), st.authors.len(), st.sources.len());

    println!("\n== 3. creo il backup ==");
    let (bytes, report) = ops::create_backup()?;
    println!("   {} byte — {report:?}", bytes.len());
    assert!(report.videos >= 2 && report.metadata_files >= 1 && report.covers >= 1);

    println!("\n== 4. l'archivio è leggibile e contiene ciò che deve? ==");
    let (manifest, files, total) = ops::inspect_backup(&bytes)?;
    println!("   {files} voci, {total} byte non compressi");
    let m = manifest.ok_or("manifesto assente")?;
    println!("   manifesto: creato {}", m["createdAt"].as_str().unwrap_or("?"));
    let names = ondo_core::library::zip::read_zip(&bytes)?
        .iter()
        .map(|e| e.name.clone())
        .collect::<Vec<_>>();
    for atteso in ["library.json", "sources.json", "backup.json", "metadata/prova000001.json", "covers/prova000001.jpg"] {
        assert!(names.contains(&atteso.to_string()), "manca «{atteso}» nell'archivio: {names:?}");
        println!("   ✔ {atteso}");
    }
    assert!(
        !names.iter().any(|n| n.contains("cookies")),
        "i cookie NON devono finire in un backup"
    );
    println!("   ✔ nessun cookie nell'archivio");

    println!("\n== 5. distruggo lo stato ==");
    state::transaction(|st| {
        st.videos.clear();
        st.authors.clear();
        st.sources.clear();
        Ok(())
    })?;
    metadata::delete("prova000001")?;
    let vuoto = state::read()?;
    println!("   {} video, {} autori, {} sorgenti", vuoto.videos.len(), vuoto.authors.len(), vuoto.sources.len());
    assert!(vuoto.videos.is_empty() && !metadata::has("prova000001"));

    println!("\n== 6. ripristino ==");
    let restore = ops::restore_backup(&bytes)?;
    println!("   {} file ripristinati", restore.restored_files);
    println!("   copia di sicurezza: {:?}", restore.safety_copy);
    let safety = restore.safety_copy.clone().ok_or("copia di sicurezza assente")?;
    assert!(safety.is_dir(), "la copia di sicurezza deve esistere PRIMA di sovrascrivere");
    if !restore.skipped.is_empty() {
        println!("   voci ignorate: {:?}", restore.skipped);
    }

    println!("\n== 7. lo stato è tornato quello di prima? ==");
    let after = state::read()?;
    println!("   {} video, {} autori, {} sorgenti", after.videos.len(), after.authors.len(), after.sources.len());
    assert_eq!(after.videos.len(), st.videos.len(), "numero di video");
    assert_eq!(after.authors.len(), st.authors.len(), "numero di autori");
    assert_eq!(after.sources.len(), st.sources.len(), "numero di sorgenti");

    let v = after.video("prova000002")?;
    println!("   titolo con accenti/emoji: {}", v.display_title());
    assert_eq!(v.channel_name(), Some("Créatôr 🎧"), "unicode preservato");

    let raw = metadata::get("prova000001")?.ok_or("metadati non ripristinati")?;
    println!("   metadati: {} campi", raw.as_object().map(|o| o.len()).unwrap_or(0));
    assert!(raw.get("automatic_captions").is_none(), "automatic_captions non deve tornare");
    let cover = fs::read(paths.covers_dir.join("prova000001.jpg"))?;
    println!("   copertina: {} byte", cover.len());
    assert_eq!(&cover[..4], b"\xFF\xD8\xFF\xE0", "byte della copertina identici");

    println!("\n== 8. un archivio VALIDO con una voce malevola: la voce viene scartata? ==");
    // Il caso realistico è questo, non un archivio interamente finto: un backup che
    // supera i controlli d'ingresso e nasconde una entry che tenta di scrivere fuori.
    use ondo_core::library::zip::{create_zip, ZipEntry};
    let vittima = paths.data_dir.parent().unwrap_or(&paths.data_dir).join("BUCATO.txt");
    let _ = fs::remove_file(&vittima);

    let malevolo = create_zip(&[
        ZipEntry { name: "library.json".into(), data: fs::read(&paths.library_path)? },
        ZipEntry { name: "../BUCATO.txt".into(), data: b"scritto fuori dalla cartella dati".to_vec() },
        ZipEntry { name: "metadata/../../BUCATO2.txt".into(), data: b"anche questo".to_vec() },
        ZipEntry { name: "cookies.txt".into(), data: b"credenziale".to_vec() },
    ]);
    let r = ops::restore_backup(&malevolo)?;
    println!("   ripristinati: {}   ignorati: {:?}", r.restored_files, r.skipped);
    assert_eq!(r.restored_files, 1, "solo library.json doveva essere scritto");
    assert_eq!(r.skipped.len(), 3, "le altre tre voci vanno scartate");
    assert!(!vittima.exists(), "NIENTE deve essere scritto fuori da data/");
    assert!(
        !paths.core_dir.join("cookies.txt").exists() || fs::read(paths.core_dir.join("cookies.txt"))? != b"credenziale",
        "un backup non deve poter sovrascrivere i cookie"
    );
    println!("   ✔ nulla è stato scritto fuori da data/, e i cookie non sono stati toccati");
    let _ = fs::remove_dir_all(r.safety_copy.unwrap_or_default());

    println!("\n== 9. pulizia ==");
    state::transaction(|st| {
        st.videos.clear();
        st.authors.clear();
        st.sources.clear();
        Ok(())
    })?;
    metadata::delete("prova000001")?;
    let _ = fs::remove_file(paths.covers_dir.join("prova000001.jpg"));
    let _ = fs::remove_dir_all(&safety);
    println!("   stato svuotato, copia di sicurezza rimossa");

    println!("\n✔ BACKUP END-TO-END SUPERATO");
    Ok(())
}
