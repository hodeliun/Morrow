// file system access for the vault, every path is checked to stay inside the chosen folder
use crate::paths::{self, millis, normalize};
use cap_fs_ext::{ambient_authority, DirExt};
use cap_std::fs::Dir as CapabilityDir;
use rayon::prelude::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering as CmpOrdering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, MutexGuard};
use std::time::Duration;

const MAX_FILES: usize = 200_000;
const MAX_DEPTH: usize = 64;
const MAX_TEXT_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const TEMP_MARK: &str = ".morrow-tmp-";

fn advance_generation() -> u64 {
    SESSION_GENERATION.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
}

fn current_generation() -> u64 {
    SESSION_GENERATION.load(Ordering::SeqCst)
}

struct Open {
    root: PathBuf,
    real_root: PathBuf,
    generation: u64,
    metadata_root: Option<CapabilityDir>,
    _watcher: Option<notify::RecommendedWatcher>,
}

static OPEN: Mutex<Option<Open>> = Mutex::new(None);
static TRANSITION: Mutex<()> = Mutex::new(());
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);
// size, modified time and hash of each file, so an unchanged file is not read again
type HashCache = HashMap<PathBuf, (u64, f64, String)>;
static HASHES: Mutex<Option<HashCache>> = Mutex::new(None);

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFileMetadata {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFilePage {
    pub generation: u64,
    pub status: FilePageStatus,
    pub entries: Vec<VaultFileMetadata>,
    pub next_cursor: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FilePageStatus {
    Ready,
    Empty,
    NotFound,
    Blocked,
    IoError,
    Unavailable,
    Stale,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePageCursor {
    version: u8,
    generation: u64,
    directory_hash: String,
    last_name_base64: String,
}

struct OpenSnapshot {
    real_root: PathBuf,
    generation: u64,
    metadata_root: Option<CapabilityDir>,
}

const MAX_PAGE_SIZE: usize = 200;
const DEFAULT_PAGE_SIZE: usize = 100;
const MAX_CURSOR_BYTES: usize = 8192;
const MAX_CURSOR_NAME_BYTES: usize = 1024;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn list_file() -> PathBuf {
    paths::data_dir().join("vaults.json")
}

fn transition_lock() -> Result<MutexGuard<'static, ()>> {
    TRANSITION.lock().map_err(err)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTransitionResult {
    pub ok: bool,
    pub generation: u64,
    pub session_generation: Option<u64>,
    pub current_changed: bool,
    pub error: Option<String>,
}

#[derive(Default)]
struct VaultList {
    current: Option<String>,
    recent: Vec<(String, f64)>,
}

fn read_list_at(file: &Path) -> VaultList {
    let Some(raw) = paths::read_json(file) else {
        return VaultList::default();
    };
    let current = raw["current"]
        .as_str()
        .filter(|path| Path::new(path).is_absolute())
        .map(String::from);
    let recent = raw["recent"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let path = item["path"].as_str()?;
                    Path::new(path)
                        .is_absolute()
                        .then(|| (path.to_string(), item["openedAt"].as_f64().unwrap_or(0.0)))
                })
                .take(20)
                .collect()
        })
        .unwrap_or_default();
    VaultList { current, recent }
}

fn read_list() -> VaultList {
    read_list_at(&list_file())
}

fn write_list_at(file: &Path, list: &VaultList) -> Result<()> {
    let recent: Vec<Value> = list
        .recent
        .iter()
        .map(|(path, at)| json!({ "path": path, "openedAt": at }))
        .collect();
    let body = serde_json::to_vec_pretty(&json!({ "current": list.current, "recent": recent }))
        .map_err(err)?;
    paths::write_atomic_plain(file, &body).map_err(err)
}

fn is_dir(path: &Path) -> bool {
    fs::metadata(path)
        .map(|info| info.is_dir())
        .unwrap_or(false)
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn state() -> Value {
    let list = read_list();
    let recent: Vec<Value> = list
        .recent
        .iter()
        .map(|(path, _)| {
            json!({ "path": path, "name": base_name(Path::new(path)), "exists": is_dir(Path::new(path)) })
        })
        .collect();
    let current = list.current.filter(|path| is_dir(Path::new(path)));
    json!({ "current": current, "recent": recent })
}

fn ready_session_generation() -> Option<u64> {
    let generation = current_generation();
    OPEN
        .lock()
        .ok()?
        .as_ref()
        .filter(|open| open.generation == generation)
        .map(|open| open.generation)
}

fn transition_result(
    ok: bool,
    current_changed: bool,
    error: Option<String>,
) -> VaultTransitionResult {
    VaultTransitionResult {
        ok,
        generation: current_generation(),
        session_generation: ready_session_generation(),
        current_changed,
        error,
    }
}

fn clear_open() {
    if let Ok(mut open) = OPEN.lock() {
        *open = None;
    }
}

fn select_at(dir: &str, file: &Path) -> VaultTransitionResult {
    let _transition = match transition_lock() {
        Ok(guard) => guard,
        Err(error) => return transition_result(false, false, Some(error)),
    };
    let path = Path::new(dir);
    if !path.is_absolute() {
        return transition_result(false, false, Some("Choose a folder.".into()));
    }
    let resolved = normalize(path);
    if !is_dir(&resolved) {
        return transition_result(false, false, Some("That folder does not exist any more.".into()));
    }
    if resolved.parent().is_none() || resolved == paths::home_dir() {
        return transition_result(
            false,
            false,
            Some("Choose a folder of its own for your notes, not your whole drive or home folder.".into()),
        );
    }
    let text = resolved.to_string_lossy().into_owned();
    let mut list = read_list_at(file);
    let changes_current = list.current.as_deref() != Some(text.as_str());
    list.current = Some(text.clone());
    list.recent.retain(|(path, _)| *path != text);
    list.recent.insert(0, (text, paths::now_ms() as f64));
    list.recent.truncate(20);
    match write_list_at(file, &list) {
        Ok(()) => {
            if changes_current {
                // Revoke metadata snapshots but keep the ordinary root/watcher until
                // the app explicitly opens the selected vault or closes this one.
                advance_generation();
            }
            transition_result(true, changes_current, None)
        }
        Err(error) => transition_result(false, false, Some(error)),
    }
}

pub fn select(dir: &str) -> VaultTransitionResult {
    select_at(dir, &list_file())
}

// the vaults in the order they were dragged into in settings, any left out keep their place after them
fn reorder_at(order: &[String], file: &Path) -> VaultTransitionResult {
    let _transition = match transition_lock() {
        Ok(guard) => guard,
        Err(error) => return transition_result(false, false, Some(error)),
    };
    let mut list = read_list_at(file);
    list.recent.sort_by_key(|(path, _)| {
        order
            .iter()
            .position(|item| item == path)
            .unwrap_or(usize::MAX)
    });
    match write_list_at(file, &list) {
        Ok(()) => transition_result(true, false, None),
        Err(error) => transition_result(false, false, Some(error)),
    }
}

pub fn reorder(order: &[String]) -> VaultTransitionResult {
    reorder_at(order, &list_file())
}

fn forget_at(dir: &str, file: &Path) -> VaultTransitionResult {
    let _transition = match transition_lock() {
        Ok(guard) => guard,
        Err(error) => return transition_result(false, false, Some(error)),
    };
    let mut list = read_list_at(file);
    list.recent.retain(|(path, _)| path != dir);
    let closes_current = list.current.as_deref() == Some(dir);
    if closes_current {
        list.current = None;
    }
    if let Err(error) = write_list_at(file, &list) {
        return transition_result(false, false, Some(error));
    }
    if closes_current {
        // Pending saves still target the open root until the follow-up open/close.
        advance_generation();
    }
    transition_result(true, closes_current, None)
}

pub fn forget(dir: &str) -> VaultTransitionResult {
    forget_at(dir, &list_file())
}

pub fn create_default() -> Result<String> {
    create_default_in(&paths::documents_dir())
}

// a new vault named Morrow, or Morrow 2 and so on when that is taken, in the given folder
pub fn create_default_in(documents: &Path) -> Result<String> {
    let mut candidate = documents.join("Morrow");
    let mut n = 2;
    while exists(&candidate) {
        candidate = documents.join(format!("Morrow {n}"));
        n += 1;
    }
    fs::create_dir_all(&candidate).map_err(err)?;
    Ok(candidate.to_string_lossy().into_owned())
}

pub fn chooser_start(start: Option<String>) -> PathBuf {
    start
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && is_dir(path))
        .unwrap_or_else(paths::documents_dir)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_symlink() {
            let link = fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link, &target)?;
            #[cfg(windows)]
            {
                let _ = link;
            }
        } else if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

// copies the open vault, history and all, into another folder such as a cloud app's, and returns the copy
pub fn copy_into(parent: &str) -> Value {
    let Some(root) = current() else {
        return json!({ "ok": false, "error": "No vault is open." });
    };
    let into = Path::new(parent);
    if !into.is_absolute() || !is_dir(into) {
        return json!({ "ok": false, "error": "That folder does not exist." });
    }
    let into = normalize(into);
    if paths::is_inside(&into, &root) {
        return json!({ "ok": false, "error": "Choose a folder outside this vault." });
    }
    let name = base_name(&root);
    let mut target = into.join(&name);
    let mut n = 2;
    while exists(&target) {
        target = into.join(format!("{name} {n}"));
        n += 1;
    }
    if let Err(error) = copy_tree(&root, &target) {
        let _ = fs::remove_dir_all(&target);
        return json!({ "ok": false, "error": format!("The vault could not be copied: {error}") });
    }
    json!({ "ok": true, "path": target.to_string_lossy() })
}

pub fn current() -> Option<PathBuf> {
    OPEN.lock().ok()?.as_ref().map(|open| open.root.clone())
}

fn roots() -> Result<(PathBuf, PathBuf)> {
    let guard = OPEN.lock().map_err(err)?;
    let open = guard.as_ref().ok_or("No vault is open.")?;
    Ok((open.root.clone(), open.real_root.clone()))
}

pub struct OpenReservation {
    generation: u64,
    root: Option<String>,
    list_file: Option<PathBuf>,
}

#[cfg(test)]
fn reserve_open(root: Option<String>) -> Result<OpenReservation> {
    let _transition = transition_lock()?;
    let generation = advance_generation();
    clear_open();
    Ok(OpenReservation {
        generation,
        root,
        list_file: None,
    })
}

fn reserve_current_open_at(file: &Path) -> Result<OpenReservation> {
    let _transition = transition_lock()?;
    // Reserve and invalidate before any caller can enqueue blocking work.
    let generation = advance_generation();
    clear_open();
    // Keep this reservation filesystem-free: Tauri calls it on the async command
    // thread before it queues the worker that reads this file.
    Ok(OpenReservation {
        generation,
        root: None,
        list_file: Some(file.to_path_buf()),
    })
}

pub fn reserve_current_open() -> Result<OpenReservation> {
    reserve_current_open_at(&list_file())
}

pub fn open_reserved(
    reservation: OpenReservation,
    on_changes: impl Fn(Vec<Value>) + Send + 'static,
) -> Result<Value> {
    let reservation = if let Some(file) = reservation.list_file.as_deref() {
        // The list lookup and root validation run in the blocking worker, while the
        // generation check prevents a delayed worker from reopening after close/select.
        let _transition = transition_lock()?;
        if current_generation() != reservation.generation {
            return Ok(json!({
                "ok": false,
                "root": null,
                "generation": current_generation(),
                "sessionGeneration": ready_session_generation(),
            }));
        }
        let root = read_list_at(file)
            .current
            .filter(|path| is_dir(Path::new(path)));
        OpenReservation {
            generation: reservation.generation,
            root,
            list_file: None,
        }
    } else {
        reservation
    };
    let Some(path) = reservation.root.as_deref() else {
        let _transition = transition_lock()?;
        let generation = current_generation();
        let session_generation = ready_session_generation();
        return Ok(json!({
            "ok": false,
            "root": null,
            "generation": generation,
            "sessionGeneration": session_generation,
        }));
    };
    let root = normalize(Path::new(path));
    let real_root = dunce::canonicalize(&root).map_err(err)?;
    // Catalog access is optional; the vault's existing note/file APIs remain independent.
    let metadata_root = open_catalog_root(&real_root).ok();
    let watcher = start_watching(&root, on_changes);
    let _transition = transition_lock()?;
    if current_generation() != reservation.generation {
        return Ok(json!({
            "ok": false,
            "root": null,
            "generation": current_generation(),
            "sessionGeneration": ready_session_generation(),
        }));
    }
    let mut open = OPEN.lock().map_err(err)?;
    *open = Some(Open {
        root: root.clone(),
        real_root,
        generation: reservation.generation,
        metadata_root,
        _watcher: watcher,
    });
    Ok(json!({
        "ok": true,
        "root": root,
        "generation": reservation.generation,
        "sessionGeneration": reservation.generation,
    }))
}

#[cfg(test)]
pub fn open(dir: &str, on_changes: impl Fn(Vec<Value>) + Send + 'static) -> Result<u64> {
    let root = normalize(Path::new(dir)).to_string_lossy().into_owned();
    let reservation = reserve_open(Some(root))?;
    let result = open_reserved(reservation, on_changes)?;
    result["ok"]
        .as_bool()
        .filter(|ok| *ok)
        .and_then(|_| result["generation"].as_u64())
        .ok_or_else(|| "The vault changed while opening.".into())
}

pub fn close() {
    if let Ok(_transition) = TRANSITION.lock() {
        advance_generation();
        clear_open();
    }
}

// a vault relative path to an absolute one, refusing anything that would leave the vault
pub fn resolve(relative: &str) -> Result<PathBuf> {
    let (root, _) = roots()?;
    resolve_in(&root, relative)
}

fn resolve_in(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty()
        || relative.len() > 4096
        || relative.contains('\0')
        || relative.contains('\\')
    {
        return Err("Invalid path.".into());
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute() || candidate.has_root() || relative.starts_with('/') {
        return Err("Invalid path.".into());
    }
    let absolute = normalize(&root.join(candidate));
    if absolute != root && !absolute.starts_with(root) {
        return Err("That path is outside the vault.".into());
    }
    Ok(absolute)
}

// writes must not follow a link out of the vault
fn check_real(absolute: &Path) -> Result<()> {
    let (_, real_root) = roots()?;
    let mut dir = absolute.parent().map(Path::to_path_buf).unwrap_or_default();
    while !exists(&dir) {
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => break,
        }
    }
    let real = dunce::canonicalize(&dir).map_err(err)?;
    if real != real_root && !real.starts_with(&real_root) {
        return Err("That path is outside the vault.".into());
    }
    Ok(())
}

fn to_relative(root: &Path, absolute: &Path) -> String {
    absolute
        .strip_prefix(root)
        .map(|rest| {
            rest.components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn open_catalog_root(root: &Path) -> std::io::Result<CapabilityDir> {
    #[cfg(unix)]
    {
        use std::path::Component;
        let mut current = CapabilityDir::open_ambient_dir(Path::new("/"), ambient_authority())?;
        for component in root.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(name) => current = current.open_dir_nofollow(name)?,
                Component::ParentDir | Component::Prefix(_) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Vault root is not a canonical absolute path.",
                    ));
                }
            }
        }
        Ok(current)
    }
    #[cfg(windows)]
    {
        use std::path::Component;
        let mut components = root.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Vault root has no Windows disk or share root.",
            ));
        };
        let anchor = PathBuf::from(format!("{}\\", prefix.as_os_str().to_string_lossy()));
        let mut current = CapabilityDir::open_ambient_dir(&anchor, ambient_authority())?;
        for component in components {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(name) => current = current.open_dir_nofollow(name)?,
                Component::ParentDir | Component::Prefix(_) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Vault root is not a canonical absolute path.",
                    ));
                }
            }
        }
        Ok(current)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = root;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "The metadata catalog is unavailable on this platform.",
        ))
    }
}

fn relative_child_path(root: &Path, directory: &str, name: &str) -> Option<String> {
    if name.is_empty()
        || name.len() > MAX_CURSOR_NAME_BYTES
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return None;
    }
    let relative = if directory.is_empty() {
        name.to_owned()
    } else {
        format!("{directory}/{name}")
    };
    if relative.len() > 4096 {
        return None;
    }
    let resolved = resolve_in(root, &relative).ok()?;
    (to_relative(root, &resolved) == relative).then_some(relative)
}

fn file_page(generation: u64, status: FilePageStatus, error: Option<String>) -> VaultFilePage {
    VaultFilePage {
        generation,
        status,
        entries: Vec::new(),
        next_cursor: None,
        error,
    }
}

fn path_error_status(error: &std::io::Error) -> FilePageStatus {
    match error.kind() {
        std::io::ErrorKind::NotFound => FilePageStatus::NotFound,
        std::io::ErrorKind::PermissionDenied => FilePageStatus::Blocked,
        _ => FilePageStatus::IoError,
    }
}

fn page_error(status: FilePageStatus) -> Option<String> {
    match status {
        FilePageStatus::NotFound => Some("The folder no longer exists.".into()),
        FilePageStatus::Blocked => Some("This folder cannot be listed from the open vault.".into()),
        FilePageStatus::IoError => Some("The folder could not be read.".into()),
        FilePageStatus::Unavailable => {
            Some("The metadata catalog is unavailable for this vault.".into())
        }
        _ => None,
    }
}

fn metadata_snapshot(generation: u64) -> std::result::Result<OpenSnapshot, FilePageStatus> {
    let open = OPEN.lock().map_err(|_| FilePageStatus::IoError)?;
    let Some(open) = open.as_ref() else {
        return Err(FilePageStatus::Stale);
    };
    if current_generation() != generation || open.generation != generation {
        return Err(FilePageStatus::Stale);
    }
    Ok(OpenSnapshot {
        real_root: open.real_root.clone(),
        generation: open.generation,
        metadata_root: match open.metadata_root.as_ref() {
            Some(root) => Some(root.try_clone().map_err(|_| FilePageStatus::IoError)?),
            None => None,
        },
    })
}

fn encode_file_cursor(cursor: &FilePageCursor) -> Option<String> {
    let body = serde_json::to_vec(cursor).ok()?;
    let encoded = URL_SAFE_NO_PAD.encode(body);
    if encoded.len() > MAX_CURSOR_BYTES {
        return None;
    }
    let roundtrip = decode_file_cursor(&encoded)?;
    (roundtrip.version == cursor.version
        && roundtrip.generation == cursor.generation
        && roundtrip.directory_hash == cursor.directory_hash
        && roundtrip.last_name_base64 == cursor.last_name_base64)
    .then_some(encoded)
}

fn directory_cursor_hash(directory: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(directory.as_bytes()))
}

fn decode_file_cursor(encoded: &str) -> Option<FilePageCursor> {
    if encoded.is_empty() || encoded.len() > MAX_CURSOR_BYTES {
        return None;
    }
    let body = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&body).ok()
}

fn metadata_directory(
    snapshot: &OpenSnapshot,
    requested: &str,
) -> std::result::Result<CapabilityDir, FilePageStatus> {
    let Some(root) = snapshot.metadata_root.as_ref() else {
        return Err(FilePageStatus::Unavailable);
    };
    if requested.is_empty() {
        return root.try_clone().map_err(|_| FilePageStatus::IoError);
    }
    let target = resolve_in(&snapshot.real_root, requested).map_err(|_| FilePageStatus::Blocked)?;
    if to_relative(&snapshot.real_root, &target) != requested
        || requested
            .split('/')
            .any(|part| part.starts_with('.') || part.contains(TEMP_MARK) || part.contains(".morrow-move-"))
    {
        return Err(FilePageStatus::Blocked);
    }
    let mut current = root.try_clone().map_err(|_| FilePageStatus::IoError)?;
    for part in requested.split('/') {
        let metadata = current
            .symlink_metadata(part)
            .map_err(|error| path_error_status(&error))?;
        if metadata.is_symlink() || !metadata.is_dir() {
            return Err(FilePageStatus::Blocked);
        }
        let next = match current.open_dir_nofollow(part) {
            Ok(next) => next,
            Err(error) => {
                // If the entry changed to a symlink after metadata(), fail closed as blocked.
                let status = if current
                    .symlink_metadata(part)
                    .is_ok_and(|metadata| metadata.is_symlink())
                {
                    FilePageStatus::Blocked
                } else {
                    path_error_status(&error)
                };
                return Err(status);
            }
        };
        current = next;
    }
    Ok(current)
}

fn metadata_for_directory(
    snapshot: &OpenSnapshot,
    requested: &str,
    cursor: Option<&str>,
    limit: Option<usize>,
) -> VaultFilePage {
    let generation = snapshot.generation;
    let directory = match metadata_directory(snapshot, requested) {
        Ok(directory) => directory,
        Err(status) => return file_page(generation, status.clone(), page_error(status)),
    };
    let cursor = match cursor {
        Some(encoded) => match decode_file_cursor(encoded) {
            Some(cursor) => Some(cursor),
            None => {
                return file_page(
                    generation,
                    FilePageStatus::Blocked,
                    Some("The page cursor is invalid.".into()),
                );
            }
        },
        None => None,
    };
    let after = if let Some(cursor) = cursor {
        if cursor.generation != generation {
            return file_page(current_generation(), FilePageStatus::Stale, None);
        }
        let decoded_name = URL_SAFE_NO_PAD
            .decode(cursor.last_name_base64)
            .ok()
            .filter(|name| !name.is_empty() && name.len() <= MAX_CURSOR_NAME_BYTES)
            .and_then(|name| String::from_utf8(name).ok());
        if cursor.version != 2
            || cursor.directory_hash != directory_cursor_hash(requested)
            || decoded_name
                .as_deref()
                .and_then(|name| relative_child_path(&snapshot.real_root, requested, name))
                .is_none()
        {
            return file_page(
                generation,
                FilePageStatus::Blocked,
                Some("The page cursor is invalid.".into()),
            );
        }
        decoded_name
    } else {
        None
    };

    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(error) => {
            let status = path_error_status(&error);
            return file_page(generation, status.clone(), page_error(status));
        }
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                let status = path_error_status(&error);
                return file_page(generation, status.clone(), page_error(status));
            }
        };
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.')
            || name.contains(TEMP_MARK)
            || name.contains(".morrow-move-")
        {
            continue;
        }
        let Some(relative_path) = relative_child_path(&snapshot.real_root, requested, &name) else {
            continue;
        };
        let info = match directory.symlink_metadata(&file_name) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                let status = path_error_status(&error);
                return file_page(generation, status.clone(), page_error(status));
            }
        };
        let kind = info.file_type();
        if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
            continue;
        }
        if kind.is_file() && is_page(&name) {
            continue;
        }
        let modified = millis(info.modified().map(cap_std::time::SystemTime::into_std));
        files.push(VaultFileMetadata {
            name,
            path: relative_path,
            kind: if kind.is_dir() { "folder" } else { "file" }.into(),
            size: kind.is_file().then_some(info.len()),
            modified: (modified > 0.0).then_some(modified),
        });
    }
    files.sort_by(|left, right| match left.name.cmp(&right.name) {
        CmpOrdering::Equal => left.path.cmp(&right.path),
        order => order,
    });

    let page_size = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let start = after
        .as_deref()
        .map(|last| files.partition_point(|entry| entry.name.as_str() <= last))
        .unwrap_or(0);
    let end = start.saturating_add(page_size).min(files.len());
    let has_more = end < files.len();
    let mut page = file_page(
        generation,
        if files.is_empty() && after.is_none() {
            FilePageStatus::Empty
        } else {
            FilePageStatus::Ready
        },
        None,
    );
    page.entries = files.into_iter().skip(start).take(page_size).collect();
    page.next_cursor = if has_more {
        page.entries.last().and_then(|last| {
            encode_file_cursor(&FilePageCursor {
                version: 2,
                generation,
                directory_hash: directory_cursor_hash(requested),
                last_name_base64: URL_SAFE_NO_PAD.encode(last.name.as_bytes()),
            })
        })
    } else {
        None
    };
    page
}

pub fn list_metadata_page(
    generation: u64,
    directory: &str,
    cursor: Option<&str>,
    limit: Option<usize>,
) -> VaultFilePage {
    let snapshot = match metadata_snapshot(generation) {
        Ok(snapshot) => snapshot,
        Err(status) => return file_page(current_generation(), status.clone(), page_error(status)),
    };
    stale_if_generation_changed(
        metadata_for_directory(&snapshot, directory, cursor, limit),
        generation,
        current_generation(),
    )
}

fn stale_if_generation_changed(
    page: VaultFilePage,
    expected_generation: u64,
    actual_generation: u64,
) -> VaultFilePage {
    if expected_generation == actual_generation {
        page
    } else {
        file_page(actual_generation, FilePageStatus::Stale, None)
    }
}

fn is_hidden(relative: &str) -> bool {
    relative
        .split('/')
        .enumerate()
        .any(|(index, part)| part.starts_with('.') && !(index == 0 && part == ".trash"))
}

fn is_page(relative: &str) -> bool {
    let lower = relative.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".canvas")
}

fn birth(info: &fs::Metadata) -> f64 {
    let created = millis(info.created());
    if created > 0.0 {
        created
    } else {
        millis(info.modified())
    }
}

pub fn scan() -> Result<Value> {
    let (root, _) = roots()?;
    let mut pages: Vec<(PathBuf, String)> = Vec::new();
    let mut folders: Vec<Value> = Vec::new();
    let mut others: Vec<String> = Vec::new();
    let mut count = 0usize;
    let mut stack = vec![(root.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_DEPTH || count > MAX_FILES {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            count += 1;
            if count > MAX_FILES {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let absolute = entry.path();
            let relative = to_relative(&root, &absolute);
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if name.contains(TEMP_MARK) || kind.is_symlink() || is_hidden(&relative) {
                continue;
            }
            if kind.is_dir() {
                let mtime = fs::metadata(&absolute)
                    .map(|info| millis(info.modified()))
                    .unwrap_or(0.0);
                let empty = fs::read_dir(&absolute)
                    .map(|mut items| items.next().is_none())
                    .unwrap_or(false);
                folders.push(json!({ "path": relative, "mtime": mtime, "empty": empty }));
                stack.push((absolute, depth + 1));
            } else if kind.is_file() {
                if is_page(&relative) {
                    pages.push((absolute, relative));
                } else {
                    others.push(relative);
                }
            }
        }
    }
    // pages are read many at a time, which is far quicker than one by one on every kind of disk
    let read: Vec<std::result::Result<Value, String>> = pages
        .into_par_iter()
        .filter_map(|(absolute, relative)| {
            let Ok(info) = fs::metadata(&absolute) else {
                return Some(Err(relative));
            };
            if info.len() > MAX_TEXT_BYTES {
                return Some(Err(relative));
            }
            let text = fs::read(&absolute).ok()?;
            Some(Ok(json!({
                "path": relative,
                "text": String::from_utf8_lossy(&text),
                "mtime": millis(info.modified()),
                "birthtime": birth(&info),
            })))
        })
        .collect();
    let mut files = Vec::with_capacity(read.len());
    for item in read {
        match item {
            Ok(file) => files.push(file),
            Err(relative) => others.push(relative),
        }
    }
    let json_at = |relative: &str| paths::read_json(&root.join(relative)).unwrap_or(Value::Null);
    Ok(json!({
        "files": files,
        "folders": folders,
        "others": others,
        "registry": json_at(".morrow/workspace.json"),
        "recent": json_at(".morrow/recent.json"),
    }))
}

fn read_text_or_none(absolute: &Path) -> Result<Option<String>> {
    match fs::read(absolute) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(err(error)),
    }
}

fn random_hex(len: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| format!("{:x}", rng.gen_range(0..16)))
        .collect()
}

// writes beside the target first, so a crash never leaves half a file
fn write_atomic(absolute: &Path, data: &[u8]) -> Result<()> {
    check_real(absolute)?;
    let parent = absolute.parent().ok_or("Invalid path.")?;
    fs::create_dir_all(parent).map_err(err)?;
    let temp = parent.join(format!("{TEMP_MARK}{}", random_hex(12)));
    fs::write(&temp, data).map_err(err)?;
    fs::rename(&temp, absolute).map_err(|error| {
        let _ = fs::remove_file(&temp);
        err(error)
    })
}

fn some<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum VaultOp {
    Check {
        path: String,
        // Missing is invalid; null expects an absent file, like write's explicit expectation.
        #[serde(default, deserialize_with = "some")]
        expect: Option<Option<String>>,
    },
    Write {
        path: String,
        text: String,
        // missing means write whatever is there, null means only when there is no file yet
        #[serde(default, deserialize_with = "some")]
        expect: Option<Option<String>>,
    },
    Rename {
        from: String,
        to: String,
        #[serde(default)]
        optional: bool,
    },
    Remove {
        path: String,
    },
    Rmdir {
        path: String,
    },
    Delete {
        path: String,
    },
}

fn failed(code: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "code": code, "message": message.into() })
}

fn apply_one(op: VaultOp) -> Result<Value> {
    match op {
        VaultOp::Check { path, expect } => {
            let absolute = resolve(&path)?;
            let expect =
                expect.ok_or_else(|| "Check operations need expected contents.".to_string())?;
            return check_path(&path, &absolute, expect);
        }
        VaultOp::Write { path, text, expect } => {
            let absolute = resolve(&path)?;
            if let Some(expect) = expect {
                let current = read_text_or_none(&absolute)?;
                if current != expect {
                    return Ok(json!({
                        "ok": false,
                        "code": "conflict",
                        "message": format!("{path} changed on disk."),
                        "current": current,
                    }));
                }
            }
            write_atomic(&absolute, text.as_bytes())?;
        }
        VaultOp::Rename {
            from: from_rel,
            to: to_rel,
            optional,
        } => {
            let from = resolve(&from_rel)?;
            let to = resolve(&to_rel)?;
            if !exists(&from) {
                return Ok(if optional {
                    json!({ "ok": true })
                } else {
                    failed("error", format!("{from_rel} is missing."))
                });
            }
            let case_only =
                from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
            if !case_only && exists(&to) {
                return Ok(failed("exists", format!("{to_rel} already exists.")));
            }
            check_real(&from)?;
            check_real(&to)?;
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(err)?;
            }
            fs::rename(&from, &to).map_err(err)?;
        }
        VaultOp::Remove { path } => {
            let absolute = resolve(&path)?;
            if !exists(&absolute) {
                return Ok(json!({ "ok": true }));
            }
            check_real(&absolute)?;
            // phones have no system trash, there the vault's own deleted folder keeps it
            #[cfg(desktop)]
            let trashed = trash::delete(&absolute).is_ok();
            #[cfg(mobile)]
            let trashed = false;
            if !trashed {
                // without a system trash the file is kept in the vault's own deleted folder instead
                let (root, _) = roots()?;
                let keep = root.join(".morrow").join("deleted").join(format!(
                    "{}-{}",
                    paths::now_ms(),
                    base_name(&absolute)
                ));
                fs::create_dir_all(keep.parent().unwrap_or(&root)).map_err(err)?;
                fs::rename(&absolute, &keep).map_err(err)?;
            }
        }
        VaultOp::Delete { path } => {
            // only morrow's own bookkeeping is ever deleted outright, pages always go to the trash
            if !path.starts_with(".morrow/") {
                return Ok(failed("error", "Only Morrow files can be deleted."));
            }
            let absolute = resolve(&path)?;
            match fs::remove_file(&absolute) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(err(error))
                }
                _ => {}
            }
        }
        VaultOp::Rmdir { path } => {
            // folders that still hold something stay
            let _ = fs::remove_dir(resolve(&path)?);
        }
    }
    Ok(json!({ "ok": true }))
}

fn check_path(relative: &str, absolute: &Path, expect: Option<String>) -> Result<Value> {
    let current = read_text_or_none(absolute)?;
    if current != expect {
        return Ok(json!({
            "ok": false,
            "code": "conflict",
            "message": format!("{relative} changed on disk."),
            "current": current,
        }));
    }
    Ok(json!({ "ok": true }))
}

pub fn apply(ops: Value) -> Vec<Value> {
    let Value::Array(ops) = ops else {
        return vec![failed("error", "Invalid operations.")];
    };
    let mut results = Vec::new();
    for raw in ops {
        let result = match serde_json::from_value::<VaultOp>(raw) {
            Ok(op) => apply_one(op).unwrap_or_else(|error| failed("error", error)),
            Err(_) => failed("error", "Unknown operation."),
        };
        let ok = result["ok"].as_bool() == Some(true);
        results.push(result);
        if !ok {
            break;
        }
    }
    results
}

pub fn read_text(relative: &str) -> Result<Option<String>> {
    read_text_or_none(&resolve(relative)?)
}

pub fn read_bytes(relative: &str) -> Option<Vec<u8>> {
    let absolute = resolve(relative).ok()?;
    let info = fs::metadata(&absolute).ok()?;
    if !info.is_file() || info.len() > MAX_FILE_BYTES {
        return None;
    }
    fs::read(absolute).ok()
}

pub fn create_file(relative: &str, data: &[u8]) -> Result<()> {
    let absolute = resolve(relative)?;
    if exists(&absolute) {
        return Err("A file with that name already exists.".into());
    }
    write_atomic(&absolute, data)
}

pub fn path_exists(relative: &str) -> Result<bool> {
    Ok(exists(&resolve(relative)?))
}

pub fn list(relative: &str) -> Result<Vec<Value>> {
    let (root, _) = roots()?;
    let dir = resolve_in(&root, relative)?;
    let mut result = Vec::new();
    let mut stack = vec![(dir, 0usize)];
    while let Some((current, depth)) = stack.pop() {
        if depth > 16 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if entry.file_name().to_string_lossy().contains(TEMP_MARK) || kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push((entry.path(), depth + 1));
            } else if kind.is_file() {
                if let Ok(info) = entry.metadata() {
                    result.push(json!({
                        "path": to_relative(&root, &entry.path()),
                        "size": info.len(),
                        "mtime": millis(info.modified()),
                    }));
                }
            }
        }
    }
    Ok(result)
}

// ---- for sync between computers

// files every computer shares: pages, attachments, the trash and the shared part of morrow's bookkeeping
pub fn is_synced_path(relative: &str) -> bool {
    if relative.is_empty() || relative.contains(TEMP_MARK) || relative.contains(".morrow-move-") {
        return false;
    }
    // what the vault keeps about itself goes to the other computers too: page order, flashcard progress,
    // the types picked for properties, tag colours, the sidebar's own sections and the calendars shown with
    // the tasks
    if matches!(
        relative,
        ".morrow/workspace.json"
            | ".morrow/review.json"
            | ".morrow/property-types.json"
            | ".morrow/tag-colors.json"
            | ".morrow/sidebar-sections.json"
            | ".morrow/calendars.json"
    ) || relative.starts_with(".morrow/emoji/")
    {
        return true;
    }
    !is_hidden(relative)
}

fn hash_file(absolute: &Path, size: u64, mtime: f64) -> Option<String> {
    let mut guard = HASHES.lock().ok()?;
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some((cached_size, cached_mtime, hash)) = cache.get(absolute) {
        if *cached_size == size && *cached_mtime == mtime {
            return Some(hash.clone());
        }
    }
    let data = fs::read(absolute).ok()?;
    let hash = hex(&Sha256::digest(&data));
    cache.insert(absolute.to_path_buf(), (size, mtime, hash.clone()));
    Some(hash)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// every synced file in the open vault with a hash of its bytes
pub fn manifest() -> Result<serde_json::Map<String, Value>> {
    let (root, _) = roots()?;
    let mut manifest = serde_json::Map::new();
    let mut count = 0usize;
    let mut stack = vec![(root.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_DEPTH || count > MAX_FILES {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            count += 1;
            let absolute = entry.path();
            let relative = to_relative(&root, &absolute);
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if is_synced_path(&relative) || relative == ".morrow" {
                    stack.push((absolute, depth + 1));
                }
            } else if kind.is_file() && is_synced_path(&relative) {
                let Ok(info) = entry.metadata() else { continue };
                if info.len() > MAX_FILE_BYTES {
                    continue;
                }
                if let Some(hash) = hash_file(&absolute, info.len(), millis(info.modified())) {
                    manifest.insert(relative, Value::String(hash));
                }
            }
        }
    }
    Ok(manifest)
}

pub fn synced_file_base64(relative: &str) -> Option<String> {
    use base64::Engine;
    if !is_synced_path(relative) {
        return None;
    }
    read_bytes(relative).map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
}

// writes a file that came from another computer, only when this computer's copy is still the one the plan saw
pub fn write_synced(relative: &str, data: &str, expect: Option<String>) -> Result<Value> {
    use base64::Engine;
    if !is_synced_path(relative) {
        return Ok(failed("error", "Invalid file."));
    }
    let absolute = resolve(relative)?;
    let current = fs::read(&absolute)
        .ok()
        .map(|bytes| hex(&Sha256::digest(&bytes)));
    if current != expect {
        return Ok(json!({
            "ok": false,
            "code": "conflict",
            "message": format!("{relative} changed meanwhile."),
            "current": null,
        }));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(err)?;
    write_atomic(&absolute, &bytes)?;
    Ok(json!({ "ok": true }))
}

fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// each vault has an id, so two computers only sync folders that are copies of the same vault
pub fn identity() -> Result<Value> {
    let (root, _) = roots()?;
    let file = root.join(".morrow").join("vault.json");
    let name = base_name(&root);
    if let Some(id) = paths::read_json(&file).and_then(|raw| raw["id"].as_str().map(String::from)) {
        if valid_id(&id) {
            return Ok(json!({ "id": id, "name": name }));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({ "version": 1, "id": id })).map_err(err)?
    );
    write_atomic(&file, body.as_bytes())?;
    Ok(json!({ "id": id, "name": name }))
}

// prepares an empty folder to become a copy of a vault on another computer
pub fn prepare_copy(dir: &str, vault_id: &str) -> Value {
    let path = Path::new(dir);
    if !path.is_absolute() || !valid_id(vault_id) {
        return json!({ "ok": false, "error": "Invalid folder." });
    }
    let Ok(entries) = fs::read_dir(path) else {
        return json!({ "ok": false, "error": "That folder does not exist." });
    };
    if entries
        .flatten()
        .any(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
    {
        return json!({ "ok": false, "error": "Choose an empty folder for the copy." });
    }
    let body = format!("{}\n", json!({ "version": 1, "id": vault_id }));
    match paths::write_atomic_plain(&path.join(".morrow").join("vault.json"), body.as_bytes()) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

pub fn read_sync_base(peer_id: &str) -> Value {
    let Some(root) = current().filter(|_| valid_id(peer_id)) else {
        return json!({});
    };
    paths::read_json(
        &root
            .join(".morrow")
            .join("sync")
            .join(format!("{peer_id}.json")),
    )
    .map(|raw| raw["files"].clone())
    .filter(Value::is_object)
    .unwrap_or_else(|| json!({}))
}

pub fn write_sync_base(peer_id: &str, files: Value) -> Result<()> {
    let Some(root) = current().filter(|_| valid_id(peer_id) && files.is_object()) else {
        return Ok(());
    };
    let body = json!({ "version": 1, "files": files }).to_string();
    write_atomic(
        &root
            .join(".morrow")
            .join("sync")
            .join(format!("{peer_id}.json")),
        body.as_bytes(),
    )
}

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

// pictures, sound, video and pdfs open in the app the system uses for them. nothing that could run as a
// program is ever opened this way, whatever is in the vault
pub fn openable(path: &str) -> bool {
    matches!(
        extension(path).as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "avif"
            | "bmp"
            | "svg"
            | "ico"
            | "tif"
            | "tiff"
            | "heic"
            | "mp3"
            | "m4a"
            | "wav"
            | "ogg"
            | "oga"
            | "flac"
            | "aac"
            | "opus"
            | "mp4"
            | "m4v"
            | "webm"
            | "mov"
            | "mkv"
            | "pdf"
    )
}

// documents a link in a page can open straight away. anything else, a program above all, is only shown in
// its folder, so a link can never run something
fn openable_document(path: &str) -> bool {
    matches!(
        extension(path).as_str(),
        "txt"
            | "md"
            | "markdown"
            | "csv"
            | "rtf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "epub"
            | "htm"
            | "html"
            | "json"
            | "xml"
            | "zip"
            | "7z"
            | "rar"
            | "tar"
            | "gz"
    )
}

pub enum LinkAction {
    Open(PathBuf),
    Reveal(PathBuf),
}

// a link to a file or folder on the computer: file:// addresses, paths from the home folder or a drive, and
// paths relative to the page the link is in, like ../Reading/paper.pdf
pub fn local_link(href: &str, page_path: Option<&str>) -> Option<LinkAction> {
    let value = href.trim();
    if value.is_empty() {
        return None;
    }
    let target = if value.to_ascii_lowercase().starts_with("file:") {
        url::Url::parse(value).ok()?.to_file_path().ok()?
    } else {
        let decoded = percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .ok()?
            .into_owned();
        if let Some(rest) = decoded
            .strip_prefix("~/")
            .or_else(|| decoded.strip_prefix("~\\"))
        {
            paths::home_dir().join(rest)
        } else if Path::new(&decoded).is_absolute() {
            PathBuf::from(decoded)
        } else {
            let (root, _) = roots().ok()?;
            let from = match page_path.filter(|path| !path.is_empty()) {
                Some(page) => resolve_in(&root, page).ok()?.parent()?.to_path_buf(),
                None => root,
            };
            normalize(&from.join(decoded))
        }
    };
    let info = fs::metadata(&target).ok()?;
    let text = target.to_string_lossy();
    if info.is_dir() || openable(&text) || openable_document(&text) {
        Some(LinkAction::Open(target))
    } else {
        Some(LinkAction::Reveal(target))
    }
}

// the absolute path of a vault file for the file protocol, None when it is outside the vault
pub fn file_path(relative: &str) -> Option<PathBuf> {
    resolve(relative).ok()
}

// changes are gathered for a moment, then each path is looked at once
fn start_watching(
    root: &Path,
    on_changes: impl Fn(Vec<Value>) + Send + 'static,
) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let (send, receive) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            for path in event.paths {
                let _ = send.send(path);
            }
        }
    })
    .ok()?;
    watcher.watch(root, RecursiveMode::Recursive).ok()?;
    let root = root.to_path_buf();
    std::thread::spawn(move || loop {
        // the channel closes when the watcher is dropped, which ends this thread
        let Ok(first) = receive.recv() else { return };
        let mut pending: HashSet<PathBuf> = HashSet::from([first]);
        while let Ok(more) = receive.recv_timeout(Duration::from_millis(150)) {
            pending.insert(more);
        }
        let mut changes = Vec::new();
        for absolute in pending {
            let relative = to_relative(&root, &absolute);
            if relative.is_empty() || relative.contains(TEMP_MARK) || is_hidden(&relative) {
                continue;
            }
            describe(&root, &absolute, &relative, &mut changes, 0);
        }
        if !changes.is_empty() {
            on_changes(changes);
        }
    });
    Some(watcher)
}

fn describe(root: &Path, absolute: &Path, relative: &str, changes: &mut Vec<Value>, depth: usize) {
    let Ok(info) = fs::symlink_metadata(absolute) else {
        let page = is_page(relative);
        changes.push(json!({
            "path": relative,
            "text": null,
            "mtime": paths::now_ms(),
            "birthtime": 0,
            "dir": !page,
            "other": !page,
        }));
        return;
    };
    if info.file_type().is_symlink() {
        return;
    }
    if info.is_dir() {
        // a folder moved in from elsewhere arrives as one event, its contents are reported one by one
        if depth > 16 {
            return;
        }
        let Ok(entries) = fs::read_dir(absolute) else {
            return;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            let child_relative = to_relative(root, &child);
            if entry.file_name().to_string_lossy().contains(TEMP_MARK) || is_hidden(&child_relative)
            {
                continue;
            }
            describe(root, &child, &child_relative, changes, depth + 1);
        }
    } else if info.is_file() {
        let mtime = millis(info.modified());
        let birthtime = birth(&info);
        if !is_page(relative) {
            changes.push(json!({ "path": relative, "text": "", "mtime": mtime, "birthtime": birthtime, "other": true }));
        } else if info.len() <= MAX_TEXT_BYTES {
            if let Ok(bytes) = fs::read(absolute) {
                changes.push(json!({
                    "path": relative,
                    "text": String::from_utf8_lossy(&bytes),
                    "mtime": mtime,
                    "birthtime": birthtime,
                }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    static LIFECYCLE_TESTS: Mutex<()> = Mutex::new(());

    fn lifecycle_guard() -> std::sync::MutexGuard<'static, ()> {
        LIFECYCLE_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn metadata_test_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "morrow-files-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn metadata_snapshot_for(root: &Path, generation: u64) -> OpenSnapshot {
        let real_root = dunce::canonicalize(root).unwrap();
        let metadata_root = Some(open_catalog_root(&real_root).unwrap());
        OpenSnapshot {
            real_root,
            generation,
            metadata_root,
        }
    }

    #[test]
    fn paths_stay_inside_the_vault() {
        let root = Path::new("/notes");
        assert_eq!(
            resolve_in(root, "a/b.md").unwrap(),
            Path::new("/notes/a/b.md")
        );
        assert!(resolve_in(root, "../etc/passwd").is_err());
        assert!(resolve_in(root, "a/../../x").is_err());
        assert!(resolve_in(root, "/etc/passwd").is_err());
        assert!(resolve_in(root, "a\\b").is_err());
        assert!(resolve_in(root, "").is_err());
        assert_eq!(
            resolve_in(root, "a/../b.md").unwrap(),
            Path::new("/notes/b.md")
        );
    }

    #[test]
    fn metadata_pages_list_only_immediate_visible_children() {
        let root = metadata_test_root("children");
        fs::create_dir(root.join("Empty")).unwrap();
        fs::create_dir_all(root.join("nested/deeper")).unwrap();
        fs::write(root.join("nested/child.bin"), b"child").unwrap();
        fs::write(root.join("nested/deeper/grandchild.bin"), b"grandchild").unwrap();
        fs::write(root.join("asset"), b"not opened").unwrap();
        fs::write(root.join("photo.png"), b"image bytes").unwrap();
        fs::create_dir(root.join("folder.md")).unwrap();
        fs::write(root.join("note.MD"), b"note").unwrap();
        fs::write(root.join("board.CANVAS"), b"canvas").unwrap();
        fs::create_dir(root.join(".morrow")).unwrap();
        fs::create_dir(root.join(".trash")).unwrap();
        fs::write(root.join(".hidden.png"), b"hidden").unwrap();
        fs::write(root.join(".morrow-tmp-writing"), b"temp").unwrap();
        fs::write(root.join("image.morrow-move-stage"), b"temp").unwrap();
        #[cfg(unix)]
        fs::write(root.join("invalid\\catalog-name.bin"), b"excluded by resolve_in rules").unwrap();

        let snapshot = metadata_snapshot_for(&root, 41);
        let page = metadata_for_directory(&snapshot, "", None, Some(500));
        assert_eq!(page.status, FilePageStatus::Ready);
        assert_eq!(page.entries.len(), 5);
        assert_eq!(
            page.entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            vec!["Empty", "asset", "folder.md", "nested", "photo.png"]
        );
        assert_eq!(page.entries[1].kind, "file");
        assert_eq!(page.entries[1].size, Some(10));
        assert_eq!(page.entries[0].kind, "folder");
        assert_eq!(page.entries[0].size, None);

        let empty = metadata_for_directory(&snapshot, "Empty", None, None);
        assert_eq!(empty.status, FilePageStatus::Empty);
        assert!(empty.entries.is_empty());
        let nested = metadata_for_directory(&snapshot, "nested", None, None);
        assert_eq!(nested.status, FilePageStatus::Ready);
        assert_eq!(nested.entries.len(), 2);
        assert_eq!(nested.entries[0].name, "child.bin");
        assert_eq!(nested.entries[1].name, "deeper");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_pages_are_stably_paginated_and_cursors_bind_generation_and_directory() {
        let root = metadata_test_root("pages");
        for number in 0..205 {
            fs::write(root.join(format!("item-{number:03}.bin")), b"").unwrap();
        }
        fs::create_dir(root.join("subfolder")).unwrap();
        let snapshot = metadata_snapshot_for(&root, 92);

        let first = metadata_for_directory(&snapshot, "", None, Some(999));
        let repeated = metadata_for_directory(&snapshot, "", None, Some(999));
        assert_eq!(first.status, FilePageStatus::Ready);
        assert_eq!(first.entries.len(), MAX_PAGE_SIZE);
        assert_eq!(
            first.entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            repeated.entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(first.entries[0].name, "item-000.bin");
        assert_eq!(first.entries[199].name, "item-199.bin");
        let cursor = first.next_cursor.as_deref().unwrap();
        let second = metadata_for_directory(&snapshot, "", Some(cursor), Some(200));
        assert_eq!(second.entries.len(), 6);
        assert_eq!(second.entries[0].name, "item-200.bin");
        assert_eq!(second.entries[4].name, "item-204.bin");
        assert_eq!(second.entries[5].name, "subfolder");
        assert!(second.next_cursor.is_none());

        let reopened = metadata_snapshot_for(&root, 93);
        assert_eq!(
            metadata_for_directory(&reopened, "", Some(cursor), Some(200)).status,
            FilePageStatus::Stale
        );
        assert_eq!(
            metadata_for_directory(&snapshot, "subfolder", Some(cursor), Some(200)).status,
            FilePageStatus::Blocked
        );
        assert_eq!(
            metadata_for_directory(&snapshot, "", Some("not-a-cursor"), Some(200)).status,
            FilePageStatus::Blocked
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cursor_roundtrips_for_long_escaped_directories_and_rejects_unaddressable_children() {
        let root = metadata_test_root("long-cursor");
        let mut absolute = root.clone();
        let mut parts = Vec::new();
        for index in 0..15 {
            let part = if index == 0 {
                "escaped\n\"folder".to_owned()
            } else {
                format!("d{index}-{}", "x".repeat(205))
            };
            absolute.push(&part);
            fs::create_dir(&absolute).unwrap();
            parts.push(part);
        }
        let directory = parts.join("/");
        assert!(directory.len() > 2800);
        fs::write(absolute.join("a\n\"😀.bin"), b"first").unwrap();
        fs::write(absolute.join("z.bin"), b"second").unwrap();

        let snapshot = metadata_snapshot_for(&root, 307);
        let first = metadata_for_directory(&snapshot, &directory, None, Some(1));
        assert_eq!(first.status, FilePageStatus::Ready);
        let cursor = first.next_cursor.as_deref().unwrap();
        assert!(cursor.len() < 4096);
        let encoded_body = URL_SAFE_NO_PAD.decode(cursor).unwrap();
        assert!(!encoded_body.windows(directory.len()).any(|part| part == directory.as_bytes()));
        let second = metadata_for_directory(&snapshot, &directory, Some(cursor), Some(1));
        assert_eq!(second.status, FilePageStatus::Ready);
        assert_eq!(second.entries.len(), 1);
        assert!(second.next_cursor.is_none());

        assert!(relative_child_path(Path::new("/root"), &"a".repeat(4094), "x").is_some());
        assert!(relative_child_path(Path::new("/root"), &"a".repeat(4095), "x").is_none());
        assert!(relative_child_path(Path::new("/root"), "folder", "bad\\name").is_none());
        assert!(relative_child_path(
            Path::new("/root"),
            "folder",
            &"x".repeat(MAX_CURSOR_NAME_BYTES + 1)
        )
        .is_none());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_paths_distinguish_missing_blocked_and_io_failures() {
        let root = metadata_test_root("errors");
        fs::write(root.join("file.bin"), b"").unwrap();
        fs::create_dir(root.join("visible")).unwrap();
        let snapshot = metadata_snapshot_for(&root, 16);

        assert_eq!(
            metadata_for_directory(&snapshot, "absent", None, None).status,
            FilePageStatus::NotFound
        );
        assert_eq!(
            metadata_for_directory(&snapshot, "file.bin", None, None).status,
            FilePageStatus::Blocked
        );
        assert_eq!(
            metadata_for_directory(&snapshot, "../outside", None, None).status,
            FilePageStatus::Blocked
        );
        assert_eq!(
            metadata_for_directory(&snapshot, ".morrow", None, None).status,
            FilePageStatus::Blocked
        );
        assert_eq!(
            path_error_status(&std::io::Error::from(std::io::ErrorKind::NotFound)),
            FilePageStatus::NotFound
        );
        assert_eq!(
            path_error_status(&std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            FilePageStatus::Blocked
        );
        assert_eq!(
            path_error_status(&std::io::Error::from(std::io::ErrorKind::Other)),
            FilePageStatus::IoError
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn metadata_pages_discard_symlinks_and_reject_external_directory_aliases() {
        let _lifecycle = lifecycle_guard();
        let root = metadata_test_root("symlink-root");
        let external = metadata_test_root("symlink-outside");
        fs::write(external.join("secret.bin"), b"secret").unwrap();
        std::os::unix::fs::symlink(&external, root.join("outside")).unwrap();
        let snapshot = metadata_snapshot_for(&root, 23);

        let page = metadata_for_directory(&snapshot, "", None, None);
        assert_eq!(page.status, FilePageStatus::Empty);
        assert!(page.entries.is_empty());
        assert_eq!(
            metadata_for_directory(&snapshot, "outside", None, None).status,
            FilePageStatus::Blocked
        );

        let selected = parent_for_selected_root(&root);
        std::os::unix::fs::symlink(&root, &selected).unwrap();
        let generation = open(selected.to_str().unwrap(), |_| {}).unwrap();
        assert_eq!(current().as_deref(), Some(selected.as_path()));
        assert_eq!(
            list_metadata_page(generation, "", None, None).status,
            FilePageStatus::Empty
        );
        close();

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
        fs::remove_file(selected).unwrap();
    }

    #[test]
    fn unavailable_catalog_does_not_close_the_open_vault_session() {
        let _lifecycle = lifecycle_guard();
        close();
        let root = metadata_test_root("catalog-unavailable");
        let real_root = dunce::canonicalize(&root).unwrap();
        let generation = advance_generation();
        *OPEN.lock().unwrap() = Some(Open {
            root: root.clone(),
            real_root,
            generation,
            metadata_root: None,
            _watcher: None,
        });

        assert_eq!(current().as_deref(), Some(root.as_path()));
        let page = list_metadata_page(generation, "", None, None);
        assert_eq!(page.status, FilePageStatus::Unavailable);
        assert_eq!(page.generation, generation);

        close();
        fs::remove_dir_all(root).unwrap();
    }

    fn parent_for_selected_root(root: &Path) -> PathBuf {
        root.with_extension("selected")
    }

    #[test]
    fn selected_vault_lifecycle_stales_metadata_but_keeps_open_root_writable() {
        let _lifecycle = lifecycle_guard();
        close();
        let parent = metadata_test_root("lifecycle");
        let list_file = parent.join("vaults.json");
        let first_root = parent.join("first").join("same-name");
        let second_root = parent.join("second").join("same-name");
        fs::create_dir_all(&first_root).unwrap();
        fs::create_dir_all(&second_root).unwrap();
        fs::write(first_root.join("first.bin"), b"one").unwrap();
        fs::write(second_root.join("second.bin"), b"two").unwrap();
        let first_text = first_root.to_string_lossy().into_owned();
        let second_text = second_root.to_string_lossy().into_owned();
        write_list_at(
            &list_file,
            &VaultList {
                current: Some(first_text.clone()),
                recent: vec![(first_text.clone(), 0.0)],
            },
        )
        .unwrap();

        let first_reservation = reserve_current_open_at(&list_file).unwrap();
        let opened = open_reserved(first_reservation, |_| {}).unwrap();
        assert_eq!(opened["ok"], true);
        let first_generation = opened["generation"].as_u64().unwrap();
        assert_eq!(
            list_metadata_page(first_generation, "", None, None).entries[0].name,
            "first.bin"
        );

        let no_op = select_at(&first_text, &list_file);
        assert!(no_op.ok);
        assert!(!no_op.current_changed);
        assert_eq!(no_op.session_generation, Some(first_generation));
        let failed = select_at("relative-path", &list_file);
        assert!(!failed.ok);
        assert_eq!(failed.session_generation, Some(first_generation));

        let changed = select_at(&second_text, &list_file);
        assert!(changed.ok);
        assert!(changed.current_changed);
        assert_eq!(changed.session_generation, None);
        assert_eq!(current().as_deref(), Some(first_root.as_path()));
        assert_eq!(
            list_metadata_page(first_generation, "", None, None).status,
            FilePageStatus::Stale
        );
        assert_eq!(
            apply(json!([{
                "op": "write",
                "path": "pending-after-select.md",
                "text": "saved after selection",
                "expect": null
            }]))[0]["ok"],
            true
        );
        assert_eq!(
            fs::read_to_string(first_root.join("pending-after-select.md")).unwrap(),
            "saved after selection"
        );

        let forgotten = forget_at(&second_text, &list_file);
        assert!(forgotten.ok);
        assert!(forgotten.current_changed);
        assert_eq!(forgotten.session_generation, None);
        assert_eq!(current().as_deref(), Some(first_root.as_path()));
        assert_eq!(
            list_metadata_page(forgotten.generation, "", None, None).status,
            FilePageStatus::Stale
        );
        assert_eq!(
            apply(json!([{
                "op": "write",
                "path": "pending-after-forget.md",
                "text": "saved after forget",
                "expect": null
            }]))[0]["ok"],
            true
        );
        assert_eq!(
            fs::read_to_string(first_root.join("pending-after-forget.md")).unwrap(),
            "saved after forget"
        );

        let selected_again = select_at(&second_text, &list_file);
        assert!(selected_again.ok);
        assert!(selected_again.current_changed);
        assert_eq!(current().as_deref(), Some(first_root.as_path()));
        close();
        assert!(current().is_none());

        let second_reservation = reserve_current_open_at(&list_file).unwrap();
        let opened = open_reserved(second_reservation, |_| {}).unwrap();
        let second_generation = opened["generation"].as_u64().unwrap();
        assert_eq!(opened["root"], second_text);
        assert_eq!(
            list_metadata_page(second_generation, "", None, None).entries[0].name,
            "second.bin"
        );

        let unrelated_forget = forget_at(&first_text, &list_file);
        assert!(unrelated_forget.ok);
        assert!(!unrelated_forget.current_changed);
        assert_eq!(unrelated_forget.session_generation, Some(second_generation));
        let current_forget = forget_at(&second_text, &list_file);
        assert!(current_forget.ok);
        assert!(current_forget.current_changed);
        assert_eq!(current_forget.session_generation, None);
        assert_eq!(current().as_deref(), Some(second_root.as_path()));
        assert_eq!(
            list_metadata_page(second_generation, "", None, None).status,
            FilePageStatus::Stale
        );
        assert_eq!(
            apply(json!([{
                "op": "write",
                "path": "pending-after-current-forget.md",
                "text": "saved after forgetting current",
                "expect": null
            }]))[0]["ok"],
            true
        );
        assert_eq!(
            fs::read_to_string(second_root.join("pending-after-current-forget.md")).unwrap(),
            "saved after forgetting current"
        );

        close();
        assert!(current().is_none());
        let selected_again = select_at(&second_text, &list_file);
        assert!(selected_again.ok);
        let reopened = open_reserved(reserve_current_open_at(&list_file).unwrap(), |_| {}).unwrap();
        let reopened_generation = reopened["sessionGeneration"].as_u64().unwrap();
        assert_eq!(current().as_deref(), Some(second_root.as_path()));
        assert_eq!(reopened["root"], second_text);
        assert_eq!(
            list_metadata_page(reopened_generation, "", None, None).entries[0].name,
            "second.bin"
        );
        close();
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn a_reserved_open_worker_cannot_reopen_after_a_later_close() {
        let _lifecycle = lifecycle_guard();
        close();
        let parent = metadata_test_root("open-close-order");
        let list_file = parent.join("vaults.json");
        let root = parent.join("vault");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("asset.bin"), b"asset").unwrap();
        let root_text = root.to_string_lossy().into_owned();
        write_list_at(
            &list_file,
            &VaultList {
                current: Some(root_text.clone()),
                recent: vec![(root_text, 0.0)],
            },
        )
        .unwrap();

        let reservation = reserve_current_open_at(&list_file).unwrap();
        let reserved_generation = reservation.generation;
        let start = Arc::new(Barrier::new(2));
        let continue_open = Arc::new(Barrier::new(2));
        let worker_start = Arc::clone(&start);
        let worker_continue = Arc::clone(&continue_open);
        let worker = std::thread::spawn(move || {
            worker_start.wait();
            worker_continue.wait();
            open_reserved(reservation, |_| {})
        });
        start.wait();
        close();
        continue_open.wait();
        let result = worker.join().unwrap().unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["generation"].as_u64(), Some(current_generation()));
        assert!(current().is_none());
        assert_eq!(
            list_metadata_page(reserved_generation, "", None, None).status,
            FilePageStatus::Stale
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn generation_change_discards_an_already_built_page() {
        let populated = VaultFilePage {
            generation: 4,
            status: FilePageStatus::Ready,
            entries: vec![VaultFileMetadata {
                name: "asset.bin".into(),
                path: "asset.bin".into(),
                kind: "file".into(),
                size: Some(1),
                modified: None,
            }],
            next_cursor: Some("cursor".into()),
            error: None,
        };
        let stale = stale_if_generation_changed(populated, 4, 5);
        assert_eq!(stale.generation, 5);
        assert_eq!(stale.status, FilePageStatus::Stale);
        assert!(stale.entries.is_empty());
        assert!(stale.next_cursor.is_none());
    }

    #[test]
    fn reopening_and_closing_vaults_invalidate_metadata_sessions() {
        let _lifecycle = lifecycle_guard();
        let parent = metadata_test_root("session");
        let first_root = parent.join("first").join("same-name");
        let second_root = parent.join("second").join("same-name");
        fs::create_dir_all(&first_root).unwrap();
        fs::create_dir_all(&second_root).unwrap();
        fs::write(first_root.join("a.bin"), b"a").unwrap();
        fs::write(first_root.join("b.bin"), b"b").unwrap();
        fs::write(second_root.join("other.bin"), b"other").unwrap();
        let first_root_text = first_root.to_string_lossy().into_owned();
        let second_root_text = second_root.to_string_lossy().into_owned();

        let first_generation = open(&first_root_text, |_| {}).unwrap();
        let first_page = list_metadata_page(first_generation, "", None, Some(1));
        let old_cursor = first_page.next_cursor.as_deref().unwrap().to_owned();
        assert_eq!(
            first_page.status,
            FilePageStatus::Ready
        );

        let second_generation = open(&first_root_text, |_| {}).unwrap();
        assert_ne!(first_generation, second_generation);
        assert_eq!(
            list_metadata_page(first_generation, "", None, None).status,
            FilePageStatus::Stale
        );
        assert_eq!(
            list_metadata_page(second_generation, "", Some(&old_cursor), Some(1)).status,
            FilePageStatus::Stale
        );
        assert_eq!(
            list_metadata_page(second_generation, "", None, None).status,
            FilePageStatus::Ready
        );

        let third_generation = open(&second_root_text, |_| {}).unwrap();
        assert_ne!(second_generation, third_generation);
        assert_eq!(
            list_metadata_page(second_generation, "", None, None).status,
            FilePageStatus::Stale
        );
        assert_eq!(
            list_metadata_page(third_generation, "", None, None).status,
            FilePageStatus::Ready
        );

        close();
        assert_eq!(
            list_metadata_page(third_generation, "", None, None).status,
            FilePageStatus::Stale
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn hidden_and_synced_paths() {
        assert!(is_hidden(".morrow/history/x.json"));
        assert!(!is_hidden(".trash/Old.md"));
        assert!(is_hidden("a/.trash/x"));
        assert!(is_synced_path(".morrow/workspace.json"));
        assert!(!is_synced_path(".morrow/recent.json"));
        assert!(is_synced_path(".morrow/tag-colors.json"));
        assert!(is_synced_path(".morrow/sidebar-sections.json"));
        assert!(is_synced_path(".morrow/calendars.json"));
        assert!(is_synced_path(".morrow/emoji/party_cat.png"));
        assert!(is_synced_path("Notes/Page.md"));
    }

    #[test]
    fn ops_keep_undefined_and_null_apart() {
        let missing: VaultOp =
            serde_json::from_value(json!({ "op": "write", "path": "a.md", "text": "" })).unwrap();
        let null: VaultOp = serde_json::from_value(
            json!({ "op": "write", "path": "a.md", "text": "", "expect": null }),
        )
        .unwrap();
        assert!(matches!(missing, VaultOp::Write { expect: None, .. }));
        assert!(matches!(
            null,
            VaultOp::Write {
                expect: Some(None),
                ..
            }
        ));

        let check_missing: VaultOp =
            serde_json::from_value(json!({ "op": "check", "path": "a.md" })).unwrap();
        let check_null: VaultOp = serde_json::from_value(json!({
            "op": "check",
            "path": "a.md",
            "expect": null
        }))
        .unwrap();
        assert!(matches!(check_missing, VaultOp::Check { expect: None, .. }));
        assert!(matches!(
            check_null,
            VaultOp::Check {
                expect: Some(None),
                ..
            }
        ));
    }

    #[test]
    fn check_ops_compare_existing_and_missing_files_without_mutating_them() {
        let root = std::env::temp_dir().join(format!("morrow-check-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let existing = root.join("workspace.json");
        let missing = root.join("recent.json");
        let original = "{\n  \"pages\": {}\n}\n";
        fs::write(&existing, original).unwrap();
        let before = fs::read(&existing).unwrap();

        assert_eq!(
            check_path(
                ".morrow/workspace.json",
                &existing,
                Some(original.to_string())
            )
            .unwrap(),
            json!({ "ok": true }),
        );
        let mismatch = check_path(
            ".morrow/workspace.json",
            &existing,
            Some("stale".to_string()),
        )
        .unwrap();
        assert_eq!(mismatch["code"], "conflict");
        assert_eq!(mismatch["current"], original);
        assert_eq!(
            check_path(".morrow/recent.json", &missing, None).unwrap(),
            json!({ "ok": true })
        );
        let missing_mismatch = check_path(
            ".morrow/recent.json",
            &missing,
            Some("expected".to_string()),
        )
        .unwrap();
        assert_eq!(missing_mismatch["code"], "conflict");
        assert!(missing_mismatch["current"].is_null());

        assert_eq!(fs::read(&existing).unwrap(), before);
        assert!(!missing.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
