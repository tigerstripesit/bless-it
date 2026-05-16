use log::{debug, error, warn};
use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::command;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::shell_classify;

const MAX_OUTPUT_CHARS: usize = 10_000;
// Default chosen empirically: `du -sh /*` from root on macOS routinely exceeds
// 30s once /System and /Users are traversed, and the model has no good way to
// know the operation is slow up front. 120s covers most disk-scan cases while
// keeping a hard 300s ceiling on truly runaway commands.
const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Serialize)]
pub struct ExecuteCommandResponse {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

fn sanitize_output(s: &str) -> String {
    if s.len() > MAX_OUTPUT_CHARS {
        let mut truncated = s[..MAX_OUTPUT_CHARS].to_string();
        truncated.push_str("\n\n... (output truncated)");
        truncated
    } else {
        s.to_string()
    }
}

#[command]
pub async fn execute_command(
    cmd: String,
    working_dir: String,
    timeout_secs: Option<u64>,
) -> Result<ExecuteCommandResponse, String> {
    let cmd = cmd.trim().to_string();

    if cmd.is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    if shell_classify::is_blocked(&cmd) {
        warn!("Blocked dangerous command: {}", cmd);
        return Err("Command blocked for security reasons".to_string());
    }

    let work_dir = Path::new(&working_dir);
    if !work_dir.exists() {
        return Err(format!("Working directory does not exist: {}", working_dir));
    }
    if !work_dir.is_dir() {
        return Err(format!("Working directory is not a directory: {}", working_dir));
    }

    let timeout_duration = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .min(MAX_TIMEOUT_SECS),
    );

    debug!(
        "Executing command: {} in dir: {} (timeout: {:?})",
        cmd, working_dir, timeout_duration
    );

    let child = Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let child = Arc::new(Mutex::new(Some(child)));
    let child_for_task = child.clone();

    let result = timeout(timeout_duration, async move {
        let mut guard = child_for_task.lock().await;
        let child_opt = guard.as_mut()
            .ok_or_else(|| "Child process unavailable".to_string())?;

        let mut child_stdout = child_opt.stdout.take();
        let mut child_stderr = child_opt.stderr.take();

        let status = child_opt
            .wait()
            .await
            .map_err(|e| format!("Failed to wait for command: {}", e))?;

        let mut stdout = String::new();
        if let Some(out) = child_stdout.as_mut() {
            out.read_to_string(&mut stdout).await.ok();
        }

        let mut stderr = String::new();
        if let Some(err) = child_stderr.as_mut() {
            err.read_to_string(&mut stderr).await.ok();
        }

        let exit_code = status.code().unwrap_or(-1);

        Ok::<_, String>(ExecuteCommandResponse {
            stdout: sanitize_output(&stdout),
            stderr: sanitize_output(&stderr),
            exit_code,
            timed_out: false,
        })
    })
    .await;

    match result {
        Ok(Ok(response)) => {
            if response.exit_code != 0 {
                debug!("Command exited with code {}: {}", response.exit_code, cmd);
            }
            Ok(response)
        }
        Ok(Err(e)) => {
            error!("Command execution error: {} for cmd: {}", e, cmd);
            Err(e)
        }
        Err(_elapsed) => {
            warn!("Command timed out after {:?}: {}", timeout_duration, cmd);
            let mut guard = child.lock().await;
            if let Some(c) = guard.as_mut() {
                let _ = c.kill().await;
                let _ = c.wait().await;
            }
            Ok(ExecuteCommandResponse {
                stdout: String::new(),
                stderr: format!("Command timed out after {:?}", timeout_duration),
                exit_code: -1,
                timed_out: true,
            })
        }
    }
}
