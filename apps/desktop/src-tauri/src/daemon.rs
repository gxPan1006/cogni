//! Runner-host daemon lifecycle: register the host with the cloud and spawn
//! the bundled `cogni-runner-host` sidecar.
//!
//! Tauri commands exposed to the frontend (see `Shell.tsx`):
//!   - `has_host_config`  — checks whether this machine has runner-host creds
//!   - `write_host_config` — persists `~/.cogni/host.json`
//!   - `ensure_daemon`     — spawns the sidecar unless a live one is recorded

use std::fs;
use std::path::PathBuf;

use tauri_plugin_shell::ShellExt;

/// Resolve the Cogni home directory (`~/.cogni`), overridable via `COGNI_HOME`.
/// The runner-host daemon reads `host.json` from this same location.
fn cogni_home() -> PathBuf {
    std::env::var("COGNI_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .expect("could not resolve home directory")
                .join(".cogni")
        })
}

/// Whether this machine has local runner-host credentials.
#[tauri::command]
pub fn has_host_config() -> bool {
    cogni_home().join("host.json").is_file()
}

/// Write `~/.cogni/host.json` with the credentials the runner-host needs to
/// connect to the cloud. Called once on first login when the user has no host,
/// or when cloud still has old host rows but local state was deleted.
#[tauri::command]
pub fn write_host_config(
    host_id: String,
    registration_token: String,
    cloud_url: String,
) -> Result<(), String> {
    let dir = cogni_home();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    stop_recorded_daemon(&dir)?;
    let cfg = serde_json::json!({
        "hostId": host_id,
        "registrationToken": registration_token,
        "cloudUrl": cloud_url,
    });
    fs::write(
        dir.join("host.json"),
        serde_json::to_string_pretty(&cfg).unwrap(),
    )
    .map_err(|e| e.to_string())
}

fn stop_recorded_daemon(dir: &PathBuf) -> Result<(), String> {
    let pid_file = dir.join("daemon.pid");
    if let Ok(pid_str) = fs::read_to_string(&pid_file) {
        if let Ok(pid) = pid_str.trim().parse::<i32>() {
            terminate(pid);
        }
    }
    match fs::remove_file(pid_file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Ensure the runner-host daemon is running. Returns `Ok(true)` if a new
/// process was spawned, `Ok(false)` if a live one was already recorded.
///
/// The daemon's pid is recorded in `~/.cogni/daemon.pid`; on later launches a
/// live pid short-circuits so we never double-spawn.
#[tauri::command]
pub fn ensure_daemon(app: tauri::AppHandle) -> Result<bool, String> {
    let pid_file = cogni_home().join("daemon.pid");
    // If a live pid is recorded, do nothing.
    if let Ok(pid_str) = fs::read_to_string(&pid_file) {
        if let Ok(pid) = pid_str.trim().parse::<i32>() {
            if is_alive(pid) {
                return Ok(false); // already running
            }
        }
    }
    // Spawn the bundled sidecar and record its pid. `spawn()` returns
    // `(Receiver<CommandEvent>, CommandChild)`; we drop the receiver because we
    // don't consume the sidecar's stdout/stderr event stream here.
    // SP-1 limitation: this sidecar is tracked by `tauri-plugin-shell` and is
    // tied to the desktop app's lifetime — it does NOT survive the app closing.
    // A truly independent daemon (OS login-item / detached process that outlives
    // the UI) is an SP-4 concern.
    let (_rx, child) = app
        .shell()
        .sidecar("cogni-runner-host")
        .map_err(|e| e.to_string())?
        .spawn()
        .map_err(|e| e.to_string())?;
    fs::write(&pid_file, child.pid().to_string()).map_err(|e| e.to_string())?;
    Ok(true) // spawned
}

/// On Unix, `kill(pid, 0)` probes for a live process without signalling it.
/// SP-1 limitation: this only proves *some* process holds that PID — if the
/// daemon died and the OS recycled its PID we get a false "alive". Acceptable
/// for SP-1 (narrow window, self-heals on relaunch); a robust check
/// (lockfile / process-name verification) is SP-4.
#[cfg(unix)]
fn is_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(unix)]
fn terminate(pid: i32) {
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}

/// SP-1 Windows stopgap: assume alive. SP-4 adds a real liveness check.
#[cfg(windows)]
fn is_alive(_pid: i32) -> bool {
    true
}

#[cfg(windows)]
fn terminate(_pid: i32) {}
