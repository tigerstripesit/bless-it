// Unconditional shell-command circuit breaker.
//
// This is the last gate before `sh -c <cmd>` executes. It refuses commands
// that reach privilege-escalation, disk-destruction, or "wipe the world"
// programs — *regardless of which wrappers got us there*.
//
// The previous version (substring match against literal patterns like
// "rm -rf /") missed everything that reaches the destructive program
// through composition: `find / -exec rm -rf {} +`, `sh -c "sudo rm -rf /"`,
// `env<TAB>sudo<TAB>rm -rf /`, `$(echo sudo) rm -rf /`, etc.
//
// This version tokenizes the command (respecting single/double quotes,
// backslash escapes, `$(…)` and backticks), splits on top-level shell
// separators, then walks each segment through wrappers (sudo/env/
// timeout/sh -c/find -exec/xargs/eval/command substitution) collecting
// every reachable program invocation. Each is matched against the deny
// rules.
//
// Not a full bash parser. Exotic forms (process substitution, here-docs,
// brace expansion, arithmetic) fall through and are not blocked here —
// the TS classifier still gates them by confirmation prompt; this layer
// is strictly an unconditional refusal for the worst categories.
//
// Mirror logic in src/lib/ai/shell-classify.ts — keep them in sync.

#[derive(Debug)]
struct Word {
    value: String,
    cmdsubs: Vec<String>,
}

#[derive(Debug)]
enum Tok {
    Word(Word),
    Op(&'static str),
}

fn tokenize(src: &str) -> Vec<Tok> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < n {
        let c = bytes[i];
        match c {
            b' ' | b'\t' => { i += 1; }
            b'\n' => { toks.push(Tok::Op("\n")); i += 1; }
            b';' => { toks.push(Tok::Op(";")); i += 1; }
            b'&' => {
                if bytes.get(i + 1) == Some(&b'&') { toks.push(Tok::Op("&&")); i += 2; }
                else { toks.push(Tok::Op("&")); i += 1; }
            }
            b'|' => {
                if bytes.get(i + 1) == Some(&b'|') { toks.push(Tok::Op("||")); i += 2; }
                else if bytes.get(i + 1) == Some(&b'&') { toks.push(Tok::Op("|&")); i += 2; }
                else { toks.push(Tok::Op("|")); i += 1; }
            }
            b'>' => {
                if bytes.get(i + 1) == Some(&b'>') { toks.push(Tok::Op(">>")); i += 2; }
                else { toks.push(Tok::Op(">")); i += 1; }
            }
            b'<' => {
                if bytes.get(i + 1) == Some(&b'>') {
                    toks.push(Tok::Op("<>")); i += 2;
                } else if bytes.get(i + 1) == Some(&b'(') {
                    let (inner, end) = read_balanced(src, i + 2, b')');
                    toks.push(Tok::Word(Word {
                        value: format!("<({})", inner),
                        cmdsubs: vec![inner],
                    }));
                    i = end + 1;
                } else {
                    toks.push(Tok::Op("<")); i += 1;
                }
            }
            _ => {
                let (w, end) = read_word(src, i);
                toks.push(Tok::Word(w));
                i = end;
            }
        }
    }
    toks
}

fn read_word(src: &str, start: usize) -> (Word, usize) {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut value = String::new();
    let mut cmdsubs = Vec::new();
    let mut i = start;
    while i < n {
        let c = bytes[i];
        if matches!(c, b' ' | b'\t' | b'\n' | b';' | b'|' | b'&' | b'<' | b'>') { break; }
        if c == b'\\' && i + 1 < n {
            value.push(bytes[i + 1] as char);
            i += 2;
            continue;
        }
        if c == b'\'' {
            if let Some(rel) = src[i + 1..].find('\'') {
                let j = i + 1 + rel;
                value.push_str(&src[i + 1..j]);
                i = j + 1;
            } else {
                value.push_str(&src[i + 1..]);
                i = n;
            }
            continue;
        }
        if c == b'"' {
            let mut j = i + 1;
            while j < n && bytes[j] != b'"' {
                if bytes[j] == b'\\' && j + 1 < n {
                    value.push(bytes[j + 1] as char);
                    j += 2;
                    continue;
                }
                if bytes[j] == b'$' && bytes.get(j + 1) == Some(&b'(') {
                    let (inner, end) = read_balanced(src, j + 2, b')');
                    value.push_str(&format!("$({})", inner));
                    cmdsubs.push(inner);
                    j = end + 1;
                    continue;
                }
                if bytes[j] == b'`' {
                    let end_rel = src[j + 1..].find('`');
                    let end = end_rel.map(|p| j + 1 + p).unwrap_or(n);
                    cmdsubs.push(src[j + 1..end].to_string());
                    value.push_str(&src[j..end.min(n).max(j) + if end < n { 1 } else { 0 }]);
                    j = end + 1;
                    continue;
                }
                value.push(bytes[j] as char);
                j += 1;
            }
            i = j + 1;
            continue;
        }
        if c == b'$' && bytes.get(i + 1) == Some(&b'(') {
            let (inner, end) = read_balanced(src, i + 2, b')');
            value.push_str(&format!("$({})", inner));
            cmdsubs.push(inner);
            i = end + 1;
            continue;
        }
        if c == b'`' {
            let end_rel = src[i + 1..].find('`');
            let end = end_rel.map(|p| i + 1 + p).unwrap_or(n);
            cmdsubs.push(src[i + 1..end].to_string());
            value.push_str(&src[i..end.min(n).max(i) + if end < n { 1 } else { 0 }]);
            i = end + 1;
            continue;
        }
        value.push(c as char);
        i += 1;
    }
    (Word { value, cmdsubs }, i)
}

fn read_balanced(src: &str, start: usize, closer: u8) -> (String, usize) {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut depth = 1;
    let mut i = start;
    while i < n {
        let c = bytes[i];
        if c == b'\\' && i + 1 < n { i += 2; continue; }
        if c == b'\'' {
            if let Some(rel) = src[i + 1..].find('\'') {
                i = i + 1 + rel + 1;
            } else {
                i = n;
            }
            continue;
        }
        if c == b'"' {
            let mut j = i + 1;
            while j < n && bytes[j] != b'"' {
                if bytes[j] == b'\\' && j + 1 < n { j += 2; } else { j += 1; }
            }
            i = j + 1;
            continue;
        }
        if closer == b')' {
            if c == b'(' { depth += 1; i += 1; continue; }
            if c == b')' {
                depth -= 1;
                if depth == 0 { return (src[start..i].to_string(), i); }
                i += 1;
                continue;
            }
        } else if c == closer {
            return (src[start..i].to_string(), i);
        }
        i += 1;
    }
    (src[start..n].to_string(), n)
}

fn basename(p: &str) -> String {
    let trimmed = p.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

fn is_assignment(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !(b[0].is_ascii_alphabetic() || b[0] == b'_') { return false; }
    let mut i = 1;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') { i += 1; }
    i < b.len() && b[i] == b'='
}

fn split_segments(toks: Vec<Tok>) -> Vec<Vec<Tok>> {
    let mut segs = Vec::new();
    let mut cur: Vec<Tok> = Vec::new();
    for t in toks {
        match &t {
            Tok::Op(op) if !matches!(*op, ">" | ">>" | "<" | "<>") => {
                if !cur.is_empty() { segs.push(std::mem::take(&mut cur)); }
            }
            _ => cur.push(t),
        }
    }
    if !cur.is_empty() { segs.push(cur); }
    segs
}

fn skip_wrapper_flags(base: &str, args: &[String]) -> usize {
    let val_flags: &[&str] = match base {
        "sudo" => &["-u", "-g", "-p", "-r", "-t", "-h", "-C", "-D"],
        "doas" => &["-u", "-a", "-C"],
        "env" => &["-u", "--unset"],
        "nice" => &["-n"],
        "timeout" => &["-s", "-k", "--signal", "--kill-after"],
        "time" => &["-f", "-o", "--format", "--output"],
        "stdbuf" => &["-i", "-o", "-e"],
        "ionice" => &["-c", "-n", "-p"],
        "flock" => &["-w", "-E"],
        "watch" => &["-n", "-d"],
        _ => &[],
    };
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--" { return i + 1; }
        if !a.starts_with('-') {
            if base == "env" && is_assignment(a) { i += 1; continue; }
            return i;
        }
        if val_flags.iter().any(|f| a == f) { i += 2; } else { i += 1; }
    }
    i
}

// Some wrappers consume positional arguments before the inner command.
//   `timeout 5 <cmd>`     — DURATION
//   `flock /tmp/lock <cmd>` — FILE
// Return how many positionals to skip after the flag-skipping phase.
fn wrapper_positional_skip(base: &str) -> usize {
    match base {
        "timeout" | "flock" => 1,
        _ => 0,
    }
}

fn skip_xargs_flags(args: &[String]) -> usize {
    let val_flags: &[&str] = &["-I", "-n", "-P", "-d", "-E", "-L", "-s"];
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--" { return i + 1; }
        if !a.starts_with('-') { return i; }
        if val_flags.iter().any(|f| a == f) { i += 2; } else { i += 1; }
    }
    i
}

fn is_wrapper(base: &str) -> bool {
    matches!(base,
        "sudo" | "doas" | "env" | "nice" | "nohup" | "timeout" | "time"
        | "stdbuf" | "setsid" | "ionice" | "flock" | "unbuffer" | "watch")
}

fn is_shell(base: &str) -> bool {
    matches!(base, "sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "fish")
}

fn walk_invocations<F: FnMut(&str, &[String])>(cmd: &str, visit: &mut F) {
    let toks = tokenize(cmd);
    for seg in split_segments(toks) {
        // Recurse into any command substitution inside any word of this segment.
        for t in &seg {
            if let Tok::Word(w) = t {
                for sub in &w.cmdsubs {
                    walk_invocations(sub, visit);
                }
            }
        }
        // Extract the simple command. Skip leading VAR=value assignments.
        let words: Vec<&String> = seg.iter().filter_map(|t| match t {
            Tok::Word(w) => Some(&w.value), _ => None,
        }).collect();
        let mut idx = 0;
        while idx < words.len() && is_assignment(words[idx]) { idx += 1; }
        if idx >= words.len() { continue; }
        let prog = words[idx].clone();
        let args: Vec<String> = words[idx + 1..].iter().map(|s| (*s).clone()).collect();
        visit_invocation(&prog, &args, visit);
    }
}

fn visit_invocation<F: FnMut(&str, &[String])>(prog: &str, args: &[String], visit: &mut F) {
    visit(prog, args);
    let base = basename(prog);

    if is_wrapper(&base) {
        let i = skip_wrapper_flags(&base, args) + wrapper_positional_skip(&base);
        if i < args.len() {
            visit_invocation(&args[i], &args[i + 1..], visit);
        }
        return;
    }
    if is_shell(&base) {
        if let Some(pos) = args.iter().position(|a| a == "-c") {
            if let Some(inner) = args.get(pos + 1) {
                walk_invocations(inner, visit);
            }
        }
        return;
    }
    if base == "eval" {
        walk_invocations(&args.join(" "), visit);
        return;
    }
    if base == "find" {
        // The path arguments are the positional args before any predicate
        // (predicates start with '-'). Default to "." like find itself.
        let mut paths: Vec<String> = Vec::new();
        for a in args {
            if a.starts_with('-') { break; }
            paths.push(a.clone());
        }
        if paths.is_empty() { paths.push(".".into()); }

        let mut i = 0;
        while i < args.len() {
            let a = args[i].as_str();
            if a == "-delete" {
                // `find <path> -delete` is equivalent to `rm -rf <path>` for
                // the purposes of the circuit breaker.
                for p in &paths {
                    visit("rm", &["-rf".into(), p.clone()]);
                }
                i += 1;
                continue;
            }
            if matches!(a, "-exec" | "-execdir" | "-ok" | "-okdir") {
                let mut inner: Vec<String> = Vec::new();
                let mut j = i + 1;
                while j < args.len() && args[j] != ";" && args[j] != "+" {
                    inner.push(args[j].clone());
                    j += 1;
                }
                if !inner.is_empty() {
                    let prog = inner[0].clone();
                    let rest = &inner[1..];
                    // The inner command runs once per match with `{}` set to
                    // each matched path. Statically we don't know the matches,
                    // but we DO know they're rooted under one of `paths`; that
                    // is what the deny rules care about (rm/chmod under /).
                    for p in &paths {
                        let substituted: Vec<String> = rest.iter().map(|s| {
                            if s.contains("{}") { s.replace("{}", p) } else { s.clone() }
                        }).collect();
                        visit_invocation(&prog, &substituted, visit);
                    }
                }
                i = j + 1;
                continue;
            }
            i += 1;
        }
        return;
    }
    if base == "xargs" {
        let i = skip_xargs_flags(args);
        if i < args.len() {
            visit_invocation(&args[i], &args[i + 1..], visit);
        }
        return;
    }
}

// Programs we never run, regardless of arguments.
const DENIED_PROGRAMS: &[&str] = &[
    // Privilege escalation
    "sudo", "su", "doas",
    // System power
    "shutdown", "reboot", "halt", "poweroff",
    // Disk-destruction utilities
    "fdisk", "parted",
    // `mkfs` and friends (mkfs.ext4, mkfs.vfat, …) caught via prefix below
    "mkfs", "mke2fs", "mkswap",
];

// Paths whose recursive deletion / chmod would brick the system.
const ROOT_PATHS: &[&str] = &[
    "/", "/*", "/.", "/..",
    "~", "~/", "~/*",
    "$HOME", "$HOME/", "$HOME/*",
    "/etc", "/etc/", "/etc/*",
    "/usr", "/usr/", "/usr/*",
    "/bin", "/bin/", "/bin/*",
    "/sbin", "/sbin/", "/sbin/*",
    "/lib", "/lib/", "/lib/*",
    "/System", "/System/", "/System/*",
    "/var", "/var/", "/var/*",
    "/Users", "/Users/", "/Users/*",
    "/Library", "/Library/", "/Library/*",
    "/private", "/private/", "/private/*",
];

fn rm_targets_root(args: &[String]) -> bool {
    let recursive = args.iter().any(|a| {
        if a.starts_with("--") { a == "--recursive" }
        else if a.starts_with('-') { a.contains('r') || a.contains('R') }
        else { false }
    });
    if !recursive { return false; }
    args.iter().any(|a| ROOT_PATHS.iter().any(|r| a == *r))
}

fn dd_writes_disk(args: &[String]) -> bool {
    args.iter().any(|a| {
        if let Some(rest) = a.strip_prefix("of=") {
            rest.starts_with("/dev/disk")
                || rest.starts_with("/dev/sd")
                || rest.starts_with("/dev/nvme")
                || rest.starts_with("/dev/hd")
        } else { false }
    })
}

fn chmod_nukes_root(args: &[String]) -> bool {
    let recursive = args.iter().any(|a| a == "-R" || a == "--recursive");
    let nuke = args.iter().any(|a| a == "777");
    if !(recursive && nuke) { return false; }
    args.iter().any(|a| ROOT_PATHS.iter().any(|r| a == *r))
}

pub fn is_blocked(cmd: &str) -> bool {
    // Fork bomb — no clean tokenized form; substring match is fine here.
    let lower = cmd.to_lowercase();
    if lower.contains(":(){") || lower.contains(":() {") { return true; }

    let mut blocked = false;
    walk_invocations(cmd, &mut |prog, args| {
        if blocked { return; }
        let base = basename(prog).to_lowercase();
        for d in DENIED_PROGRAMS {
            if base == *d || base.starts_with(&format!("{}.", d)) {
                blocked = true; return;
            }
        }
        if base == "init" && args.iter().any(|a| a == "0" || a == "6") {
            blocked = true; return;
        }
        if base == "rm" && rm_targets_root(args) { blocked = true; return; }
        if base == "dd" && dd_writes_disk(args)  { blocked = true; return; }
        if base == "chmod" && chmod_nukes_root(args) { blocked = true; return; }
        // Network firewall flush — keep as block.
        if base == "iptables" && args.iter().any(|a| a == "-F") { blocked = true; return; }
        if base == "ufw" && args.iter().any(|a| a == "disable") { blocked = true; return; }
    });
    blocked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(c: &str) -> bool { is_blocked(c) }

    #[test]
    fn allows_benign() {
        assert!(!blocked("ls -la"));
        assert!(!blocked("echo hello"));
        assert!(!blocked("rm /tmp/x"));
        assert!(!blocked("rm -rf /tmp/foo"));
        assert!(!blocked("find /Users/me/Library/Caches -mindepth 1 -delete"));
    }

    #[test]
    fn blocks_rm_root() {
        assert!(blocked("rm -rf /"));
        assert!(blocked("rm -rf /*"));
        assert!(blocked("rm -rf ~"));
        assert!(blocked("rm -rf $HOME"));
        assert!(blocked("rm -rf /etc"));
        assert!(blocked("rm -rf /System"));
        assert!(blocked("rm  -rf  /"));      // extra whitespace
        assert!(blocked("rm\t-rf\t/"));      // tabs
        assert!(blocked("rm --recursive --force /"));
    }

    #[test]
    fn blocks_rm_root_through_wrappers() {
        assert!(blocked("sudo rm -rf /"));
        assert!(blocked("env FOO=1 rm -rf /"));
        assert!(blocked("timeout 5 rm -rf /"));
        assert!(blocked("nohup rm -rf / &"));
        assert!(blocked("sh -c 'rm -rf /'"));
        assert!(blocked("bash -c \"rm -rf /\""));
        assert!(blocked("sh -c 'rm -rf /etc'"));
    }

    #[test]
    fn blocks_rm_root_via_find_exec() {
        assert!(blocked("find / -exec rm -rf {} +"));
        assert!(blocked("find /etc -exec rm -rf {} \\;"));
        assert!(blocked("find / -delete"));
    }

    #[test]
    fn xargs_rm_falls_through_to_ts_prompt() {
        // `xargs rm -rf` receives its path argument from stdin, which we
        // can't statically resolve. The Rust circuit breaker doesn't fire,
        // so the TS classifier (which still sees this as `write`) gates it
        // with a confirmation prompt instead.
        assert!(!blocked("echo / | xargs rm -rf"));
    }

    #[test]
    fn blocks_privilege_escalation() {
        assert!(blocked("sudo ls"));
        assert!(blocked("su -"));
        assert!(blocked("doas vim /etc/hosts"));
        assert!(blocked("env sudo ls"));
    }

    #[test]
    fn blocks_system_power() {
        assert!(blocked("shutdown -h now"));
        assert!(blocked("reboot"));
        assert!(blocked("halt"));
        assert!(blocked("poweroff"));
        assert!(blocked("init 0"));
        assert!(blocked("init 6"));
    }

    #[test]
    fn blocks_mkfs_variants() {
        assert!(blocked("mkfs /dev/sda1"));
        assert!(blocked("mkfs.ext4 /dev/sda1"));
        assert!(blocked("mke2fs /dev/sda1"));
        assert!(blocked("fdisk /dev/sda"));
        assert!(blocked("parted /dev/sda mklabel gpt"));
    }

    #[test]
    fn blocks_dd_to_disk() {
        assert!(blocked("dd if=/dev/zero of=/dev/sda"));
        assert!(blocked("dd if=/some/file of=/dev/disk0"));
        assert!(blocked("dd if=/some/file of=/dev/nvme0n1"));
        assert!(!blocked("dd if=/some/file of=/tmp/out"));
    }

    #[test]
    fn blocks_chmod_777_root() {
        assert!(blocked("chmod -R 777 /"));
        assert!(blocked("chmod -R 777 /etc"));
        assert!(!blocked("chmod -R 777 /tmp/sandbox"));
    }

    #[test]
    fn blocks_command_substitution() {
        assert!(blocked("ls $(rm -rf /)"));
        assert!(blocked("echo `sudo rm -rf /`"));
    }

    #[test]
    fn blocks_fork_bomb() {
        assert!(blocked(":(){ :|:& };:"));
    }

    #[test]
    fn the_caches_case_is_not_blocked_but_classifier_would_prompt() {
        // The original user-reported command: a user-scoped cache wipe.
        // Rust does NOT block it (it's not root-targeted), but the TS
        // classifier should still trigger the write-confirmation prompt
        // because `find -exec rm` reaches `rm`.
        assert!(!blocked(
            "find '/Users/r_hasan/Library/Caches' -mindepth 1 -exec rm -rf {} + 2>/dev/null"
        ));
    }
}
