//! Prova end-to-end reale delle foto profilo degli autori.
//!
//! Verifica la catena intera: dal solo id del canale all'immagine su disco, passando
//! per l'interrogazione yt-dlp e il download via ffmpeg.
//!
//! Uso:  cargo run -p ondo-core --example e2e_avatars

use std::fs;

use ondo_core::downloader::Reporter;
use ondo_core::library::{schema, state};
use ondo_core::ops;

struct Printer;
impl Reporter for Printer {
    fn log(&self, line: &str) {
        println!("    {line}");
    }
    fn progress(&self, _p: f64) {}
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = ondo_core::config::get_paths()?;

    // Due canali reali: uno con id noto (percorso normale) e uno con una chiave che
    // è un nome con emoji e caratteri invalidi per Windows, per verificare che il
    // nome file venga sanificato invece di far fallire il salvataggio.
    const CANALE: &str = "UC4QobU6STFB0P71PMvOGN5A"; // jawed
    const CHIAVE_SPORCA: &str = "Créatôr 🎧 / ASMR";

    println!("== 1. creo due autori di prova ==");
    state::transaction(|st| {
        let mut a = schema::Author::new(CANALE, Some(CANALE), Some("jawed"), None);
        a.0.insert("url".into(), serde_json::json!(format!("https://www.youtube.com/channel/{CANALE}")));
        st.authors.insert(CANALE.into(), a);

        let mut b = schema::Author::new(CHIAVE_SPORCA, Some(CANALE), Some(CHIAVE_SPORCA), None);
        b.0.insert("url".into(), serde_json::json!(format!("https://www.youtube.com/channel/{CANALE}")));
        st.authors.insert(CHIAVE_SPORCA.into(), b);
        Ok(())
    })?;
    let st = state::read()?;
    println!("   {} autori, nessuna foto salvata", st.authors.len());
    assert!(st.authors[CANALE].avatar_local_path().is_none());

    println!("\n== 2. risolvo e scarico (yt-dlp per l'URL, ffmpeg per l'immagine) ==");
    let report = ops::sync_author_avatars(false, &Printer)?;
    println!("   {report:?}");
    if report.saved == 0 {
        return Err("nessuna foto salvata".into());
    }

    println!("\n== 3. i file esistono davvero e sono JPEG validi? ==");
    for key in [CANALE, CHIAVE_SPORCA] {
        let path = ops::maintain::author_picture_path(key)?
            .ok_or_else(|| format!("nessun file per «{key}»"))?;
        let bytes = fs::read(&path)?;
        println!("   {key}\n     → {}\n       {} byte", path.display(), bytes.len());
        // Firma JPEG: FF D8 FF. Non basta che il file esista, deve essere un'immagine.
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF], "«{key}» non è un JPEG");
        assert!(bytes.len() > 1000, "«{key}» sospettosamente piccolo");
    }

    println!("\n== 4. il nome file con emoji e slash è stato sanificato? ==");
    let sporco = ops::maintain::author_picture_path(CHIAVE_SPORCA)?.unwrap();
    let nome = sporco.file_name().unwrap().to_string_lossy().to_string();
    println!("   chiave: «{CHIAVE_SPORCA}»\n   file:   «{nome}»");
    assert!(!nome.contains('/') && !nome.contains('\\'), "lo slash va tolto");
    assert!(nome.contains('🎧'), "gli emoji sono validi su NTFS, non vanno persi");

    println!("\n== 5. lo stato registra sia l'URL sia il file locale? ==");
    let st = state::read()?;
    let a = &st.authors[CANALE];
    println!("   sourceUrl: {:?}", a.avatar_source_url().map(|u| &u[..u.len().min(60)]));
    println!("   localPath: {:?}", a.avatar_local_path());
    assert!(a.avatar_source_url().is_some(), "l'URL va registrato");
    assert!(a.avatar_local_path().is_some(), "il file locale va registrato: è il punto");

    println!("\n== 6. una seconda esecuzione salta ciò che c'è già? ==");
    let again = ops::sync_author_avatars(false, &Printer)?;
    println!("   {again:?}");
    assert_eq!(again.saved, 0, "non deve ri-scaricare");
    assert!(again.skipped >= 2, "deve saltare entrambi");

    println!("\n== 7. e con force ri-scarica? ==");
    let forced = ops::sync_author_avatars(true, &Printer)?;
    println!("   {forced:?}");
    assert!(forced.saved >= 2, "con force deve ri-scaricare");

    println!("\n== 8. le foto finiscono nel backup? ==");
    let (bytes, rep) = ops::create_backup()?;
    println!("   backup {} byte, {} foto autore incluse", bytes.len(), rep.author_pictures);
    assert!(rep.author_pictures >= 2, "le foto degli autori vanno nel backup");

    println!("\n== 9. pulizia ==");
    for key in [CANALE, CHIAVE_SPORCA] {
        if let Some(p) = ops::maintain::author_picture_path(key)? {
            fs::remove_file(p)?;
        }
    }
    state::transaction(|st| {
        st.authors.clear();
        Ok(())
    })?;
    let _ = paths;
    println!("   file e autori di prova rimossi");

    println!("\n✔ AVATAR END-TO-END SUPERATO");
    Ok(())
}
