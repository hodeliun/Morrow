// The published identifier keeps the Electron data folder so vaults, sync pairings, and assistant settings
// carry over from 1.x.
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static DOCUMENTS_DIR: OnceLock<PathBuf> = OnceLock::new();

const LEGACY_IDENTIFIER: &str = "app.morrow.desktop";

// where new vaults go when the system has no documents folder of its own, as on a phone
#[allow(dead_code)]
pub fn set_documents_dir(dir: Option<PathBuf>) {
    if let Some(dir) = dir {
        let _ = std::fs::create_dir_all(&dir);
        let _ = DOCUMENTS_DIR.set(dir);
    }
}

fn is_absolute_nonempty(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.is_absolute()
}

fn resolve_data_dir(
    identifier: &str,
    app_config_dir: Option<PathBuf>,
    legacy_config_dir: Option<PathBuf>,
    debug_override: Option<PathBuf>,
    is_debug: bool,
    is_mobile: bool,
) -> std::io::Result<PathBuf> {
    let debug_override = if is_debug { debug_override } else { None };

    if identifier == LEGACY_IDENTIFIER {
        // Keep the published identifier's exact upstream precedence and fallbacks.
        let dir = debug_override
            .or_else(|| {
                if is_mobile {
                    app_config_dir.clone()
                } else {
                    None
                }
            })
            .or(legacy_config_dir)
            .or(app_config_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        return Ok(dir);
    }

    if let Some(path) = debug_override {
        if is_absolute_nonempty(&path) {
            return Ok(path);
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "MORROW_USER_DATA must be an absolute, non-empty path for this identifier",
        ));
    }

    match app_config_dir {
        Some(path) if is_absolute_nonempty(&path) => Ok(path),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("no absolute app config directory is available for {identifier}"),
        )),
    }
}

pub fn init_data_dir(identifier: &str, app_config_dir: Option<PathBuf>) -> std::io::Result<()> {
    let is_debug = cfg!(debug_assertions);
    let debug_override = if is_debug {
        std::env::var_os("MORROW_USER_DATA").map(PathBuf::from)
    } else {
        None
    };
    let dir = resolve_data_dir(
        identifier,
        app_config_dir,
        dirs::config_dir().map(|dir| dir.join("Morrow")),
        debug_override,
        is_debug,
        cfg!(mobile),
    )?;

    if identifier == LEGACY_IDENTIFIER {
        // Preserve upstream's best-effort setup for the published identifier.
        let _ = std::fs::create_dir_all(&dir);
    } else {
        // An alternate identifier must never continue with an unusable profile path.
        std::fs::create_dir_all(&dir)?;
    }
    let _ = DATA_DIR.set(dir);
    Ok(())
}

pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn documents_dir() -> PathBuf {
    DOCUMENTS_DIR
        .get()
        .cloned()
        .or_else(dirs::document_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

// resolves . and .. without touching the disk, like node's path.resolve
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                if !out.pop() {
                    out.push(part);
                }
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub fn is_inside(dir: &Path, parent: &Path) -> bool {
    let dir = normalize(dir);
    let parent = normalize(parent);
    dir == parent || dir.starts_with(&parent)
}

// writes beside the target first, so a crash never leaves half a file
pub fn write_atomic_plain(target: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = target.with_file_name(format!(
        "{}.tmp",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file")
    ));
    std::fs::write(&temp, data)?;
    std::fs::rename(&temp, target)
}

pub fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub fn millis(time: std::io::Result<std::time::SystemTime>) -> f64 {
    time.ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

// a name safe to save as a file on every system
pub fn safe_file_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();
    let trimmed: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = trimmed.chars().take(120).collect();
    if short.is_empty() {
        fallback.to_string()
    } else {
        short
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_data_dir, LEGACY_IDENTIFIER};
    use std::path::PathBuf;

    fn absolute_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("morrow-path-test-{name}"))
    }

    #[test]
    fn legacy_identifier_preserves_desktop_and_mobile_precedence() {
        let app_config = absolute_path("app-config");
        let legacy = absolute_path("legacy");

        assert_eq!(
            resolve_data_dir(
                LEGACY_IDENTIFIER,
                Some(app_config.clone()),
                Some(legacy.clone()),
                None,
                false,
                false,
            )
            .unwrap(),
            legacy
        );
        assert_eq!(
            resolve_data_dir(
                LEGACY_IDENTIFIER,
                Some(app_config.clone()),
                None,
                None,
                false,
                false,
            )
            .unwrap(),
            app_config
        );
        assert_eq!(
            resolve_data_dir(
                LEGACY_IDENTIFIER,
                Some(app_config.clone()),
                Some(legacy.clone()),
                None,
                false,
                true,
            )
            .unwrap(),
            app_config
        );
        assert_eq!(
            resolve_data_dir(
                LEGACY_IDENTIFIER,
                None,
                Some(legacy.clone()),
                None,
                false,
                true,
            )
            .unwrap(),
            legacy
        );
        assert_eq!(
            resolve_data_dir(LEGACY_IDENTIFIER, None, None, None, false, false).unwrap(),
            PathBuf::from(".")
        );
    }

    #[test]
    fn legacy_identifier_keeps_debug_override_literal_and_release_ignores_it() {
        let relative_override = PathBuf::from("relative/debug-profile");
        assert_eq!(
            resolve_data_dir(
                LEGACY_IDENTIFIER,
                None,
                None,
                Some(relative_override.clone()),
                true,
                false,
            )
            .unwrap(),
            relative_override
        );
        assert_eq!(
            resolve_data_dir(
                LEGACY_IDENTIFIER,
                None,
                None,
                Some(PathBuf::new()),
                true,
                false,
            )
            .unwrap(),
            PathBuf::new()
        );
        assert_eq!(
            resolve_data_dir(
                LEGACY_IDENTIFIER,
                None,
                Some(absolute_path("legacy-release")),
                Some(absolute_path("ignored-override")),
                false,
                false,
            )
            .unwrap(),
            absolute_path("legacy-release")
        );
    }

    #[test]
    fn alternate_identifier_uses_only_its_absolute_app_config_dir() {
        let app_config = absolute_path("alternate-config");
        let legacy = absolute_path("alternate-legacy-must-not-be-used");

        assert_eq!(
            resolve_data_dir(
                "app.morrow.polaris",
                Some(app_config.clone()),
                Some(legacy),
                None,
                true,
                false,
            )
            .unwrap(),
            app_config
        );
        assert_eq!(
            resolve_data_dir(
                "app.morrow.polaris",
                Some(absolute_path("alternate-mobile-config")),
                None,
                None,
                true,
                true,
            )
            .unwrap(),
            absolute_path("alternate-mobile-config")
        );
    }

    #[test]
    fn alternate_identifier_rejects_unavailable_or_relative_paths() {
        let missing = resolve_data_dir(
            "app.morrow.polaris",
            None,
            Some(absolute_path("must-not-fallback")),
            None,
            false,
            false,
        )
        .unwrap_err();
        assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);

        assert_eq!(
            resolve_data_dir(
                "app.morrow.polaris",
                Some(PathBuf::from("relative/config")),
                None,
                None,
                false,
                false,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::NotFound
        );
        assert_eq!(
            resolve_data_dir(
                "app.morrow.polaris",
                Some(absolute_path("available-config")),
                None,
                Some(PathBuf::from("relative/override")),
                true,
                false,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert_eq!(
            resolve_data_dir(
                "app.morrow.polaris",
                Some(absolute_path("available-config")),
                None,
                Some(PathBuf::new()),
                true,
                false,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn alternate_identifier_release_ignores_debug_override() {
        let app_config = absolute_path("alternate-release-config");
        assert_eq!(
            resolve_data_dir(
                "app.morrow.polaris",
                Some(app_config.clone()),
                Some(absolute_path("alternate-release-legacy")),
                Some(absolute_path("alternate-release-override")),
                false,
                false,
            )
            .unwrap(),
            app_config
        );
    }

    #[test]
    fn alternate_identifier_accepts_explicit_absolute_debug_override() {
        let override_path = absolute_path("alternate-debug-override");
        assert_eq!(
            resolve_data_dir(
                "app.morrow.polaris",
                None,
                None,
                Some(override_path.clone()),
                true,
                false,
            )
            .unwrap(),
            override_path
        );
    }
}

#[cfg(test)]
mod independent_tests;
