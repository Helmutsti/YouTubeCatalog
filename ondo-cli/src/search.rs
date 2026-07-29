//! Cerca: si scrive, si scelgono i risultati, si agisce. La ricerca la fa
//! `ondo::Library::search` — qui non c'è nessuna regola di corrispondenza.

use dialoguer::{Input, Select};

use crate::library;
use crate::ui::{self, screen, R};
use crate::App;

pub fn open(app: &mut App) -> R<()> {
    let mut query = String::new();
    loop {
        app.pump(|_| {});
        screen("Cerca", &mut app.message);

        query = Input::<String>::with_theme(&ui::theme())
            .with_prompt("Cerca")
            .with_initial_text(&query)
            .allow_empty(true)
            .interact_text()?;
        if query.trim().is_empty() {
            return Ok(());
        }

        loop {
            app.pump(|_| {});
            let risultati = app.lib.search(&query);
            screen(&format!("Cerca · «{query}» — {} risultati", risultati.len()), &mut app.message);

            let ids: Vec<String> = risultati.iter().map(|v| v.id.clone()).collect();
            let mut voci: Vec<String> = risultati.iter().map(|v| ui::video_line(v)).collect();
            voci.push("Cerca altro".into());
            voci.push("← indietro".into());

            let scelta = Select::with_theme(&ui::theme()).items(&voci).default(0).max_length(15).interact_opt()?;
            match scelta {
                Some(i) if i < ids.len() => library::actions(app, &ids[i].clone())?,
                // "Cerca altro" torna al prompt tenendo la query, così si corregge
                // invece di riscriverla.
                Some(i) if i == ids.len() => break,
                _ => return Ok(()),
            }
        }
    }
}
