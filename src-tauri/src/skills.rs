use chrono::Utc;
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{command, AppHandle, Manager};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

const SKILLS_SUBDIR: &str = ".ittoolkit/skills";
const STATE_FILE: &str = ".ittoolkit/skills-state.json";
const SHELL_INJECT_TIMEOUT_SECS: u64 = 15;
const SHELL_INJECT_OUTPUT_CAP: usize = 4_000;
const BLOCKED_PLACEHOLDER: &str = "[shell command blocked — trust this skill in Settings]";

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())
}

fn skills_dir() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(SKILLS_SUBDIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create skills dir: {}", e))?;
    }
    Ok(dir)
}

fn state_path() -> Result<PathBuf, String> {
    let p = home_dir()?.join(STATE_FILE);
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create state dir: {}", e))?;
        }
    }
    Ok(p)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillState {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub trusted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_granted_at: Option<String>,
}

impl Default for SkillState {
    fn default() -> Self {
        Self {
            enabled: true,
            trusted: false,
            trust_granted_at: None,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SkillsStateFile {
    #[serde(flatten)]
    pub skills: HashMap<String, SkillState>,
}

static STATE_LOCK: Mutex<()> = Mutex::new(());

fn load_state_file() -> SkillsStateFile {
    let path = match state_path() {
        Ok(p) => p,
        Err(_) => return SkillsStateFile::default(),
    };
    if !path.exists() {
        return SkillsStateFile::default();
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return SkillsStateFile::default(),
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_state_file(state: &SkillsStateFile) -> Result<(), String> {
    let path = state_path()?;
    let _guard = STATE_LOCK.lock().map_err(|e| format!("State lock poisoned: {}", e))?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize state: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("Failed to write state tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to rename state: {}", e))?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct RawSkillFrontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "when_to_use")]
    when_to_use: Option<String>,
    #[serde(default, rename = "allowed-tools")]
    allowed_tools: Option<serde_yaml::Value>,
    #[serde(default, rename = "disable-model-invocation")]
    disable_model_invocation: Option<bool>,
    #[serde(default, rename = "user-invocable")]
    user_invocable: Option<bool>,
    #[serde(default)]
    arguments: Option<serde_yaml::Value>,
    #[serde(default, rename = "argument-hint")]
    argument_hint: Option<String>,
    /// Optional list of capability strings the skill needs to function.
    /// Recognized namespaces today: `browser:<glob>`, `browser:screenshot`.
    /// Future: `fs:`, `shell:` — the loader stays permissive about unknowns
    /// so the format can grow without breaking older skills.
    #[serde(default)]
    capabilities: Option<serde_yaml::Value>,
    /// Browser profile: "ephemeral" (default — fresh Chromium each time) or
    /// "persistent" (reuse cookies / SSO across runs). Surfaced to the
    /// frontend so `browser_open` calls inside this skill can pass it
    /// through automatically.
    #[serde(default)]
    profile: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub name: String,
    pub description: String,
    pub when_to_use: Option<String>,
    pub allowed_tools: Vec<String>,
    pub disable_model_invocation: bool,
    pub user_invocable: bool,
    pub arguments: Vec<String>,
    pub argument_hint: Option<String>,
    pub path: String,
    pub has_shell_injection: bool,
    pub enabled: bool,
    pub trusted: bool,
    /// Capability strings declared in frontmatter (browser:* etc.).
    /// Empty when the skill omits the field — chat-default permissions apply.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// "ephemeral" | "persistent". None means the skill didn't declare a
    /// preference; browser_open defaults to ephemeral.
    #[serde(default)]
    pub profile: Option<String>,
}

fn yaml_value_to_string_list(v: &serde_yaml::Value) -> Vec<String> {
    match v {
        serde_yaml::Value::String(s) => s
            .split_whitespace()
            .map(|x| x.to_string())
            .collect(),
        serde_yaml::Value::Sequence(seq) => seq
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn split_frontmatter(content: &str) -> Option<(RawSkillFrontmatter, &str)> {
    let stripped = content.strip_prefix("---\n")?;
    let end = stripped.find("\n---\n").or_else(|| stripped.find("\n---"))?;
    let yaml_str = &stripped[..end];
    let after = &stripped[end..];
    let body = after.trim_start_matches('\n').trim_start_matches("---").trim_start_matches('\n');
    let fm: RawSkillFrontmatter = serde_yaml::from_str(yaml_str).ok()?;
    Some((fm, body))
}

fn detect_shell_injection(body: &str) -> bool {
    if body.contains("```!") {
        return true;
    }
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'!' && bytes[i + 1] == b'`' {
            if let Some(close_rel) = body[i + 2..].find('`') {
                if close_rel > 0 {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

fn build_manifest(dir: &Path, fm: RawSkillFrontmatter, body: &str, state: &SkillState) -> SkillManifest {
    let name_from_dir = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let name = fm.name.unwrap_or(name_from_dir);
    let description = fm.description.unwrap_or_else(|| {
        body.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string()
    });
    let allowed_tools = fm.allowed_tools.as_ref().map(yaml_value_to_string_list).unwrap_or_default();
    let arguments = fm.arguments.as_ref().map(yaml_value_to_string_list).unwrap_or_default();
    let capabilities = fm.capabilities.as_ref().map(yaml_value_to_string_list).unwrap_or_default();
    let profile = fm.profile.and_then(|p| {
        let trimmed = p.trim().to_lowercase();
        match trimmed.as_str() {
            "ephemeral" | "persistent" => Some(trimmed),
            _ => None,
        }
    });
    SkillManifest {
        name,
        description,
        when_to_use: fm.when_to_use,
        allowed_tools,
        disable_model_invocation: fm.disable_model_invocation.unwrap_or(false),
        user_invocable: fm.user_invocable.unwrap_or(true),
        arguments,
        argument_hint: fm.argument_hint,
        path: dir.to_string_lossy().to_string(),
        has_shell_injection: detect_shell_injection(body),
        enabled: state.enabled,
        trusted: state.trusted,
        capabilities,
        profile,
    }
}

fn read_skill_dir(dir: &Path, state_file: &SkillsStateFile) -> Option<SkillManifest> {
    let skill_path = dir.join("SKILL.md");
    if !skill_path.exists() {
        return None;
    }
    let content = fs::read_to_string(&skill_path).ok()?;
    let (fm, body) = split_frontmatter(&content)?;
    let dir_name = dir.file_name()?.to_str()?.to_string();
    let key = fm.name.clone().unwrap_or(dir_name);
    let state = state_file.skills.get(&key).cloned().unwrap_or_default();
    Some(build_manifest(dir, fm, body, &state))
}

#[command]
pub fn list_skills() -> Result<Vec<SkillManifest>, String> {
    let dir = skills_dir()?;
    let state = load_state_file();
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read skills dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(manifest) = read_skill_dir(&path, &state) {
            out.push(manifest);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[command]
pub fn get_skill_source(name: String) -> Result<String, String> {
    let dir = skills_dir()?;
    let skill_path = dir.join(&name).join("SKILL.md");
    fs::read_to_string(&skill_path)
        .map_err(|e| format!("Failed to read {}: {}", skill_path.display(), e))
}

async fn run_shell_inline(cmd: &str, working_dir: &Path) -> String {
    let child = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return format!("[shell error: {}]", e),
    };
    let run = async {
        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();
        if let Some(mut out) = child.stdout.take() {
            out.read_to_string(&mut stdout_buf).await.ok();
        }
        if let Some(mut err) = child.stderr.take() {
            err.read_to_string(&mut stderr_buf).await.ok();
        }
        let _ = child.wait().await;
        let mut combined = stdout_buf;
        if !stderr_buf.trim().is_empty() {
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push_str(&stderr_buf);
        }
        combined
    };
    let result = timeout(Duration::from_secs(SHELL_INJECT_TIMEOUT_SECS), run).await;
    let mut out = match result {
        Ok(s) => s,
        Err(_) => "[shell command timed out]".to_string(),
    };
    out = out.trim_end().to_string();
    if out.len() > SHELL_INJECT_OUTPUT_CAP {
        out.truncate(SHELL_INJECT_OUTPUT_CAP);
        out.push_str("\n... (truncated)");
    }
    out
}

async fn render_inline_shell(body: &str, skill_dir: &Path, trusted: bool) -> String {
    let mut out = String::with_capacity(body.len());
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'!' && bytes[i + 1] == b'`' {
            if let Some(rel) = body[i + 2..].find('`') {
                let cmd = &body[i + 2..i + 2 + rel];
                if !cmd.is_empty() {
                    if trusted {
                        let output = run_shell_inline(cmd, skill_dir).await;
                        out.push_str(&output);
                    } else {
                        out.push_str(BLOCKED_PLACEHOLDER);
                    }
                    i = i + 2 + rel + 1;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

async fn render_block_shell(body: &str, skill_dir: &Path, trusted: bool) -> String {
    let mut out = String::with_capacity(body.len());
    let lines: Vec<&str> = body.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim_start() == "```!" {
            let mut close = lines.len();
            for (j, l) in lines.iter().enumerate().skip(i + 1) {
                if l.trim_start() == "```" {
                    close = j;
                    break;
                }
            }
            let cmd = lines[i + 1..close].join("\n");
            if trusted && !cmd.trim().is_empty() {
                let output = run_shell_inline(&cmd, skill_dir).await;
                out.push_str(&output);
            } else {
                out.push_str(BLOCKED_PLACEHOLDER);
            }
            out.push('\n');
            i = if close < lines.len() { close + 1 } else { lines.len() };
            continue;
        }
        out.push_str(lines[i]);
        out.push('\n');
        i += 1;
    }
    out
}

fn substitute_arguments(body: &str, args: &str, skill_dir: &Path) -> String {
    let parts = shell_split(args);
    let mut out = body.to_string();
    out = out.replace("${SKILL_DIR}", &skill_dir.to_string_lossy());
    out = out.replace("${CLAUDE_SKILL_DIR}", &skill_dir.to_string_lossy());
    let mut has_args_token = out.contains("$ARGUMENTS");
    out = out.replace("$ARGUMENTS", args);
    for (i, p) in parts.iter().enumerate() {
        let token_index = format!("$ARGUMENTS[{}]", i);
        out = out.replace(&token_index, p);
        let token_short = format!("${}", i);
        out = out.replace(&token_short, p);
    }
    if !args.is_empty() && !has_args_token {
        has_args_token = true;
        out.push_str(&format!("\n\nARGUMENTS: {}\n", args));
    }
    let _ = has_args_token;
    out
}

fn shell_split(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '\\' if in_double => {
                if let Some(&next) = chars.peek() {
                    cur.push(next);
                    chars.next();
                }
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[command]
pub async fn load_skill_body(name: String, args: Option<String>) -> Result<String, String> {
    let dir = skills_dir()?;
    let skill_dir = dir.join(&name);
    let skill_path = skill_dir.join("SKILL.md");
    if !skill_path.exists() {
        return Err(format!("Skill not found: {}", name));
    }
    let content = fs::read_to_string(&skill_path)
        .map_err(|e| format!("Failed to read SKILL.md: {}", e))?;
    let (_fm, body) = split_frontmatter(&content)
        .ok_or_else(|| "Malformed frontmatter".to_string())?;
    let state_file = load_state_file();
    let state = state_file.skills.get(&name).cloned().unwrap_or_default();
    let args_str = args.unwrap_or_default();
    let substituted = substitute_arguments(body, &args_str, &skill_dir);
    let after_block = render_block_shell(&substituted, &skill_dir, state.trusted).await;
    let final_body = render_inline_shell(&after_block, &skill_dir, state.trusted).await;
    debug!("Loaded skill body for {} ({} bytes)", name, final_body.len());
    Ok(final_body)
}

#[command]
pub fn set_skill_enabled(name: String, enabled: bool) -> Result<(), String> {
    let mut state = load_state_file();
    let entry = state.skills.entry(name).or_default();
    entry.enabled = enabled;
    save_state_file(&state)
}

#[command]
pub fn set_skill_trusted(name: String, trusted: bool) -> Result<(), String> {
    let mut state = load_state_file();
    let entry = state.skills.entry(name).or_default();
    entry.trusted = trusted;
    if trusted {
        entry.trust_granted_at = Some(Utc::now().to_rfc3339());
    } else {
        entry.trust_granted_at = None;
    }
    save_state_file(&state)
}

#[command]
pub fn open_skills_folder() -> Result<(), String> {
    let dir = skills_dir()?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Seed individual files that don't yet exist at destination (merges, not replaces).
/// Used for the `browser-sites` sub-skill directory so new hostname skills are
/// added on upgrade without overwriting any user edits to existing ones.
fn seed_dir_merge(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            seed_dir_merge(&from, &to)?;
        } else if !to.exists() {
            // Only copy if destination file doesn't exist — preserves user edits.
            fs::copy(&from, &to)?;
            debug!("Seeded skill file: {:?}", to);
        }
    }
    Ok(())
}

pub fn seed_default_skills(app: &AppHandle) -> Result<(), String> {
    let user_dir = skills_dir()?;
    let resource_root = app
        .path()
        .resolve("resources/default-skills", tauri::path::BaseDirectory::Resource)
        .or_else(|_| {
            app.path()
                .resolve("default-skills", tauri::path::BaseDirectory::Resource)
        })
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;

    if !resource_root.exists() {
        warn!("Default skills resource dir not found at {:?}", resource_root);
        return Ok(());
    }

    let entries = fs::read_dir(&resource_root)
        .map_err(|e| format!("Failed to read resource dir: {}", e))?;
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_dir() {
            continue;
        }
        let name = match src.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let dst = user_dir.join(&name);
        // browser-sites is a container of per-hostname skill dirs — merge so
        // new hostnames are added on upgrade without overwriting user edits.
        if name == "browser-sites" {
            if let Err(e) = seed_dir_merge(&src, &dst) {
                warn!("Failed to merge browser-sites skills: {}", e);
            }
        } else {
            if dst.exists() {
                continue;
            }
            if let Err(e) = copy_dir_recursive(&src, &dst) {
                warn!("Failed to seed skill {}: {}", name, e);
            } else {
                debug!("Seeded default skill: {}", name);
            }
        }
    }
    Ok(())
}

/// Look up a site-specific behavioral skill for a given hostname.
/// Checks `~/.ittoolkit/skills/browser-sites/{hostname}/SKILL.md` and
/// returns the markdown body (without frontmatter) if found.
#[command]
pub fn get_site_skill_body(hostname: String) -> Option<String> {
    let dir = skills_dir().ok()?;
    let skill_path = dir
        .join("browser-sites")
        .join(hostname.to_lowercase())
        .join("SKILL.md");
    if !skill_path.exists() {
        return None;
    }
    let content = fs::read_to_string(&skill_path).ok()?;
    let (_fm, body) = split_frontmatter(&content)?;
    let trimmed = body.trim().to_string();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}
