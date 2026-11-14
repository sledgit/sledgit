//! Shared by the examples: the local key dir and the mainnet confirmation variable.
#![allow(dead_code)]
use std::path::PathBuf;

/// ~/.config/sledgit, or the old ~/.config/iron-trades while only that one exists. Never reads the files.
pub fn key_dir() -> Result<PathBuf, std::env::VarError> {
    let home = PathBuf::from(std::env::var("HOME")?);
    let (dir, old) = (home.join(".config/sledgit"), home.join(".config/iron-trades")); // legacy: remove after the server redeploy
    Ok(if !dir.exists() && old.exists() { old } else { dir })
}

/// SLEDGIT_MAINNET_CONFIRM. No legacy name: a mainnet send needs the current one.
pub fn mainnet_confirm() -> Option<String> {
    std::env::var("SLEDGIT_MAINNET_CONFIRM").ok()
}
