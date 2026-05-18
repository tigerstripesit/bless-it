// Authoritative browser-use risk classification.
//
// Mirrors `src/lib/ai/browser-classify.ts`. Called from `browser_rpc` so the
// Rust side never trusts the frontend's classification alone. Same tiers:
//   - "read"        : autonomous
//   - "write"       : requires approval
//   - "destructive" : requires approval, hard-default risky
//
// browser_act params optionally carry `tags` (from the AX node at
// params.index) and `submit` (boolean). When tags include "password" or
// "form_submit", the action escalates to write.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserRisk {
    Read,
    Write,
    Destructive,
}

impl BrowserRisk {
    pub fn as_str(&self) -> &'static str {
        match self {
            BrowserRisk::Read => "read",
            BrowserRisk::Write => "write",
            BrowserRisk::Destructive => "destructive",
        }
    }
}

fn url_is_destructive(url: &str) -> bool {
    let trimmed = url.trim_start().to_ascii_lowercase();
    trimmed.starts_with("mailto:")
        || trimmed.starts_with("tel:")
        || trimmed.starts_with("file:")
        || trimmed.starts_with("javascript:")
}

fn has_tag(params: &Value, tag: &str) -> bool {
    params
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().any(|t| t.as_str() == Some(tag)))
        .unwrap_or(false)
}

pub fn classify(method: &str, params: &Value) -> BrowserRisk {
    match method {
        "browser.open" | "browser.close" | "browser.observe" | "browser.extract" | "browser.mark" => BrowserRisk::Read,

        "browser.navigate" => {
            let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() {
                return BrowserRisk::Write;
            }
            if url_is_destructive(url) {
                return BrowserRisk::Destructive;
            }
            let lower = url.to_ascii_lowercase();
            if lower.starts_with("http://") || lower.starts_with("https://") {
                BrowserRisk::Read
            } else {
                BrowserRisk::Write
            }
        }

        "browser.act" => {
            let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
            let submit = params.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
            if submit {
                return BrowserRisk::Write;
            }
            let password_tagged = has_tag(params, "password");
            let form_submit_tagged = has_tag(params, "form_submit");
            match action.as_str() {
                "type" | "press" if password_tagged => BrowserRisk::Write,
                "click" if form_submit_tagged => BrowserRisk::Write,
                "hover" | "scroll" | "click" | "type" | "select" | "press" => BrowserRisk::Read,
                _ => BrowserRisk::Write, // unknown action — default closed
            }
        }

        _ => BrowserRisk::Write, // unknown method — default closed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_methods_are_read() {
        for m in ["browser.open", "browser.close", "browser.observe", "browser.extract", "browser.mark"] {
            assert_eq!(classify(m, &json!({})), BrowserRisk::Read, "{}", m);
        }
    }

    #[test]
    fn navigate_classifies_by_scheme() {
        assert_eq!(classify("browser.navigate", &json!({ "url": "https://example.com" })), BrowserRisk::Read);
        assert_eq!(classify("browser.navigate", &json!({ "url": "http://example.com" })), BrowserRisk::Read);
        assert_eq!(classify("browser.navigate", &json!({ "url": "mailto:a@b" })), BrowserRisk::Destructive);
        assert_eq!(classify("browser.navigate", &json!({ "url": "tel:+15555550100" })), BrowserRisk::Destructive);
        assert_eq!(classify("browser.navigate", &json!({ "url": "file:///etc/passwd" })), BrowserRisk::Destructive);
        assert_eq!(classify("browser.navigate", &json!({ "url": "javascript:alert(1)" })), BrowserRisk::Destructive);
        assert_eq!(classify("browser.navigate", &json!({ "url": "" })), BrowserRisk::Write);
    }

    #[test]
    fn act_password_tag_escalates_write() {
        assert_eq!(
            classify("browser.act", &json!({ "action": "type", "tags": ["password"] })),
            BrowserRisk::Write,
        );
        assert_eq!(
            classify("browser.act", &json!({ "action": "type", "tags": [] })),
            BrowserRisk::Read,
        );
    }

    #[test]
    fn act_form_submit_tag_escalates_write() {
        assert_eq!(
            classify("browser.act", &json!({ "action": "click", "tags": ["form_submit"] })),
            BrowserRisk::Write,
        );
        assert_eq!(
            classify("browser.act", &json!({ "action": "click" })),
            BrowserRisk::Read,
        );
    }

    #[test]
    fn act_submit_flag_escalates_write() {
        assert_eq!(
            classify("browser.act", &json!({ "action": "type", "submit": true })),
            BrowserRisk::Write,
        );
    }

    #[test]
    fn unknown_method_defaults_write() {
        assert_eq!(classify("browser.weirdthing", &json!({})), BrowserRisk::Write);
    }
}
