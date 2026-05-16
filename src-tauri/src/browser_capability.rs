// Browser capability gate (M5).
//
// Per-skill URL allowlist enforced at the Tauri command boundary. When a
// skill becomes active in the chat, the frontend calls
// `browser_set_capabilities` with the skill's declared patterns. browser_rpc
// then refuses navigate/act calls whose target URL doesn't match.
//
// Patterns use a simple glob: `*` matches any character except newline,
// anchored both ends. Example patterns:
//
//   browser:https://admin.microsoft.com/*
//   browser:https://login.microsoftonline.com/*
//   browser:https://*.okta.com/*
//
// The leading `browser:` is the capability namespace (so the same SKILL.md
// list can grow `fs:` or `shell:` capabilities later); we strip it before
// matching. The "screenshot" pseudo-capability is a separate flag,
// reserved for a future PII-redaction pass — unused in M5.
//
// When the active-capability set is empty (no skill active), all URLs are
// allowed. The chat-level approval flow is the gate in that case.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{command, State};
use tokio::sync::RwLock;

const BROWSER_PREFIX: &str = "browser:";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCapabilities {
    pub skill_id: Option<String>,
    /// URL glob patterns the active skill is allowed to drive. Empty =
    /// chat default (no gating beyond approval). Patterns are stored
    /// pre-stripped of the `browser:` prefix.
    pub patterns: Vec<String>,
    pub allow_screenshot: bool,
}

#[derive(Default)]
pub struct BrowserCapabilityState {
    inner: Arc<RwLock<ActiveCapabilities>>,
}

impl BrowserCapabilityState {
    pub fn handle(&self) -> Arc<RwLock<ActiveCapabilities>> {
        Arc::clone(&self.inner)
    }
}

#[command]
pub async fn browser_set_capabilities(
    skill_id: Option<String>,
    patterns: Vec<String>,
    allow_screenshot: Option<bool>,
    state: State<'_, BrowserCapabilityState>,
) -> Result<(), String> {
    let mut guard = state.inner.write().await;
    *guard = ActiveCapabilities {
        skill_id,
        patterns: patterns
            .into_iter()
            .map(|p| p.strip_prefix(BROWSER_PREFIX).unwrap_or(&p).to_string())
            .collect(),
        allow_screenshot: allow_screenshot.unwrap_or(true),
    };
    Ok(())
}

#[command]
pub async fn browser_clear_capabilities(
    state: State<'_, BrowserCapabilityState>,
) -> Result<(), String> {
    let mut guard = state.inner.write().await;
    *guard = ActiveCapabilities::default();
    Ok(())
}

#[command]
pub async fn browser_get_capabilities(
    state: State<'_, BrowserCapabilityState>,
) -> Result<ActiveCapabilities, String> {
    Ok(state.inner.read().await.clone())
}

/// Glob match against the active patterns. Returns Ok(()) if allowed,
/// Err(reason) if blocked. When no patterns are configured (default
/// chat-only mode), all URLs pass.
pub fn check_url(
    capabilities: &ActiveCapabilities,
    url: &str,
) -> Result<(), String> {
    if capabilities.patterns.is_empty() {
        return Ok(());
    }
    for pattern in &capabilities.patterns {
        if glob_match(pattern, url) {
            return Ok(());
        }
    }
    Err(format!(
        "Skill '{}' is not authorized for URL '{}'. Allowed patterns: {}",
        capabilities.skill_id.as_deref().unwrap_or("(unknown)"),
        url,
        capabilities.patterns.join(", "),
    ))
}

/// Minimal glob matcher: `*` matches any run of characters except newline.
/// Patterns are anchored at both ends. No `?`, no character classes — keep
/// it predictable; the patterns come from SKILL.md frontmatter signed by
/// the admin.
fn glob_match(pattern: &str, text: &str) -> bool {
    fn helper(p: &[u8], t: &[u8]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (None, Some(_)) => false,
            (Some(b'*'), _) => {
                // Zero-or-more match: try consuming 0, 1, 2... chars of t.
                if helper(&p[1..], t) {
                    return true;
                }
                if let Some(&tc) = t.first() {
                    if tc == b'\n' {
                        return false;
                    }
                    return helper(p, &t[1..]);
                }
                false
            }
            (Some(&pc), Some(&tc)) if pc == tc => helper(&p[1..], &t[1..]),
            _ => false,
        }
    }
    helper(pattern.as_bytes(), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(patterns: &[&str]) -> ActiveCapabilities {
        ActiveCapabilities {
            skill_id: Some("test".to_string()),
            patterns: patterns.iter().map(|s| s.to_string()).collect(),
            allow_screenshot: true,
        }
    }

    #[test]
    fn empty_pattern_set_allows_anything() {
        let c = caps(&[]);
        assert!(check_url(&c, "https://example.com").is_ok());
    }

    #[test]
    fn exact_match_passes() {
        let c = caps(&["https://admin.example.com/users"]);
        assert!(check_url(&c, "https://admin.example.com/users").is_ok());
        assert!(check_url(&c, "https://admin.example.com/other").is_err());
    }

    #[test]
    fn trailing_wildcard() {
        let c = caps(&["https://admin.example.com/*"]);
        assert!(check_url(&c, "https://admin.example.com/users").is_ok());
        assert!(check_url(&c, "https://admin.example.com/users/123").is_ok());
        assert!(check_url(&c, "https://evil.com/admin.example.com/x").is_err());
    }

    #[test]
    fn subdomain_wildcard() {
        let c = caps(&["https://*.okta.com/*"]);
        assert!(check_url(&c, "https://acme.okta.com/admin").is_ok());
        assert!(check_url(&c, "https://x.y.okta.com/admin").is_ok());
        assert!(check_url(&c, "https://oktax.com/").is_err());
    }

    #[test]
    fn cross_origin_blocked() {
        let c = caps(&["https://admin.microsoft.com/*"]);
        assert!(check_url(&c, "https://login.microsoftonline.com/").is_err());
    }

    #[test]
    fn multiple_patterns_any_passes() {
        let c = caps(&[
            "https://admin.microsoft.com/*",
            "https://login.microsoftonline.com/*",
        ]);
        assert!(check_url(&c, "https://admin.microsoft.com/users").is_ok());
        assert!(check_url(&c, "https://login.microsoftonline.com/oauth2").is_ok());
        assert!(check_url(&c, "https://office.com/").is_err());
    }

    #[test]
    fn newline_in_url_never_matches_wildcard() {
        let c = caps(&["https://*.example.com/*"]);
        assert!(check_url(&c, "https://x.example.com/path\nwith-newline").is_err());
    }
}
