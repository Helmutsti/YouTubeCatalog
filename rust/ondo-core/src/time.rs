//! Timestamp ISO-8601 UTC, identici a quelli prodotti da `new Date().toISOString()`.
//!
//! Scritto a mano invece di aggiungere `chrono`/`time`: serve **una** funzione,
//! e l'allowlist delle dipendenze (docs/rust-core.md §5) è deliberatamente
//! minima. L'algoritmo di conversione giorni→data civile è quello classico di
//! Howard Hinnant, lo stesso usato dalle implementazioni di `<chrono>`.

use std::time::{SystemTime, UNIX_EPOCH};

/// Formato: `2026-07-28T12:34:56.789Z` — esattamente quello di `toISOString()`
/// in JavaScript (millisecondi sempre a 3 cifre, suffisso `Z`).
pub fn now_iso8601() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    from_epoch_millis(millis)
}

pub fn now_epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Timestamp di `n` minuti fa. Serve a confrontare "quanto è vecchio" un valore già
/// salvato: i timestamp sono ISO-8601 UTC a lunghezza fissa, quindi il confronto
/// lessicografico fra stringhe coincide con quello cronologico.
pub fn minutes_ago_iso8601(n: i64) -> String {
    from_epoch_millis(now_epoch_millis() - n * 60_000)
}

pub fn from_epoch_millis(millis: i64) -> String {
    let (mut secs, mut ms) = (millis.div_euclid(1000), millis.rem_euclid(1000));
    if ms < 0 {
        ms += 1000;
        secs -= 1;
    }
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);

    let (year, month, day) = civil_from_days(days);
    let (hour, min, sec) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{ms:03}Z")
}

/// Giorni dall'epoca Unix → (anno, mese, giorno) del calendario gregoriano.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_javascript_to_iso_string() {
        // Valori di riferimento generati da `new Date(ms).toISOString()` in Node
        // 24 su questa macchina, NON scritti a mano: la prima stesura di questo
        // test conteneva due attese inventate e falliva pur essendo il codice
        // corretto. Per rigenerarli:
        //   node -e 'for (const ms of [...]) console.log(ms, new Date(ms).toISOString())'
        assert_eq!(from_epoch_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(from_epoch_millis(1_000), "1970-01-01T00:00:01.000Z");
        assert_eq!(from_epoch_millis(1_769_000_000_000), "2026-01-21T12:53:20.000Z");
        assert_eq!(from_epoch_millis(1_785_240_000_123), "2026-07-28T12:00:00.123Z");
        // Anno bisestile: il 29 febbraio deve esistere.
        assert_eq!(from_epoch_millis(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        // Prima dell'epoca (difensivo: non dovrebbe capitare, ma non deve sballare).
        assert_eq!(from_epoch_millis(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn now_has_the_right_shape() {
        let now = now_iso8601();
        assert_eq!(now.len(), 24, "atteso YYYY-MM-DDTHH:MM:SS.mmmZ, trovato {now}");
        assert!(now.ends_with('Z'));
    }
}
