// web_search_ddg — lightweight DuckDuckGo search using the HTML endpoint.
//
// No API key required. Fetches https://html.duckduckgo.com/html/?q={query}
// and parses the result__snippet spans to extract title, snippet, and URL.
// Returns up to 5 results. Used by the browser agent to research unknown
// sites and find automation best practices.
//
// Rate limits: DuckDuckGo's HTML endpoint is generous for individual use.
// This is called once per unknown site (not per action), so volume is low.

use regex::Regex;
use serde::Serialize;
use tauri::command;

#[derive(Serialize, Debug)]
pub struct SearchResult {
    pub title: String,
    pub snippet: String,
    pub url: String,
}

fn parse_ddg_html(html: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();

    // DuckDuckGo HTML structure (simplified):
    // <div class="result results_links results_links_deep web-result">
    //   <h2 class="result__title">
    //     <a class="result__a" href="URL">TITLE</a>
    //   </h2>
    //   <a class="result__snippet" ...>SNIPPET</a>
    // </div>
    //
    // We extract title, URL, and snippet using simple regex — no HTML parser dep.

    let title_re = Regex::new(r#"class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*(?:<[^/][^>]*>[^<]*</[^>]*>)*[^<]*)</a"#)
        .unwrap_or_else(|_| Regex::new(r"NOMATCH").unwrap());
    let snippet_re = Regex::new(r#"class="result__snippet"[^>]*>([^<]*(?:<[^/][^>]*>[^<]*</[^>]*>)*[^<]*)</"#)
        .unwrap_or_else(|_| Regex::new(r"NOMATCH").unwrap());

    // Split by result blocks to pair titles with snippets
    let blocks: Vec<&str> = html.split(r#"class="result results_links"#).collect();

    for block in blocks.iter().skip(1).take(5) {
        let url = title_re.captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
        let raw_title = title_re.captures(block)
            .and_then(|c| c.get(2))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
        let raw_snippet = snippet_re.captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let title = strip_html_tags(&raw_title);
        let snippet = strip_html_tags(&raw_snippet);

        if !title.is_empty() || !snippet.is_empty() {
            results.push(SearchResult { title, snippet, url });
        }
    }

    // Fallback: if block-based parsing found nothing, try a simpler extraction
    if results.is_empty() {
        let simple_title = Regex::new(r#"<a class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>"#).ok();
        let simple_snip = Regex::new(r#"class="result__snippet"[^>]*>(.*?)</a"#).ok();
        if let (Some(tr), Some(sr)) = (simple_title, simple_snip) {
            let titles: Vec<_> = tr.captures_iter(html).take(5).collect();
            let snippets: Vec<_> = sr.captures_iter(html).take(5).collect();
            for (t, s) in titles.iter().zip(snippets.iter()) {
                results.push(SearchResult {
                    url: t.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
                    title: strip_html_tags(&t.get(2).map(|m| m.as_str().to_string()).unwrap_or_default()),
                    snippet: strip_html_tags(&s.get(1).map(|m| m.as_str().to_string()).unwrap_or_default()),
                });
            }
        }
    }

    results
}

fn strip_html_tags(input: &str) -> String {
    let tag_re = Regex::new(r"<[^>]+>").unwrap_or_else(|_| Regex::new(r"NOMATCH").unwrap());
    let decoded = input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ");
    tag_re.replace_all(&decoded, "").trim().to_string()
}

/// Search the web using DuckDuckGo's HTML endpoint (no API key required).
/// Returns up to 5 results with title, snippet, and URL.
/// Intended for agent use: researching automation tips for unknown sites,
/// finding documentation, etc. Call once per research need, not per action.
#[command]
pub async fn web_search_ddg(query: String) -> Result<Vec<SearchResult>, String> {
    let encoded = urlencoding::encode(&query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", encoded);

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let html = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Search request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read search response: {}", e))?;

    let results = parse_ddg_html(&html);
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_tags_removes_html() {
        assert_eq!(strip_html_tags("<b>Hello</b> world"), "Hello world");
        assert_eq!(strip_html_tags("a &amp; b"), "a & b");
    }

    #[test]
    fn parse_empty_html_returns_empty() {
        let results = parse_ddg_html("<html><body>No results</body></html>");
        assert!(results.is_empty() || results.len() <= 5);
    }
}
