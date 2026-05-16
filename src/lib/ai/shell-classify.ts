// Shell command classification for the AI confirmation gate.
//
// The previous classifier matched leading-token regexes on the raw command
// string. That misses every form where the destructive program is reached
// via another program — `find … -exec rm`, `xargs rm`, `sh -c "rm …"`,
// `sudo<TAB>rm`, `$(echo rm) -rf /`, … The model is not adversarial, but
// it writes idiomatic shell, so prefix matching produces silent gate
// bypasses on routine commands.
//
// This module tokenizes the command (respecting single/double quotes,
// backslash escapes, `$(…)` and backticks), splits on top-level shell
// separators, then walks each segment looking through wrappers to find
// the actual program(s) being invoked. The worst classification reached
// anywhere in the tree wins.
//
// This is *not* a full bash parser. It covers the bypasses that come up
// in practice; exotic forms (arithmetic expansion, here-strings, brace
// expansion) fall through and return null — the Rust circuit breaker is
// the last line of defense for those.
//
// Mirror logic in src-tauri/src/shell_classify.rs — keep them in sync.

export type ConfirmKind = 'write' | 'read';

// Programs whose default behavior mutates the filesystem.
const WRITE_VERBS = new Set([
    'rm', 'mv', 'cp', 'dd', 'install', 'tee',
    'mkdir', 'rmdir', 'touch', 'truncate',
    'ln', 'chmod', 'chown', 'chgrp', 'chflags',
    'mkfs', 'mke2fs', 'mkswap', 'fdisk', 'parted',
    'rsync', 'shred',
]);

// Programs that dump file content to stdout (the model sees the body).
const READ_VERBS = new Set([
    'cat', 'less', 'more', 'head', 'tail', 'bat',
    'od', 'xxd', 'strings', 'tac', 'nl',
]);

// Wrappers that execute their argv-tail as another command. We skip the
// wrapper's own flags and recurse into the inner command.
const ARGV_WRAPPERS: Record<string, ReadonlySet<string>> = {
    sudo:     new Set(['-u', '-g', '-p', '-r', '-t', '-h', '-C', '-D']),
    doas:     new Set(['-u', '-a', '-C']),
    env:      new Set(['-u', '--unset']),
    nice:     new Set(['-n']),
    nohup:    new Set([]),
    timeout:  new Set(['-s', '-k', '--signal', '--kill-after']),
    time:     new Set(['-f', '-o', '--format', '--output']),
    stdbuf:   new Set(['-i', '-o', '-e']),
    setsid:   new Set([]),
    ionice:   new Set(['-c', '-n', '-p']),
    flock:    new Set(['-w', '-E']),
    unbuffer: new Set([]),
    watch:    new Set(['-n', '-d']),
};

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish']);

interface Word { value: string; cmdsubs: string[]; }
type Op = ';' | '&' | '&&' | '||' | '|' | '|&' | '\n' | '>' | '>>' | '<' | '<>';
type Tok = { kind: 'word'; word: Word } | { kind: 'op'; op: Op };

function tokenize(src: string): Tok[] {
    const toks: Tok[] = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
        const c = src[i];
        if (c === ' ' || c === '\t') { i++; continue; }
        if (c === '\n') { toks.push({ kind: 'op', op: '\n' }); i++; continue; }
        if (c === ';')  { toks.push({ kind: 'op', op: ';'  }); i++; continue; }
        if (c === '&')  {
            toks.push(src[i+1] === '&' ? { kind: 'op', op: '&&' } : { kind: 'op', op: '&' });
            i += src[i+1] === '&' ? 2 : 1;
            continue;
        }
        if (c === '|') {
            if (src[i+1] === '|')      { toks.push({ kind: 'op', op: '||' }); i += 2; }
            else if (src[i+1] === '&') { toks.push({ kind: 'op', op: '|&' }); i += 2; }
            else                       { toks.push({ kind: 'op', op: '|'  }); i++; }
            continue;
        }
        if (c === '>') {
            toks.push(src[i+1] === '>' ? { kind: 'op', op: '>>' } : { kind: 'op', op: '>' });
            i += src[i+1] === '>' ? 2 : 1;
            continue;
        }
        if (c === '<') {
            if (src[i+1] === '>') { toks.push({ kind: 'op', op: '<>' }); i += 2; continue; }
            if (src[i+1] === '(') {
                const [inner, end] = readBalanced(src, i + 2, ')');
                toks.push({ kind: 'word', word: { value: `<(${inner})`, cmdsubs: [inner] } });
                i = end + 1;
                continue;
            }
            toks.push({ kind: 'op', op: '<' }); i++;
            continue;
        }
        const [word, end] = readWord(src, i);
        toks.push({ kind: 'word', word });
        i = end;
    }
    return toks;
}

function readWord(src: string, start: number): [Word, number] {
    const n = src.length;
    let value = '';
    const cmdsubs: string[] = [];
    let i = start;
    while (i < n) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n') break;
        if (c === ';' || c === '|' || c === '&' || c === '<' || c === '>') break;
        if (c === '\\' && i + 1 < n) { value += src[i + 1]; i += 2; continue; }
        if (c === "'") {
            const j = src.indexOf("'", i + 1);
            if (j < 0) { value += src.slice(i + 1); i = n; break; }
            value += src.slice(i + 1, j);
            i = j + 1;
            continue;
        }
        if (c === '"') {
            let j = i + 1;
            while (j < n && src[j] !== '"') {
                if (src[j] === '\\' && j + 1 < n) { value += src[j + 1]; j += 2; continue; }
                if (src[j] === '$' && src[j + 1] === '(') {
                    const [inner, end] = readBalanced(src, j + 2, ')');
                    cmdsubs.push(inner);
                    value += `$(${inner})`;
                    j = end + 1;
                    continue;
                }
                if (src[j] === '`') {
                    const end = src.indexOf('`', j + 1);
                    const tEnd = end < 0 ? n : end;
                    cmdsubs.push(src.slice(j + 1, tEnd));
                    value += src.slice(j, tEnd + 1);
                    j = tEnd + 1;
                    continue;
                }
                value += src[j]; j++;
            }
            i = j + 1;
            continue;
        }
        if (c === '$' && src[i + 1] === '(') {
            const [inner, end] = readBalanced(src, i + 2, ')');
            cmdsubs.push(inner);
            value += `$(${inner})`;
            i = end + 1;
            continue;
        }
        if (c === '`') {
            const end = src.indexOf('`', i + 1);
            const tEnd = end < 0 ? n : end;
            cmdsubs.push(src.slice(i + 1, tEnd));
            value += src.slice(i, tEnd + 1);
            i = tEnd + 1;
            continue;
        }
        value += c; i++;
    }
    return [{ value, cmdsubs }, i];
}

function readBalanced(src: string, start: number, closer: ')' | '`'): [string, number] {
    const n = src.length;
    let depth = 1;
    let i = start;
    while (i < n) {
        const c = src[i];
        if (c === '\\' && i + 1 < n) { i += 2; continue; }
        if (c === "'") {
            const j = src.indexOf("'", i + 1);
            i = j < 0 ? n : j + 1;
            continue;
        }
        if (c === '"') {
            let j = i + 1;
            while (j < n && src[j] !== '"') {
                if (src[j] === '\\' && j + 1 < n) j += 2; else j++;
            }
            i = j + 1;
            continue;
        }
        if (closer === ')') {
            if (c === '(') { depth++; i++; continue; }
            if (c === ')') { depth--; if (depth === 0) return [src.slice(start, i), i]; i++; continue; }
        } else if (c === '`') {
            return [src.slice(start, i), i];
        }
        i++;
    }
    return [src.slice(start, n), n];
}

function basename(p: string): string {
    const s = p.replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
}

function isAssignment(s: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(s);
}

function severity(c: ConfirmKind | null): number {
    return c === 'write' ? 2 : c === 'read' ? 1 : 0;
}
function worst(a: ConfirmKind | null, b: ConfirmKind | null): ConfirmKind | null {
    return severity(a) >= severity(b) ? a : b;
}

function splitSegments(toks: Tok[]): Tok[][] {
    const segs: Tok[][] = [];
    let cur: Tok[] = [];
    for (const t of toks) {
        if (t.kind === 'op' && t.op !== '>' && t.op !== '>>' && t.op !== '<' && t.op !== '<>') {
            if (cur.length) segs.push(cur);
            cur = [];
        } else {
            cur.push(t);
        }
    }
    if (cur.length) segs.push(cur);
    return segs;
}

function skipWrapperFlags(base: string, args: string[]): number {
    const valFlags = ARGV_WRAPPERS[base] ?? new Set<string>();
    let i = 0;
    while (i < args.length) {
        const a = args[i];
        if (a === '--') return i + 1;
        if (!a.startsWith('-')) {
            if (base === 'env' && isAssignment(a)) { i++; continue; }
            return i;
        }
        if (valFlags.has(a)) i += 2; else i++;
    }
    return i;
}

function skipXargsFlags(args: string[]): number {
    const valFlags = new Set(['-I', '-n', '-P', '-d', '-E', '-L', '-s']);
    let i = 0;
    while (i < args.length) {
        const a = args[i];
        if (a === '--') return i + 1;
        if (!a.startsWith('-')) return i;
        if (valFlags.has(a)) i += 2; else i++;
    }
    return i;
}

function classifyInvocation(prog: string, args: string[]): ConfirmKind | null {
    const base = basename(prog);

    if (base in ARGV_WRAPPERS) {
        const i = skipWrapperFlags(base, args);
        if (i >= args.length) return null;
        return classifyInvocation(args[i], args.slice(i + 1));
    }

    if (SHELL_INTERPRETERS.has(base)) {
        const i = args.indexOf('-c');
        if (i >= 0 && i + 1 < args.length) return classifyShellCommand(args[i + 1]);
        // `sh script.sh` runs arbitrary code; treat as write conservatively.
        return args.length > 0 ? 'write' : null;
    }

    if (base === 'eval') {
        return classifyShellCommand(args.join(' '));
    }

    if (base === 'find') {
        let result: ConfirmKind | null = null;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === '-delete') { result = worst(result, 'write'); continue; }
            if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') {
                const inner: string[] = [];
                for (let j = i + 1; j < args.length; j++) {
                    const tok = args[j];
                    if (tok === ';' || tok === '+') break;
                    inner.push(tok);
                }
                if (inner.length > 0) {
                    result = worst(result, classifyInvocation(inner[0], inner.slice(1)));
                }
            }
        }
        return result;
    }

    if (base === 'xargs') {
        const i = skipXargsFlags(args);
        if (i >= args.length) return null;
        return classifyInvocation(args[i], args.slice(i + 1));
    }

    if (WRITE_VERBS.has(base)) return 'write';

    if (base === 'sed') {
        // sed -i = in-place edit
        if (args.some(a => a === '-i' || /^-i[^-]/.test(a) || a.startsWith('--in-place'))) return 'write';
        const nonFlag = args.filter(a => !a.startsWith('-'));
        return nonFlag.length >= 2 ? 'read' : null;
    }
    if (base === 'awk' || base === 'gawk' || base === 'mawk' || base === 'nawk') {
        const nonFlag = args.filter(a => !a.startsWith('-'));
        return nonFlag.length >= 2 ? 'read' : null;
    }

    if (READ_VERBS.has(base)) {
        // stdin-only is not a privacy concern; only flag when a real file arg
        // is present (i.e. some non-flag, non-`-` token).
        const fileArg = args.some(a => !a.startsWith('-') && a !== '-');
        return fileArg ? 'read' : null;
    }

    return null;
}

function classifySegment(seg: Tok[]): ConfirmKind | null {
    let result: ConfirmKind | null = null;

    // Output redirections at segment level imply a write, regardless of
    // the producing program (e.g. `echo secret > /etc/passwd`).
    for (let i = 0; i < seg.length; i++) {
        const t = seg[i];
        if (t.kind === 'op' && (t.op === '>' || t.op === '>>')) {
            const next = seg[i + 1];
            const tgt = next && next.kind === 'word' ? next.word.value : '';
            // /dev/null and friends are a non-event.
            if (tgt !== '/dev/null' && tgt !== '/dev/stderr' && tgt !== '/dev/stdout') {
                result = worst(result, 'write');
            }
        }
    }

    // Recurse into command substitutions inside any word.
    for (const t of seg) {
        if (t.kind === 'word') {
            for (const sub of t.word.cmdsubs) {
                result = worst(result, classifyShellCommand(sub));
            }
        }
    }

    // The program invocation itself.
    const words = seg
        .filter((t): t is Extract<Tok, { kind: 'word' }> => t.kind === 'word')
        .map(t => t.word.value);
    let idx = 0;
    while (idx < words.length && isAssignment(words[idx])) idx++;
    if (idx < words.length) {
        result = worst(result, classifyInvocation(words[idx], words.slice(idx + 1)));
    }
    return result;
}

export function classifyShellCommand(cmd: string): ConfirmKind | null {
    const toks = tokenize(cmd);
    const segs = splitSegments(toks);
    let result: ConfirmKind | null = null;
    for (const seg of segs) {
        result = worst(result, classifySegment(seg));
        if (result === 'write') return result;
    }
    return result;
}
