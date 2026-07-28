//! Errori del core.
//!
//! `kind` è un codice **stabile e machine-readable**; `message` è il testo in
//! italiano già usato dall'implementazione JS. La distinzione serve al contratto
//! FFI previsto in `docs/rust-core.md` §6: i client non devono fare parsing di
//! stringhe localizzate per capire *che tipo* di errore è avvenuto.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Entità assente (video, fonte, file).
    NotFound,
    /// Input dell'utente non valido.
    Invalid,
    /// Errore di I/O su disco.
    Io,
    /// JSON malformato o non conforme allo schema atteso.
    Parse,
    /// Stato incompatibile con l'operazione richiesta.
    Conflict,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::NotFound => "not_found",
            ErrorKind::Invalid => "invalid",
            ErrorKind::Io => "io",
            ErrorKind::Parse => "parse",
            ErrorKind::Conflict => "conflict",
        }
    }
}

#[derive(Debug, Clone)]
pub struct OndoError {
    pub kind: ErrorKind,
    pub message: String,
}

impl OndoError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Conflict, message)
    }
}

impl fmt::Display for OndoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for OndoError {}

impl From<std::io::Error> for OndoError {
    fn from(err: std::io::Error) -> Self {
        Self::new(ErrorKind::Io, err.to_string())
    }
}

impl From<serde_json::Error> for OndoError {
    fn from(err: serde_json::Error) -> Self {
        Self::new(ErrorKind::Parse, err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, OndoError>;
