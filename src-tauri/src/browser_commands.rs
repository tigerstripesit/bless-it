// Browser-use harness: Tauri-side supervisor for the Playwright sidecar.
//
// The sidecar (src-tauri/sidecar/browser) is a small Node process that owns
// Chromium and exposes a JSON-RPC 2.0 wire protocol over stdio. This module:
//
//   1. Spawns the sidecar lazily on the first browser_rpc call.
//   2. Forwards `{method, params}` to the sidecar and awaits the response.
//   3. Emits unsolicited sidecar→host frames (notifications) as Tauri events
//      so the UI can stream live screenshots.
//   4. Cleans up on app exit.
//
// In M1 only the read-only methods (open/navigate/observe/close) are wired —
// browser_classify gating arrives with browser_act in M2, so this module
// does NOT enforce risk classification yet; it simply proxies the call.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const SIDECAR_REL_DEV: &str = "sidecar/browser/dist/index.js";
const SIDECAR_REL_DEV_TS: &str = "sidecar/browser/src/index.ts";
const RPC_TIMEOUT_SECS: u64 = 45;
const FRAME_EVENT: &str = "browser-frame";

/// Pending RPC waiting on its response. Keyed by the JSON-RPC id we sent.
type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

#[derive(Default)]
struct SupervisorInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    pending: PendingMap,
    next_id: u64,
}

#[derive(Default)]
pub struct BrowserSupervisor {
    inner: Arc<Mutex<SupervisorInner>>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRpcRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Best-effort resolution of the sidecar entry point. In dev we run the
/// pre-built JS from the Tauri working directory (src-tauri/); production
/// packaging via Tauri externalBin is M1.x follow-up work.
fn resolve_sidecar_entry() -> Result<PathBuf> {
    // First try compiled JS.
    let js = std::env::current_dir()?.join(SIDECAR_REL_DEV);
    if js.exists() {
        return Ok(js);
    }
    // Fall back to source via tsx (requires devDependency to be installed).
    let ts = std::env::current_dir()?.join(SIDECAR_REL_DEV_TS);
    if ts.exists() {
        return Ok(ts);
    }
    Err(anyhow!(
        "browser sidecar not found at {} or {} — run `npm install && npm run build` in src-tauri/sidecar/browser",
        SIDECAR_REL_DEV,
        SIDECAR_REL_DEV_TS
    ))
}

fn build_command(entry: &PathBuf) -> Result<Command> {
    let is_ts = entry.extension().and_then(|e| e.to_str()) == Some("ts");
    let mut cmd = if is_ts {
        // npx tsx <entry>
        let mut c = Command::new("npx");
        c.args(["tsx", entry.to_string_lossy().as_ref()]);
        c
    } else {
        let mut c = Command::new("node");
        c.arg(entry);
        c
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    Ok(cmd)
}

async fn ensure_spawned(
    inner: Arc<Mutex<SupervisorInner>>,
    app: &AppHandle,
) -> Result<(), String> {
    {
        let guard = inner.lock().await;
        if guard.child.is_some() && guard.stdin.is_some() {
            return Ok(());
        }
    }

    let entry = resolve_sidecar_entry().map_err(|e| e.to_string())?;
    log::info!("spawning browser sidecar: {}", entry.display());

    let mut cmd = build_command(&entry).map_err(|e| e.to_string())?;
    let mut child = cmd.spawn().map_err(|e| {
        format!("failed to spawn browser sidecar ({}): {}", entry.display(), e)
    })?;

    let stdin = child.stdin.take().ok_or_else(|| "sidecar stdin missing".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "sidecar stdout missing".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "sidecar stderr missing".to_string())?;

    // Stderr drainer — sidecar logs to stderr so they don't pollute the
    // JSON-RPC stream. Pipe them into our logger so they show up alongside
    // Rust logs.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::info!("[browser-sidecar] {}", line);
        }
    });

    // Stdout reader — parse JSON-RPC frames and route to pending callers or
    // emit as Tauri events for notifications.
    let inner_for_reader = Arc::clone(&inner);
    let app_for_reader = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let frame: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("sidecar emitted unparseable line: {} ({})", trimmed, e);
                    continue;
                }
            };

            let id_opt = frame.get("id").and_then(|v| v.as_u64());
            if let Some(id) = id_opt {
                // Response to a pending request.
                let pending_sender = {
                    let mut guard = inner_for_reader.lock().await;
                    guard.pending.remove(&id)
                };
                if let Some(tx) = pending_sender {
                    let result = if let Some(err) = frame.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("sidecar error")
                            .to_string();
                        Err(msg)
                    } else {
                        Ok(frame.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(result);
                } else {
                    log::warn!("sidecar response for unknown id {}: {}", id, trimmed);
                }
            } else if frame.get("method").is_some() {
                // Notification — forward to the frontend as a Tauri event.
                if let Err(e) = app_for_reader.emit(FRAME_EVENT, frame.clone()) {
                    log::warn!("failed to emit browser-frame: {}", e);
                }
            }
        }
        log::info!("browser sidecar stdout closed");
    });

    {
        let mut guard = inner.lock().await;
        guard.child = Some(child);
        guard.stdin = Some(stdin);
    }
    Ok(())
}

async fn next_id(inner: &Arc<Mutex<SupervisorInner>>) -> u64 {
    let mut guard = inner.lock().await;
    guard.next_id = guard.next_id.wrapping_add(1);
    if guard.next_id == 0 {
        guard.next_id = 1;
    }
    guard.next_id
}

async fn send_rpc(
    inner: Arc<Mutex<SupervisorInner>>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let id = next_id(&inner).await;
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = inner.lock().await;
        guard.pending.insert(id, tx);
    }

    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let mut line = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
    line.push('\n');

    {
        let mut guard = inner.lock().await;
        let stdin = guard
            .stdin
            .as_mut()
            .ok_or_else(|| "sidecar stdin closed".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("failed to write to sidecar: {}", e))?;
        stdin.flush().await.map_err(|e| e.to_string())?;
    }

    match tokio::time::timeout(std::time::Duration::from_secs(RPC_TIMEOUT_SECS), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("sidecar dropped response channel".to_string()),
        Err(_) => {
            // Best-effort cleanup of the pending slot.
            let mut guard = inner.lock().await;
            guard.pending.remove(&id);
            Err(format!("sidecar timeout after {}s", RPC_TIMEOUT_SECS))
        }
    }
}

#[command]
pub async fn browser_rpc(
    app: AppHandle,
    request: BrowserRpcRequest,
    state: State<'_, BrowserSupervisor>,
    recorder: State<'_, crate::workflow_recorder::WorkflowRecorder>,
    capabilities: State<'_, crate::browser_capability::BrowserCapabilityState>,
) -> Result<Value, String> {
    // Authoritative classification for audit + future approval-token gating.
    // The frontend already gates write/destructive actions via the
    // onConfirmExecution prompt before calling us; this is defense-in-depth.
    // TODO (M2.x): reject write/destructive without an approval token from
    // the user-confirmation flow. For now we log + forward — the front-end
    // approval flow is the single source of truth.
    let risk = crate::browser_classify::classify(&request.method, &request.params);
    log::debug!(
        "browser_rpc method={} classified={}",
        request.method,
        risk.as_str()
    );

    // Capability gate: if a skill is active and declares an allowed URL set,
    // refuse navigate/act calls to URLs outside that set. When no skill is
    // active, this is a no-op (chat default).
    if request.method == "browser.navigate" || request.method == "browser.act" {
        let caps_snapshot = capabilities.handle().read().await.clone();
        let url = request.params.get("url").and_then(|v| v.as_str());
        if let Some(url) = url {
            crate::browser_capability::check_url(&caps_snapshot, url)?;
        }
    }

    let inner = Arc::clone(&state.inner);
    ensure_spawned(Arc::clone(&inner), &app).await?;
    let result = send_rpc(inner, request.method.clone(), request.params.clone()).await?;

    // Capture into the active workflow recording (if any). Best-effort —
    // a recording error never fails the actual browser action.
    let observed_url = result.get("url").and_then(|v| v.as_str()).map(|s| s.to_string());
    let observed_title = result.get("title").and_then(|v| v.as_str()).map(|s| s.to_string());
    recorder
        .append(crate::workflow_recorder::WorkflowStep {
            tool: request.method.clone(),
            params: request.params,
            classification: risk.as_str().to_string(),
            observed_url,
            observed_title,
        })
        .await;

    Ok(result)
}

/// Tear down the sidecar (UI-initiated, e.g. on app exit or "stop browser").
#[command]
pub async fn browser_shutdown(state: State<'_, BrowserSupervisor>) -> Result<(), String> {
    let inner = Arc::clone(&state.inner);
    let mut guard = inner.lock().await;
    if let Some(mut child) = guard.child.take() {
        // Close stdin to let the sidecar drain sessions cleanly.
        let _ = guard.stdin.take();
        // Best-effort wait, then kill if still alive.
        match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
            Ok(_) => log::info!("browser sidecar exited cleanly"),
            Err(_) => {
                log::warn!("browser sidecar did not exit in 5s, killing");
                let _ = child.kill().await;
            }
        }
    }
    guard.pending.clear();
    Ok(())
}
