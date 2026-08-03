#!/usr/bin/env node
/**
 * Enforcement Hook — Soft block on dangerous tool calls
 *
 * Runs on PreToolUse for Edit, Write, and Bash.
 * Returns permissionDecision: "ask" for protected files and dangerous commands.
 * Fail-CLOSED: any internal error exits 2 (Codex-style hard block) so a
 * malformed payload can never accidentally bypass the guard.
 */

const {
  output,
  appendFile,
  getClaudeDir,
  getDateTimeString,
  log
} = require('../skills/strategic-compact/lib/utils');

const path = require('path');
const crypto = require('crypto');

// Private sentinels. These are module-local Symbols precisely so they
// CANNOT arrive from stdin: the previous marker was the property
// `__empty` on the parsed object, which put internal control state on
// the same channel as caller data. Any payload could set it, and
// `{"tool_name":"Bash","tool_input":{"command":"cat .env"},
// "__empty":true}` was silently allowed — a full bypass of the gate.
// A Symbol has no JSON representation, so no payload can forge one.
const EMPTY_PAYLOAD = Symbol('enforce.emptyPayload');
const MALFORMED_PAYLOAD = Symbol('enforce.malformedPayload');
// A read that never reached EOF. Distinct from MALFORMED_PAYLOAD only so the
// stderr line names the real cause; both fail closed.
const TIMEOUT_PAYLOAD = Symbol('enforce.timeoutPayload');

/**
 * Read stdin and parse JSON. Distinguishes four outcomes:
 *  - parsed: returns the parsed value
 *  - empty: returns the EMPTY_PAYLOAD symbol (ONLY after a genuine EOF)
 *  - malformed: returns MALFORMED_PAYLOAD (callers MUST fail closed)
 *  - timed out: returns TIMEOUT_PAYLOAD (callers MUST fail closed)
 *
 * The timeout branch used to call handleRaw on whatever had arrived so far,
 * which is a decision taken on a stream whose end has not been seen. Two ways
 * that allowed: a pipe that was still open but had sent no bytes trimmed to ''
 * and became EMPTY_PAYLOAD -> exit 0; and a SAFE COMPLETE PREFIX
 * ({"tool_name":"Bash","tool_input":{"command":"echo safe"}}) parsed and
 * allowed while dangerous trailing bytes were still in flight. Both were
 * measured against this file. Only 'end' may now produce a decision.
 *
 * The shared readStdinJson in lib/utils swallows parse errors and
 * returns {} which is a fail-open semantic. The hook is the LLM's
 * safety boundary (H1 audit); it must not be fail-open. So this
 * hook reads stdin directly instead.
 */
function readHookStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // NOT handleRaw(data): whatever arrived is a prefix, and a prefix is
      // not a payload. Fail closed.
      resolve(TIMEOUT_PAYLOAD);
    }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('error', () => {
      // Unreadable stdin is also a read that never reached EOF, but we know
      // it now — block immediately instead of stalling for the whole window.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(MALFORMED_PAYLOAD);
    });
    process.stdin.on('end', () => {
      // The ONLY path that may yield EMPTY_PAYLOAD or a parsed object.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { resolve(handleRaw(data, timeoutMs)); } catch { resolve(MALFORMED_PAYLOAD); }
    });
  });
}

function handleRaw(raw, timeoutMs) {
  const trimmed = raw.trim();
  if (!trimmed) return EMPTY_PAYLOAD;
  try {
    return JSON.parse(trimmed);
  } catch {
    return MALFORMED_PAYLOAD;  // caller must fail-closed
  }
}

// Protected file patterns (regex). Matched AFTER path normalization
// (path.resolve + lowercase) so `active/../secrets/.env` etc. are caught.
//
// WHAT THIS GATE DOES AND DOES NOT DO — read before changing it.
//
// It is a SUBSTRING MATCHER over an already-normalised command string
// and over structured path fields. It is NOT a shell parser. It has
// no model of quoting, word splitting, expansion or evaluation order.
//
// Covered: any path whose literal text contains `.env` — `.env`,
// `.envrc`, `.env.local`, `.env.production`, `prod.env`, `$D.env`,
// `"/project/.env"` — in a file_path field, an MCP path argument, a
// redirect target, a write-command argument, or anywhere in the
// command text.
//
// NOT covered, and cannot be without a real lexer: any construct
// where the shell COMPOSES the name from pieces that individually do
// not contain `.env`. Verified open, in this version and in every
// previous one:
//     printf x > .e''nv        (quote concatenation)
//     awk 1 .e''nv
// Escapes (`.e\nv`), globbing (`.en?`), and variable expansion
// (`X=nv; cat .e$X`) are the same class and equally open. Do not
// claim substring matching "catches every form" — it demonstrably
// does not; it only cannot be fooled by how a LITERAL token is
// spelled, which is a much smaller claim.
//
// Accepted cost: `\.env` also matches `process.env`, so
// `grep -rn process.env src/` asks. That noise is deliberate. An
// earlier round narrowed the pattern to kill it and reopened real
// write paths in the process; the owner chose noise over holes.
// In Cursor an "ask" becomes a hard deny, which is the cost.
//
// NOTE: an earlier comment claimed the permissive form was needed for
// `python3 -c "open('/env','w')"`. False — `\.env` needs a literal
// dot and `/env` has none. Do not widen on that basis.
//
// Each rule carries a CONSTANT id and label. Never build a reason
// string out of matched text, a candidate path or a basename: the
// reason is written to the log verbatim while only `detail` is
// hashed, so reflected input lands in the log in plaintext.
const PROTECTED_FILES = [
  { id: 'env-file', label: 'arquivo .env', re: /\.env/i },
  { id: 'pm2-ecosystem', label: 'ecosystem.config', re: /ecosystem\.config\./i },
  { id: 'nginx-config', label: 'config nginx', re: /nginx\./i },
  { id: 'nginx-dir', label: 'diretorio nginx', re: /[\/\\]nginx[\/\\]/i },
  { id: 'pm2-config', label: 'pm2.config', re: /pm2\.config\./i },
  // The hook files themselves — the LLM must NOT be able to rewrite
  // its own safety boundary. Covers enforce.js, enforce-codex.js,
  // pre-compact.js, session-start.js, suggest-compact.js, and the
  // entire active/rules/ + active/skills/strategic-compact/ directories.
  { id: 'hook-file', label: 'hook enforce', re: /active[\/\\]rules[\/\\]enforce(-codex)?\.js$/i },
  { id: 'hook-skill', label: 'hook strategic-compact', re: /active[\/\\]skills[\/\\]strategic-compact[\/\\].*\.(js|json)$/i },
  { id: 'hook-compact', label: 'hook compact', re: /strategic-compact[\/\\](session-start|pre-compact|suggest-compact)\.js$/i },
  // Round 7 (audit M3): the literal file is protected, but a
  // adjacent .bak / .orig / .tmp / ~ / .copy / .backup / .old /
  // .bk / .prev sibling is not. `mv` over the real file bypasses.
  // The pattern matches the protected file or any backup suffix on
  // it. Round 7 reviewer LOW-4: covers .backup/.copy/.old/.bk/.prev
  // (curated allowlist; an attacker only needs to find a suffix
  // outside the list, but the list is broad enough to cover
  // common editor and backup-tool conventions).
  { id: 'hook-file-bak', label: 'backup de hook enforce', re: /active[\/\\]rules[\/\\]enforce(-codex)?\.js(~|\.(bak|backup|copy|orig|old|bk|prev|tmp|swp|rej|save))?$/i },
  { id: 'hook-compact-bak', label: 'backup de hook compact', re: /strategic-compact[\/\\](session-start|pre-compact|suggest-compact)\.js(~|\.(bak|backup|copy|orig|old|bk|prev|tmp|swp|rej|save))?$/i }
];

// Template suffixes — safe to edit, meant to be committed.
// Restricted to .env* only (not arbitrary .template extensions) so a
// LLM cannot stage credentials via `.nginx.conf.template` then
// process them into the protected `.nginx.conf`.
const TEMPLATE_SUFFIXES = /\.env\.(example|sample|template|dist|default)$/i;

// Dangerous command patterns. Applied AFTER whitespace normalization
// AND after Unicode NFKC normalization (prevents soft-hyphen bypass).
// Each entry has either `pattern` (regex) or `tokenCheck` (function
// receiving tokenized command) for structured validation.
const DANGEROUS_COMMANDS = [
  // === Filesystem destruction ===
  { pattern: /\bpm2\s+(restart|stop|delete)\b/i, reason: 'PM2 lifecycle command' },
  {
    pattern: /\brm\s+(?:-{1,2}\S+\s+)*[\/~.\$\x24{]/i,
    reason: 'Recursive force delete on root/home/cwd/$VAR (rm with -r/-f)',
    flags: 'allow-long-flags'  // marker: regex also accepts --recursive --force
  },
  { pattern: /\bfind\s+(?:\S+\s+){0,5}-delete\b/i, reason: 'find -delete (mass recursive delete)' },
  { pattern: /\bdd\s+.*\bof=\/dev\/(sd|nvme|hd|vd)/i, reason: 'dd of=/dev/sd* (disk wipe)' },
  { pattern: /\bmkfs(\.\w+)?\s+\/dev\/(sd|nvme|hd|vd)/i, reason: 'mkfs on raw disk (filesystem wipe)' },
  { pattern: /\bchmod\s+(?:-R\s+|--recursive\s+)?[0-7]{3,4}\s+\//i, reason: 'chmod -R on root (privilege escalation prep)' },
  { pattern: /\bchown\s+(?:-R\s+|--recursive\s+)\S+\s+\//i, reason: 'chown -R on root' },

  // === Process / system control ===
  { pattern: /^\s*:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:&\s*\}\s*;:/i, reason: 'fork bomb (:(){:|:&};:)' },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, reason: 'system shutdown/reboot' },
  // kill PID 1 (any signal or none). Catches `kill 1`, `kill -1 1`,
  // `kill -9 -- 1`, `kill --signal=SIGTERM 1`, etc. The negative
  // lookahead `(?!\d)` prevents matching `kill 10` / `kill 11` / etc.
  { pattern: /\bkill\b[^&|;]*?\b1(?!\d)/i, reason: 'kill PID 1 (init)' },

  // === Remote code execution ===
  { pattern: /\b(curl|wget|fetch)\s+[^|]*\|\s*(bash|sh|zsh|dash|ksh|fish|python|perl|ruby|node)\b/i, reason: 'curl|sh (remote code execution)' },
  // `curl x > /tmp/y && bash /tmp/y` OR `curl -o /tmp/y x && bash /tmp/y`
  // (download + execute). NO \b before `>` (space-`>` is non-word).
  { pattern: /\b(curl|wget|fetch)\s+[^|&]*?(-[oO]\s+\S+|--output\s+\S+|>\s*\S+)[^|&;]*&&\s*(bash|sh|zsh|dash|ksh|fish|python|perl|ruby|node)\b/i, reason: 'curl >/-o file && bash (download + execute)' },
  { pattern: /\b(bash|sh|zsh|dash|ksh|fish)\s+<\s*\(\s*(curl|wget|fetch)\b/i, reason: 'bash <(curl) (process substitution RCE)' },
  { pattern: /\beval\s+(\$\(|\$\{|`)/i, reason: 'eval $(cmd) or eval ${} (RCE via substitution)' },
  { pattern: /\b(python|python3|perl|ruby|node|php)\s+-e\s+.*?(os\.system|subprocess|exec|system|spawn|child_process)/i, reason: 'python -c os.system / child_process.exec (RCE)' },

// === Git force push (regex backstop) ===
// Defense-in-depth: the primary detection is isGitForcePushReason
// (tokenizer) below, which catches flag-bearing variants like
// `git --git-dir=X push --force` that the regex cannot reach. These
// regexes remain as a backstop if the tokenizer ever fails.
{ pattern: /\bgit\s+push\s+.*--force(?!-with-lease)\b/i, reason: 'Force push (not --force-with-lease)' },
{ pattern: /\bgit\s+push\s+.*\s-f\b/i, reason: 'Force push (-f flag)' },
{ pattern: /\bgit\s+push\s+.*--mirror\b/i, reason: 'git push --mirror (mass ref overwrite)' },
{ pattern: /\bgit\s+push\s+.*--delete\b/i, reason: 'git push --delete (ref deletion)' },
{ pattern: /\bgit\s+push\s+.*--all\b/i, reason: 'git push --all (all branches)' },
{ pattern: /\bgit\s+push\s+.*\s-[dD]\b/i, reason: 'git push -d/-D (delete ref)' },
{ pattern: /\bgit\s+push\s+.*\s:\S+/i, reason: 'git push origin :branch (delete refspec)' },
{ pattern: /\bgit\s+push\s+.*--receive-pack=/i, reason: 'git push --receive-pack= (RCE vector)' },
{ pattern: /\bgit\s+push\s+.*--upload-pack=/i, reason: 'git push --upload-pack= (RCE vector)' },
{ pattern: /\bgit\s+push\s+.*\+\S+/i, reason: 'git push +refspec (force refspec)' },

  // === SQL destruction ===
  // \s+ reemplazado por [\s/*]+ so DROP/**/TABLE (MySQL comment-as-ws) is caught
  { pattern: /\bDROP[\s\/*]+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|FUNCTION|PROCEDURE|TRIGGER|USER|ROLE)\b/i, reason: 'SQL DROP statement' },
  { pattern: /\bTRUNCATE\s+(TABLE\s+)?\S+/i, reason: 'SQL TRUNCATE' },
  { pattern: /\bDELETE\s+FROM\s+\S+\s*;?\s*$/i, reason: 'SQL DELETE FROM (no WHERE)' },
  { pattern: /\bUPDATE\s+\S+\s+SET\s+[^;]+(;|$)/i, reason: 'SQL UPDATE (verify WHERE clause manually)' },
  { pattern: /\bGRANT\s+ALL\b/i, reason: 'SQL GRANT ALL' },

  // === Shell env injection (RCE vectors that bypass content checks) ===
  // NOTE: PATH, IFS, PROMPT_COMMAND, PYTHONSTARTUP excluded — too
  // common in legitimate shell idioms (`export PATH=$PATH:/x`,
  // `IFS= read -r`, `PROMPT_COMMAND='history -a' bash`,
  // `PYTHONSTARTUP=pythonrc.py python`). The signal-to-noise
  // ratio collapses; legitimate commands trigger ask too often.
  // The exotic ones below (GIT_SSH_COMMAND etc.) are rare in
  // normal cortex work and almost always indicate RCE.
  // Case-SENSITIVE on purpose, and the /i here was a real cost: POSIX
  // environment names are case-sensitive, so `env=development node app.js`
  // does not set ENV and `git_config_count=1 git status` does not set
  // GIT_CONFIG_COUNT — yet both were asking. Ordinary commands
  // interrupted is the failure mode this removes. Executable names stay
  // folded (see execName); only names the shell itself treats as
  // case-sensitive stay exact.
  { pattern: /\b(GIT_SSH_COMMAND|GIT_ASKPASS|LD_PRELOAD|LD_AUDIT|BASH_ENV|ENV)\s*=/, reason: 'shell env var injection' }
];

/**
 * Check if a file path matches any protected pattern.
 * Normalizes via path.resolve to defeat `active/../secrets` style bypass.
 */
function isProtectedFile(filePath) {
  if (!filePath) return null;
  if (TEMPLATE_SUFFIXES.test(filePath)) return null;
  // Resolve to absolute path; collapses `..` segments. The hook runs
  // with the LLM's cwd so the resolved path is meaningful.
  let resolved;
  try {
    resolved = path.resolve(filePath);
  } catch {
    return 'path invalido (regra: bad-path)';
  }
  // Also test the raw input — many editors pass relative paths that
  // are still inside protected trees.
  const candidates = [filePath, resolved];
  for (const candidate of candidates) {
    for (const rule of PROTECTED_FILES) {
      if (rule.re.test(candidate)) {
        // Constant per rule. No basename, no candidate, no matched text.
        return `${rule.label} (regra: ${rule.id})`;
      }
    }
  }
  return null;
}

// === MCP TOOL DETECTION (round 8, audit C8; round 8.1, C-6/7/8/9) ===
// An LLM can route file writes through MCP tool calls (e.g.
// `mcp__evil__write_file({ path: '/project/.env' })`) which the
// Edit/Write/Bash allowlist does not cover. We treat any tool whose
// name starts with `mcp__` as a potential file writer and check its
// tool_input for file_path-shaped fields. Read-only MCP calls
// (no file_path, or file_path to a non-protected path) are allowed
// silently so legitimate MCP servers (playwright, n8n, graphify-brain,
// MetaAds) keep working.
function isMcpTool(toolName) {
  // Round 8.1 review (C-8 / L-1): case-insensitive prefix match with
  // leading/trailing whitespace stripped. The MCP naming convention
  // is lowercase but a malicious MCP server could register any name.
  if (typeof toolName !== 'string') return false;
  return toolName.trim().toLowerCase().startsWith('mcp__');
}

// Field names treated as "file path" candidates. We intentionally
// err on the side of MORE fields — false positives just trigger an
// "ask" prompt, the user can confirm. Missing a real file path is
// the dangerous failure mode. Matched CASE-INSENSITIVELY (round 8.1
// C-7) to absorb PascalCase/SCREAMING_CASE conventions.
const MCP_FILE_FIELDS = [
  'file_path', 'filepath', 'filePath', 'FilePath', 'FILE_PATH',
  'path', 'Path', 'PATH',
  'target_path', 'targetPath', 'TargetPath',
  'dest', 'destination', 'Dest', 'Destination',
  'output', 'output_path', 'outputPath', 'OutputPath',
  // Round 8.1 M-1: plural/array field names
  'file_paths', 'filePaths', 'paths', 'Paths', 'files', 'targets', 'Targets',
  // Round 8.1 M-2: URI-based file reference (parsed for file:// scheme)
  'uri', 'URI'
];

// Decode percent-encoded path. Catches C-2 L-2 bypass
// `/project/%2eenv` → `/project/.env`. Fail-safe: if decoding throws,
// return original.
function decodeFilePath(p) {
  if (typeof p !== 'string') return p;
  try { return decodeURIComponent(p); } catch { return p; }
}

// Extract file:// path from a URI string. Returns the path or null.
function fileUriToPath(uri) {
  if (typeof uri !== 'string') return null;
  if (!/^file:\/\//i.test(uri)) return null;
  // file:///abs/path or file://localhost/abs/path
  return uri.replace(/^file:\/\/(?:localhost)?/i, '');
}

// Collect ALL file-path candidates from a tool_input. Returns an
// array of string paths. Each candidate is checked against
// isProtectedFile independently. Round 8.1 C-9: do NOT return on
// first match — a malicious MCP may pass a safe field and a
// dangerous field; we want to catch the dangerous one.
function getMcpFilePaths(toolInput) {
  const out = [];
  if (!toolInput || typeof toolInput !== 'object') return out;
  const fieldSet = new Set(MCP_FILE_FIELDS.map(f => f.toLowerCase()));
  for (const [k, v] of Object.entries(toolInput)) {
    if (!fieldSet.has(k.toLowerCase())) continue;
    // Round 8.1 M-2: handle `uri` field with file:// scheme
    let candidates;
    if (k.toLowerCase() === 'uri') {
      const p = fileUriToPath(v);
      candidates = p ? [p] : [];
    } else if (Array.isArray(v)) {
      // Round 8.1 C-6 / M-1: array values. Each element could be a
      // path, a string, or a nested object (M-3).
      candidates = [];
      for (const item of v) {
        if (typeof item === 'string') candidates.push(item);
        else if (item && typeof item === 'object') {
          // Nested object: pluck common path fields
          for (const [ik, iv] of Object.entries(item)) {
            if (fieldSet.has(ik.toLowerCase()) && typeof iv === 'string') {
              candidates.push(iv);
            }
          }
        }
      }
    } else if (typeof v === 'string') {
      candidates = [v];
    } else if (v && typeof v === 'object') {
      // Round 8.1 M-3: object value (e.g. `{ path: '/x/.env' }`)
      candidates = [];
      for (const [ik, iv] of Object.entries(v)) {
        if (fieldSet.has(ik.toLowerCase()) && typeof iv === 'string') {
          candidates.push(iv);
        }
      }
    } else {
      candidates = [];
    }
    for (const c of candidates) {
      const decoded = decodeFilePath(c);
      if (decoded && typeof decoded === 'string' && decoded.length > 0) {
        out.push(decoded);
      }
    }
  }
  return out;
}

// ===================================================================
// CEILING — WHAT THIS GATE IS, AND WHAT IT IS NOT
// ===================================================================
// This is a TOKEN-MATCHING GATE, not a shell parser.
//
// It normalises whitespace and Unicode, splits the command on whitespace
// and quotes, and compares the resulting tokens against a fixed
// vocabulary. It has no model of the shell's grammar: no word splitting,
// no expansion, no evaluation order, no notion of command position, and
// no notion of where one command ends and the next begins.
//
// It exists to catch CARELESS AND ACCIDENTAL invocations — an agent that
// reaches for `rm -rf /` or `git push --force` without thinking it
// through. It does NOT stop a determined adversary who controls the
// command string. Anyone who can choose the exact bytes of a command can
// get past it, and no amount of additional token rules changes that.
//
// KNOWN-OPEN, DELIBERATELY. Every line below was executed against all
// three runtimes on this machine and the per-runtime result recorded. The
// results are stated PER RUNTIME because the three do not agree, and a
// claim that is true of one guard and false of another is worse than no
// claim: it makes the whole block untrustworthy, which defeats the only
// reason a documented ceiling is acceptable in place of endless
// hardening. An earlier revision of this block asserted that every form
// here was "not detected by either guard" and listed `./tools-git`, which
// the Claude twin does in fact catch. Do not restate a claim here without
// re-running it in all three.
//
//   columns: claude = active/rules/enforce.js            (ask / free)
//            codex  = active/rules/enforce-codex.js      (block / free)
//            cursor = cursor/hooks/enforce-cursor.js     (deny / allow)
//   cursor delegates command inspection to claude, so it always mirrors
//   the claude column; it is listed anyway because the mapping is a fact
//   about the adapter that a reader should not have to infer.
//
//   command substitution — inline content is erased before matching
//     echo x$(Git --git-dir=/r push --force origin main)
//                                       free  / free  / allow   OPEN in all 3
//     echo x`Git --git-dir=/r push --force origin main`
//                                       free  / free  / allow   OPEN in all 3
//     echo x$(rm -rf /)                 ask   / free  / deny    open in codex only
//
//   unspaced operators — the tokenizer splits on whitespace, so an
//   operator glued to its neighbours never separates two commands
//     true;Git --git-dir=/r push --force origin main
//                                       free  / free  / allow   OPEN in all 3
//     true&&Git --git-dir=/r push --force origin main
//                                       free  / free  / allow   OPEN in all 3
//     true;rm -rf /                     ask   / free  / deny    open in codex only
//     cat f|rm -rf /                    ask   / free  / deny    open in codex only
//
//   executable path forms that are not the basename
//     ./tools-git push --force origin main
//                                       ask   / free  / deny    open in codex only
//     The Claude twin catches this one BY ACCIDENT, not by design: `\bgit`
//     in the /i regex backstop matches inside `tools-git` because `-` is a
//     non-word character. Rename the binary to `toolsgit` and it is open
//     there too. Do not read that column as coverage.
//
//   filenames the shell composes from pieces
//     printf x > .e''nv                 free  / free  / allow   OPEN in all 3
//
// The asymmetry above has one cause: active/rules/enforce.js has a second,
// blunt layer — the /i regexes in DANGEROUS_COMMANDS — while
// active/rules/enforce-codex.js has no backstop for git push or rm, so its
// tokenizer is its only detector. Neither file is closed; one is merely
// luckier, and only for the spellings that happen to keep `git` and `push`
// adjacent or `rm` at a word boundary.
//
// THIS CEILING IS A DECISION, NOT A GAP AWAITING A FIX. Six rounds of
// tokenizer hardening each found a new evasion of this same class, and
// the hardening had begun charging a price on ordinary work —
// `env=development node app.js` and `git_config_count=1 git status` were
// both interrupting the user. The owner's call is to stop at the
// envelope: keep fixing input-shape and identity bugs — payload keys,
// container names, executable basenames, fail-closed paths, all of which
// are bounded and have a right answer — and do not build a lexer.
//
// If you are reading this because you found another evasion of this
// class: it is already known. One more special case does not change the
// property. Closing it properly means a real shell lexer, which is a
// different project with a different risk profile — and the layer that
// actually contains a determined adversary is the permission system above
// this hook, not this hook.
// ===================================================================

// === GIT FORCE-PUSH TOKENIZER (round 8, audit C2; round 8.1 C-1/C-5/H-1) ===
// The regexes above require "git push" as adjacent words. A real
// bypass: `git --git-dir=/repo push --force` (no adjacent "git
// push"). Tokenize the command, find `git` followed (after any flag
// tokens) by `push`, then scan args for dangerous flags. Mirrors the
// Codex variant (enforce-codex.js) so both sides converge on the
// same detection.
function shellTokens(command) {
  const tokens = [];
  if (typeof command !== 'string') return tokens;
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = tokenPattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

// === EXECUTABLE IDENTITY (repair cycle 4) ===
// Token comparisons like `tokens[i] !== 'git'` decided detection by exact
// spelling of an attacker-controlled executable name, and both halves of
// that were wrong ON THIS PLATFORM. Measured here, not assumed:
//
//   Git --version    -> git version 2.54.0
//   command -v RM    -> /bin/RM
//   command -v GIT   -> /opt/homebrew/bin/GIT
//
// macOS's default filesystem is case-INSENSITIVE, so `Git` and `RM` launch
// the real binaries. And a path invocation (`/bin/rm`, `./git`,
// `/usr/bin/git`) never equals the bare name either. So an exact token
// test missed `Git --git-dir=/r push --force` and `/bin/rm -rf /`.
//
// Fix: compare the folded BASENAME. Narrow on purpose — this applies to
// executables only. Flags, git subcommands and env var names stay
// case-sensitive, because that reasoning does hold: `git PUSH` is
// rejected by git itself ("'PUSH' is not a git command", verified on this
// machine), `--MIRROR` is not a git flag, and `git_exec_path=` is not
// honoured. Folding those would add false positives and close nothing.
//
// Scope of that claim: it describes the TOKENIZER. It is not a statement
// about the whole file. The DANGEROUS_COMMANDS regex backstop carries /i,
// so `git push --FORCE origin main` IS still caught there whenever `git`
// and `push` are adjacent. The two layers disagree about case on
// purpose — the regex is a blunt second net, the tokenizer is the precise
// one.
//
// A token starting with `-` is a flag, never an executable, so it folds
// to '' and matches no name — that keeps `--git-dir=/repo/git` from being
// read as the git binary.
function execName(token) {
  if (typeof token !== 'string' || !token || token.startsWith('-')) return '';
  // `/` only. Splitting on `\` as well broke POSIX: a backslash is an
  // escape character here, not a path separator, so the safe command
  // `echo my\git push --force` had its token read as basename `git` and
  // blocked. Windows is not a supported target for this cortex.
  const base = token.split('/').pop() || '';
  return base.toLowerCase();
}

function isExec(token, name) {
  return execName(token) === name;
}

// Write-introducer executables for checkBashWriteToProtected, compared by
// folded basename for the same reason.
const WRITE_INTRO_EXECS = new Set(['tee', 'cp', 'mv', 'dd', 'ln', 'install', 'touch']);

// Long git flags that consume the next token as a value (round 8.1
// H-1). The `--flag=val` form is self-contained; the space-separated
// `--flag val` form requires us to skip the value token too.
const GIT_LONG_FLAGS_WITH_VALUE = new Set([
  '--git-dir', '--work-tree', '--namespace', '--exec-path',
  '--super-prefix', '--config-env', '--push-option',
  '--receive-pack', '--upload-pack'
]);

function isGitForcePushReason(command) {
  if (!command || typeof command !== 'string') return null;
  const tokens = shellTokens(command);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!isExec(tokens[i], 'git')) continue;
    // Skip flag-bearing tokens until we hit the subcommand. Long
    // flags with `=` are self-contained (`--git-dir=/repo`). Long
    // flags in `--flag val` form (H-1) consume the next token.
    // Short flags `-C` and `-c` take a separate value token.
    // RCE-vector flags (`--receive-pack`, `--upload-pack`,
    // `--push-option`) trigger an immediate return — the value is
    // not consumed; the flag itself is the attack (round 8.1).
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j];
      if (!tok.startsWith('-')) break;
      if (tok === '-C' || tok === '-c') {
        j += 2;
      } else if (tok === '-o' || tok === '--push-option' || tok.startsWith('--push-option=')) {
        // `-o` is the shorthand for `--push-option`. RCE vector:
        // the value is forwarded to the remote's pre-receive /
        // post-receive hook, which on self-hosted git may
        // shell-interpret it.
        return 'git -o/--push-option (forwarded to remote hook — RCE vector)';
      } else if (tok === '--receive-pack' || tok.startsWith('--receive-pack=')) {
        return 'git --receive-pack (RCE vector — arbitrary program launched on remote)';
      } else if (tok === '--upload-pack' || tok.startsWith('--upload-pack=')) {
        return 'git --upload-pack (RCE vector — arbitrary program launched)';
      } else if (tok.includes('=') || tok.startsWith('--no-')) {
        // Self-contained (`--git-dir=/x`) or boolean negator
        // (`--no-pager`) — consume one token.
        j += 1;
      } else if (GIT_LONG_FLAGS_WITH_VALUE.has(tok)) {
        // Long flag in space-separated form (`--git-dir /x`) —
        // consume flag + value.
        j += 2;
      } else {
        j += 1;
      }
    }
    if (tokens[j] !== 'push') continue;

    const args = tokens.slice(j + 1);
    for (const arg of args) {
      if (/^--force(?!-with-lease)(?:$|=)/.test(arg)) {
        return 'Force push (not --force-with-lease)';
      }
      if (/^-[A-Za-z]*f[A-Za-z]*$/.test(arg)) {
        return 'Force push (-f flag)';
      }
      // Force refspec: leading `+` (`+main`), trailing `+` (`main+`),
      // or `+` in the source side of a `src:dst` pair (`+main:dev`).
      // C-5: a `+` anywhere in the refspec arg indicates force.
      if (/\+/.test(arg) && /[A-Za-z0-9_\-\.\/]/.test(arg)) {
        return 'Force push (force refspec +)';
      }
      if (arg === '--mirror') return 'git push --mirror (mass ref overwrite)';
      if (arg === '--all') return 'git push --all';
      if (arg === '--delete' || arg === '-d' || arg === '-D') {
        return 'git push --delete (ref deletion)';
      }
      // `--receive-pack=`, `--upload-pack=`, `--push-option=` can
      // also appear POST-`push` (e.g. `git push --receive-pack=rm`).
      if (arg.startsWith('--receive-pack=') || arg === '--receive-pack') {
        return 'git push --receive-pack (RCE vector)';
      }
      if (arg.startsWith('--upload-pack=') || arg === '--upload-pack') {
        return 'git push --upload-pack (RCE vector)';
      }
      if (arg.startsWith('--push-option=') || arg === '--push-option') {
        return 'git push --push-option (forwarded to remote hook)';
      }
      // -o shorthand for --push-option (CRIT-6)
      if (arg === '-o') {
        return 'git push -o (forwarded to remote hook — RCE vector)';
      }
      if (arg.startsWith(':')) {
        return 'git push origin :ref (delete refspec)';
      }
    }
    // git push with no dangerous flag → no issue from the tokenizer.
    // The regex backstop will still catch any pattern the tokenizer
    // missed (and the regex is also a defense-in-depth check).
    return null;
  }
  return null;
}

// === DANGEROUS GIT CONFIG (round 8.1, C-1; round 8.2, C-3/4/8/9) ===
// `git -c key=val` can launch sub-processes via core.gitProxy /
// core.sshCommand / core.askpass / core.pager / diff.external /
// credential.helper / core.hookspath / include.path or define a
// shell alias via alias.<name>=!cmd. These are RCE vectors that the
// post-`push` arg scan cannot see — the attack lives in the
// pre-`push` flag value.
//
// Round 8.2 additions: include.path, includeif.path (CRIT-3/4),
// credential.helper (CRIT-8), diff.external (CRIT-9), and
// `protocol.*.allow` for the `clone` family.
const DANGEROUS_GIT_CONFIG_KEYS = [
  // Sub-process launchers
  'core.gitproxy', 'core.sshcommand', 'core.askpass', 'core.pager',
  // RCE on diff invocation
  'diff.external',
  // RCE on credential retrieval (push/fetch/clone of private repos)
  'credential.helper',
  // RCE via custom hook directory
  'core.hookspath',
  // RCE via config inclusion (chained load → define core.gitProxy etc.)
  'include.path', 'includeif.path',
  // Transport config: only dangerous if value is non-trivial; we block by default
  'protocol.file.allow', 'protocol.git.allow'
];
const DANGEROUS_GIT_ALIAS = /^alias\.[^=]+=!/;  // alias.x=!cmd

function isDangerousGitConfig(command) {
  if (!command || typeof command !== 'string') return null;
  // Find all `-c <key=val>` pairs. Match the value token AFTER
  // `-c`; the key may contain dots. Also accept `-c=key=val` form
  // (sloppy defense, but some shells allow it).
  const tokens = shellTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    let val = '';
    if (tokens[i] === '-c' || tokens[i] === '--config') {
      val = tokens[i + 1] || '';
    } else if (tokens[i].startsWith('-c=') || tokens[i].startsWith('--config=')) {
      val = tokens[i].slice(tokens[i].indexOf('=') + 1);
    } else {
      continue;
    }
    const eq = val.indexOf('=');
    if (eq < 0) continue;
    const key = val.slice(0, eq).toLowerCase();
    const valPart = val.slice(eq + 1);
    if (DANGEROUS_GIT_CONFIG_KEYS.includes(key)) {
      return `git -c ${key}= (RCE via sub-process launcher)`;
    }
    if (DANGEROUS_GIT_ALIAS.test(val)) {
      return `git -c alias.x=!cmd (shell alias injection)`;
    }
    if (DANGEROUS_GIT_ALIAS.test(key + '=' + valPart)) {
      return `git -c alias.x=!cmd (shell alias injection)`;
    }
  }
  return null;
}

// === GIT_CONFIG_* ENVIRONMENT VARIABLES (round 8.2, CRIT-5) ===
// Git accepts config via env vars (documented in git-config(1)):
//   GIT_CONFIG_COUNT=N
//   GIT_CONFIG_KEY_0=key GIT_CONFIG_VALUE_0=value
//   GIT_CONFIG_NAMED_<name>=key=value
// These are equivalent to `-c key=value` and just as dangerous.
// Scan the ORIGINAL normalized string (not tokenized) for these.
function isDangerousGitConfigEnv(command) {
  if (!command || typeof command !== 'string') return null;
  // GIT_CONFIG_COUNT_0/1/2 paired with GIT_CONFIG_KEY_n and
  // GIT_CONFIG_VALUE_n. Block any setting of GIT_CONFIG_COUNT_*
  // OR any GIT_CONFIG_KEY_n (we don't know what value follows).
  // Also block GIT_CONFIG_NAMED_*. Also block GIT_CONFIG_GLOBAL,
  // GIT_CONFIG_SYSTEM (overrides config file paths).
  // Measured against git 2.54 on this machine with
  // `<assignment> git config --get inject.probe`:
  //     GIT_CONFIG_COUNT + KEY_n/VALUE_n   HONOURED
  //     GIT_CONFIG_GLOBAL=<file>           HONOURED
  //     GIT_CONFIG_SYSTEM=<file>           HONOURED
  //     GIT_CONFIG=<file>                  HONOURED
  //     GIT_CONFIG_NAMED_evil=k=v          ignored
  //     GIT_CONFIG_COUNT_0=1               ignored
  // The previous alternation was wrong in both directions: it blocked the
  // two spellings git ignores (so the widening added last cycle protected
  // against nothing) and missed `GIT_CONFIG=` and `GIT_CONFIG_NOSYSTEM`,
  // which git does honour — NOSYSTEM disables system configuration, i.e.
  // it removes a control rather than adding one. This pattern is now
  // exactly git's documented environment family and nothing else.
  //
  // Case-SENSITIVE, no /i: environment names are case-sensitive, so
  // `git_config_count=1 git status` is an ordinary command and must not
  // interrupt the user.
  if (/\bGIT_CONFIG(_(GLOBAL|SYSTEM|NOSYSTEM|COUNT|KEY_\d+|VALUE_\d+))?\s*=/.test(command)) {
    return 'GIT_CONFIG_* env var injection (RCE via git config)';
  }
  // Also block other less-known but equally dangerous env vars
  if (/\bGIT_EXEC_PATH\s*=/.test(command)) {
    return 'GIT_EXEC_PATH env var injection (RCE via sub-process launcher)';
  }
  if (/\bGIT_SSH_COMMAND\s*=/.test(command)) {
    return 'GIT_SSH_COMMAND env var injection (RCE via ssh launcher)';
  }
  if (/\bGIT_ASKPASS\s*=/.test(command)) {
    return 'GIT_ASKPASS env var injection (RCE via credential helper)';
  }
  return null;
}

// === SHELL FLATTENING (round 8.1, C-3 / C-4) ===
// Detects destructive patterns hidden inside subshells and command
// substitutions. Examples:
//   `bash -c "git push --force"`          → flatten to `git push --force`
//   `git$(echo) push --force`             → flatten to `git push --force`
//   `$(xargs -I{} git push --force {} )`  → flatten to `git push --force`
//   `` git`echo` push --force ``          → flatten to `git push --force`
//
// Strategy: iteratively extract content of $(...) (balanced
// parens), backticks, and `bash -c "..."` blocks. Two replace
// modes:
//   * INLINE substitution (no surrounding whitespace, e.g.
//     `git$(echo) push`): replace with EMPTY so the surrounding
//     characters join up. `git$(echo) push` → `git push`.
//   * STANDALONE substitution (surrounded by whitespace, e.g.
//     `$(rm -rf /)` or `eval $(curl x)`): replace with the inner
//     content so downstream patterns see the inner command. The
//     original normalized string is also checked by the regex loop
//     so `eval $()` / `bash <(curl)` patterns (which depend on the
//     `$` / `<(` markers) still match.
function flattenShellCommand(command) {
  if (typeof command !== 'string') return command;
  let result = command;
  let prev;
  let iterations = 0;
  do {
    prev = result;
    // $(...) with one level of nested parens. Distinguish inline vs
    // standalone by inspecting the surrounding character at the
    // match offset.
    result = result.replace(
      /\$\(([^()]*\([^()]*\)[^()]*|[^()]*)\)/g,
      (match, inner, offset, full) => {
        const before = offset > 0 ? full[offset - 1] : ' ';
        const after = offset + match.length < full.length ? full[offset + match.length] : ' ';
        const isInline = /\S/.test(before) || /\S/.test(after);
        return isInline ? '' : ' ' + inner + ' ';
      }
    );
    // Backticks: same inline/standalone distinction.
    result = result.replace(/`([^`]*)`/g, (match, inner, offset, full) => {
      const before = offset > 0 ? full[offset - 1] : ' ';
      const after = offset + match.length < full.length ? full[offset + match.length] : ' ';
      const isInline = /\S/.test(before) || /\S/.test(after);
      return isInline ? '' : ' ' + inner + ' ';
    });
    // bash/sh/zsh/dash/ksh/fish -c "..." or '...'
    result = result.replace(
      // /i: the shell name is an executable name, so it is subject to the
      // same case-insensitive resolution as `git` and `rm` above.
      // `BASH -c "rm -rf /"` was never flattened without it.
      /\b(?:bash|sh|zsh|dash|ksh|fish)\s+-c\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gi,
      ' $1$2 '
    );
    iterations++;
  } while (result !== prev && iterations < 32);
  return result;
}

/**
 * Check if a Bash command writes to a protected file via a path
 * OTHER than direct Edit/Write (which the early-return catches).
 * Catches tee/cp/mv/sed -i/dd of=/ln -s/install/touch/redirection
 * patterns. Round 7 (audit C9): the prior cortex protected `.env`,
 * `nginx.*`, etc. against Edit/Write only — a single `tee
 * /project/.env < /etc/passwd` slipped through. This function
 * tokenizes the command and inspects every argument that could be
 * a destination path, plus any `>`, `>>`, `>|` redirect target.
 *
 * Returns a reason string if the command would write to a protected
 * file, null otherwise.
 */
function checkBashWriteToProtected(command) {
  if (!command || typeof command !== 'string') return null;
  const normalized = command.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // Pull redirect targets (>, >>, >|, 2>, 2>&1, etc.) — these are
  // file destinations, not arguments. Strip the leading fd digit(s)
  // and operator. Round 7 reviewer: strip surrounding quotes from
  // the captured target (bash -c "echo > /env" leaves a trailing ").
  const redirectTargets = [];
  const reRedirect = /(?:^|\s)(?:&?\d?>+\s*|&?\d*>&?\d*\s*)([^\s|&;"']+)/g;
  let m;
  while ((m = reRedirect.exec(normalized)) !== null) {
    const target = m[1].replace(/^["']|["']$/g, '');
    if (/^[\/.\w-]+\.\w+$/.test(target) || target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) {
      redirectTargets.push(target);
    }
  }

  // Pull command arguments after known write-introducers. The pattern
  // matches: <cmd> [flags] DEST [more...] or <cmd> [flags] SRC DEST.
  // For each, identify the LAST path-like argument as the destination.
  // Note: `sed -i` and `perl -pi/-i` (in-place) are included.
  // The regex precondition that used to gate this block is GONE. It was
  // a second, case-SENSITIVE spelling of a check the per-token scan below
  // already performs properly, so `SED -i s/a/b/ /project/.env` never
  // entered the block at all. Two expressions of one rule is exactly how
  // that drifted; now there is one. The scan is cheap and simply yields
  // no candidates when the command has no write introducer.
  {
    // Tokenize and walk
    const tokens = normalized.split(/\s+/);
    // Find indices of write-introducer tokens
    const writeIdxs = [];
    for (let i = 0; i < tokens.length; i++) {
      // Folded basename, so `/bin/tee` and `TEE` are recognised. The
      // in-place FLAGS stay case-sensitive: `sed -I` is not sed's
      // in-place flag.
      const exec = execName(tokens[i]);
      if (WRITE_INTRO_EXECS.has(exec)) writeIdxs.push(i);
      if (exec === 'sed' && /^-i[.\w]*$|^--in-place$/.test(tokens[i + 1] || '')) {
        writeIdxs.push(i);
      }
      // perl -pi[-ext] / -i[-ext] (in-place edit)
      if (exec === 'perl' && /^-pi[.\w]*$|^-i[.\w]*$/.test(tokens[i + 1] || '')) {
        writeIdxs.push(i);
      }
    }

    // For each write command, the destination is the last non-flag
    // token after the introducer.
    const destCandidates = [];
    for (const idx of writeIdxs) {
      for (let j = idx + 1; j < tokens.length; j++) {
        const tok = tokens[j];
        if (tok === '|' || tok === '||' || tok === '&&' || tok === ';') break;
        if (tok.startsWith('-')) continue;  // skip flags like -r, -f
        destCandidates.push(tok.replace(/^["']|["']$/g, ''));
      }
    }

    // Test redirect targets + dest candidates against PROTECTED_FILES
    const allCandidates = [...redirectTargets, ...destCandidates];
    for (const cand of allCandidates) {
      const reason = isProtectedFile(cand);
      if (reason) {
        return `Bash escreve em arquivo protegido: ${reason}`;
      }
    }
  }

  // Final pass (round 7 reviewer MEDIUM-3): scan the WHOLE normalized
  // command string for any substring that looks like a protected
  // path. Catches cases where the path is buried inside a quoted
  // arg to a non-introducer command (e.g. `python3 -c
  // "open('/project/.env','w').write('evil')"`). Note the DOTTED path:
  // `open('/env','w')` is not matched by anything here, because
  // `\.env` needs a literal dot and `/env` has none. False-positive risk is acceptable: the
  // user can confirm legitimate cases.
  // Runs ALWAYS (not just when an introducer is present) so paths
  // buried in python/ruby/awk/etc. are caught.
  for (const rule of PROTECTED_FILES) {
    if (rule.re.test(normalized)) {
      // Constant per rule — never the matched text.
      return `Bash menciona caminho protegido: ${rule.label} (regra: ${rule.id})`;
    }
  }

  return null;
}

/**
 * Check if a command matches any dangerous pattern.
 * Normalizes whitespace AND unicode before matching.
 */
function isDangerousCommand(command) {
  if (!command) return null;
  // Coerce non-string payloads (e.g. arrays) to a string. Crash-
  // proofing without fail-open: if we cannot produce a string, return
  // null and let the fail-closed main() handle the unsafe path.
  if (typeof command !== 'string') {
    if (Array.isArray(command)) {
      command = command.filter(x => typeof x === 'string').join(' ');
    } else {
      return null;
    }
  }
  // NFKC normalizes unicode (catches soft-hyphen / zero-width tricks).
  // Whitespace collapse: multiple spaces, tabs, newlines → single space.
  const normalized = command.normalize('NFKC').replace(/\s+/g, ' ').trim();

  // Round 8.1: flatten subshells and command substitutions first so
  // patterns hidden inside `bash -c`, `$(...)`, or backticks are
  // visible to the downstream checks. `git$(echo) push --force`
  // becomes `git  push --force` and is matched by the tokenizer.
  // NOTE: flattening strips the `$()` / backtick markers that the
  // `eval $()` / `bash <(curl)` patterns look for. We therefore run
  // the regex on BOTH the original normalized string (preserves
  // markers) and the flattened string (catches subshell-hidden
  // commands).
  const flattened = flattenShellCommand(normalized);

  // Tokenizer check on flattened string: catches git variants where
  // flags intervene between `git` and `push` (e.g. `git --git-dir=X
  // push --force`). The regex backstop below covers additional
  // patterns; both are defense-in-depth, but the tokenizer is the
  // more thorough path.
  const gitReason = isGitForcePushReason(flattened);
  if (gitReason) return gitReason;

  // Round 8.1 C-1: scan for dangerous `git -c key=val` configs
  // (sub-process launchers + shell aliases). Catches payloads the
  // post-`push` arg scan cannot see.
  const gitConfigReason = isDangerousGitConfig(flattened);
  if (gitConfigReason) return gitConfigReason;

  // Round 8.2 CRIT-5: GIT_CONFIG_* env vars (GIT_CONFIG_COUNT,
  // GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n, GIT_CONFIG_NAMED_*) are
  // equivalent to -c key=value and bypass the token-based scan.
  // Run on the ORIGINAL normalized string (env vars precede the
  // command, not inside it; the flatten pass doesn't change them).
  const gitConfigEnvReason = isDangerousGitConfigEnv(normalized);
  if (gitConfigEnvReason) return gitConfigEnvReason;

  for (const { pattern, reason } of DANGEROUS_COMMANDS) {
    if (pattern.test(normalized) || pattern.test(flattened)) {
      return reason;
    }
  }
  return null;
}

// Tool names reach the log ONLY as a fixed category plus a hash. The
// name is caller-controlled on the MCP path, where a newline forges a
// whole extra log record and a sensitive name leaks verbatim.
const TOOL_CATEGORIES = ['Bash', 'Edit', 'Write'];

// Gate membership, case-folded. `['Edit','Write','Bash'].includes(name)`
// decided authority by exact spelling over a caller-controlled string, so
// `bash` and `BASH` were members of nothing and exited 0 with every gate
// skipped — the same free pass H1 closed for a blank name, reachable by
// changing one letter's case. The file already established folding as the
// right discipline for tool-name authority (`isMcpTool` folds before its
// `mcp__` prefix test); the gate list simply did not follow it.
const MONITORED_TOOLS = new Set(['edit', 'write', 'bash']);

// === PAYLOAD KEY LOOKUP IS CASE-FOLDED (repair cycle 4) ===
// `data.tool_input`, `toolInput.file_path` and `toolInput.command` were
// literal property reads. A property name is part of the payload, so the
// caller controls its spelling, and the exact-case read failed OPEN:
// `{"tool_name":"Bash","tool_input":{"Command":"rm -rf /"}}` and
// `{"tool_name":"Write","Tool_Input":{"file_path":"/project/.env"}}` both
// exited 0 with nothing checked. Note that the container name needs
// folding as much as the leaf key does.
//
// This is FOLDING, not widening. The vocabulary is exactly what these
// branches already read: container `tool_input`, Edit/Write leaf
// `file_path`, Bash leaf `command`. `filepath` and `path` are NOT added —
// they are different key names, not case variants, and smuggling them in
// under cover of a folding fix would be a widening change. (The MCP
// branch keeps its own, broader vocabulary in MCP_FILE_FIELDS, which was
// already folded.)
const TOOL_INPUT_KEYS = new Set(['tool_input']);
const EDIT_PATH_KEYS = new Set(['file_path']);
const BASH_COMMAND_KEYS = new Set(['command']);

// Every own key of `container` whose folded name is in `keySet`, in
// declaration order. Collisions yield BOTH values, so a safe `command`
// cannot shadow a dangerous `Command` — the validate-all property the
// alias round won, now applied across case. A null / array / primitive
// container yields nothing instead of throwing.
function foldedValues(container, keySet) {
  const out = [];
  if (!container || typeof container !== 'object' || Array.isArray(container)) return out;
  for (const [key, value] of Object.entries(container)) {
    if (keySet.has(key.toLowerCase())) out.push(value);
  }
  return out;
}

function toolCategory(toolName) {
  if (typeof toolName !== 'string') return 'other';
  const folded = toolName.trim().toLowerCase();
  // Folded for the same reason the gate is: a `bash` call is gated as
  // Bash, and logging it as `other` would send an incident review looking
  // for a tool that was never involved. The emitted value is still one of
  // the fixed constants — the caller's spelling never reaches the line.
  const known = TOOL_CATEGORIES.find(c => c.toLowerCase() === folded);
  if (known) return known;
  if (folded.startsWith('mcp__')) return 'mcp';
  return 'other';
}

// Unicode control (Cc), format (Cf), line- and paragraph-separator
// categories. The previous \x00-\x1f\x7f class left the C1 block
// intact — U+0085 NEL and U+009B CSI among them — so the "cannot forge
// a record boundary" claim did not actually hold.
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

// The same categories plus \p{Zs} (spaces), used to ask whether a
// supplied tool name carries any VISIBLE character. A name that renders
// as nothing cannot be attributed to a caller, cannot be matched against
// the monitored-tool list, and cannot be shown to a human.
const NAME_INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu;

function sha12(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12);
}

/**
 * Log a blocked action to debug/enforce.log.
 *
 * Invariant: ONE record is exactly ONE line, and no field of that line
 * is caller-controlled. Three separate rounds leaked through this one
 * line — a raw path, then matched text, then the tool name — each fix
 * patching the field that was named and leaving its neighbour. So the
 * guarantee is now structural rather than per-field: every value is
 * either a constant, an internally-generated timestamp, or a hash, and
 * the assembled line is stripped of newlines and control characters
 * before it is written. A future edit that interpolates something
 * unsafe still cannot forge a record boundary.
 */
function logBlock(toolName, reason, detail) {
  const debugPath = path.join(getClaudeDir(), 'debug', 'enforce.log');
  const line = `${[
    `[${getDateTimeString()}]`,
    'BLOCKED',
    `tool=${toolCategory(toolName)}`,
    `tool_sha256_12=${sha12(toolName)}`,
    `reason=${reason}`,
    `detail_sha256_12=${sha12(detail)}`,
  ].join(' ').replace(CONTROL_CHARS, ' ')}\n`;
  try {
    appendFile(debugPath, line);
  } catch {
    // Don't crash on log failure
  }
}

async function main() {
  const data = await readHookStdin(5000);

  // Fail-CLOSED: malformed JSON → block. An attacker who can cause
  // the hook to receive garbage (binary payload, partial stream,
  // etc.) cannot exploit the catch block to silently allow.
  if (data === TIMEOUT_PAYLOAD) {
    log('[Enforce] stdin read timed out before EOF — blocking as fail-closed');
    process.exit(2);
  }
  if (data === MALFORMED_PAYLOAD || data === null) {
    log('[Enforce] Malformed stdin payload — blocking as fail-closed');
    process.exit(2);
  }
  // Empty payload: legitimate "no tool call yet" case (PreToolUse may
  // not fire if no tool was used). Identified by an out-of-band
  // Symbol, never by a property of the payload — and reachable ONLY from
  // the 'end' handler, so "empty" always means "EOF with no bytes", never
  // "no bytes yet".
  if (data === EMPTY_PAYLOAD) {
    process.exit(0);
  }
  // Valid JSON that is not an object (null, 5, "str", []) cannot carry
  // a tool call. Fail closed rather than reading fields off it.
  if (typeof data !== 'object' || Array.isArray(data)) {
    log('[Enforce] Non-object payload — blocking as fail-closed');
    process.exit(2);
  }

  // H1 — fail-CLOSED on unusable provenance.
  //
  // `data.tool_name || ''` collapsed a missing name — and `null`, `0`,
  // `false`, `""`, `"   "`, a zero-width name — into the empty string.
  // The empty string is a member of no protected-tool list, so the
  // `['Edit','Write','Bash'].includes(...)` filter below exited 0 and
  // EVERY gate was skipped: `{"tool_input":{"command":"cat .env"}}`
  // walked past the .env check, the dangerous-command check and the MCP
  // path check alike. A tool call we cannot attribute is not a safe tool
  // call; it is one we cannot evaluate, and this hook blocks what it
  // cannot evaluate.
  //
  // Ordering matters and is deliberate: genuinely empty stdin (no tool
  // call at all) was already answered above via EMPTY_PAYLOAD → exit 0.
  // This branch only ever sees a real JSON object that failed to say
  // what tool it is.
  const rawToolName = data.tool_name;
  if (typeof rawToolName !== 'string'
      || !rawToolName.replace(NAME_INVISIBLE_CHARS, '')) {
    log('[Enforce] Missing or unusable tool_name — blocking as fail-closed');
    process.exit(2);
  }
  // `toolName` keeps the caller's spelling for the log and for anything
  // human-facing; `toolKey` is what decides routing. Note the deliberate
  // limit of the blankness test above: it catches control, format and
  // separator categories, not homoglyphs. `"\u3164"` (HANGUL FILLER)
  // renders blank but is category Lo, so it passes here — and that is
  // correct, because it is simply an unrecognised tool name, which is
  // ungated by design (see the early return below). No blocklist needed.
  const toolName = rawToolName.trim();
  const toolKey = toolName.toLowerCase();
  // EVERY spelling of the container is validated, not the first one
  // found. An absent tool_input yields an empty list, so both loops below
  // no-op and the hook exits 0 exactly as `|| {}` used to.
  const toolInputs = foldedValues(data, TOOL_INPUT_KEYS);

  // MCP tools (round 8, audit C8): an LLM could call e.g.
  // `mcp__evil__write_file({ path: '/project/.env' })` and route
  // around the Edit/Write/Bash allowlist. Treat any tool whose name
  // starts with `mcp__` as a potential file writer. If its tool_input
  // has a file_path-shaped field that matches a protected pattern,
  // ask. Otherwise allow silently (legitimate read-only MCP calls
  // still work).
  if (isMcpTool(toolName)) {
    // Round 8.1 C-9: check ALL path candidates. A malicious MCP may
    // pass multiple fields, some safe and some dangerous. We need
    // to catch the dangerous one.
    const candidates = toolInputs.flatMap(ti => getMcpFilePaths(ti));
    for (const filePath of candidates) {
      const reason = isProtectedFile(filePath);
      if (reason) {
        logBlock(toolName, reason, filePath);
        output({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `⚠️ MCP tool targeting protected file: ${reason}. Confirme com o dono antes de prosseguir.`
          }
        });
        process.exit(0);
      }
    }
    // MCP tool without any file path (or only safe paths) → allow
    process.exit(0);
  }

  // Early return for non-monitored tools (Read, AskUserQuestion, etc).
  // NOTE: do NOT use this as a bypass channel — see PROTECTED_FILES
  // for MCP tools that could route around via other tool names.
  //
  // Unknown names passing free is CORRECT and deliberate: Claude Code has
  // dozens of read-only tools and denying every unrecognised name would
  // brick the session. What must not happen is a KNOWN monitored tool
  // escaping its gate by capitalisation, which is why membership is
  // decided on the folded key rather than the raw spelling.
  if (!MONITORED_TOOLS.has(toolKey)) {
    process.exit(0);
  }

  // Check file operations. Every supplied container and every folded
  // spelling of file_path is checked, so a safe path cannot shadow a
  // protected one.
  if (toolKey === 'edit' || toolKey === 'write') {
    const filePaths = toolInputs.flatMap(ti => foldedValues(ti, EDIT_PATH_KEYS));
    for (const filePath of filePaths) {
      const reason = isProtectedFile(filePath);
      if (reason) {
        logBlock(toolName, reason, filePath);
        output({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `⚠️ Ação protegida: ${reason}. Confirme com o dono antes de prosseguir.`
          }
        });
        process.exit(0);
      }
    }
  }

  // Check bash commands. Same validate-all rule across containers and
  // across case: a safe `command` beside a dangerous `Command` blocks.
  if (toolKey === 'bash') {
    const rawCommands = toolInputs.flatMap(ti => foldedValues(ti, BASH_COMMAND_KEYS));
    for (const rawCommand of rawCommands) {
      let command = rawCommand;
      if (Array.isArray(command)) {
        command = command.filter(x => typeof x === 'string').join(' ');
      } else if (typeof command !== 'string') {
        // Non-string non-array (object, number, null) — treat as no
        // command. The default-allow branch below will exit 0 silently.
        command = '';
      }
      // Two-layer check: (1) command-level dangerous patterns (regex),
      // (2) write-target patterns — Bash commands that write to a
      // protected file via tee/cp/mv/sed/dd/ln/install/touch/redirection
      // (round 7, audit C9). The write-target check operates on the
      // command's tokenized arguments and any redirect target.
      const dangerousReason = isDangerousCommand(command);
      if (dangerousReason) {
        logBlock(toolName, dangerousReason, command);
        output({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `⚠️ Ação protegida: ${dangerousReason}. Confirme com o dono antes de prosseguir.`
          }
        });
        process.exit(0);
      }
      const writeReason = checkBashWriteToProtected(command);
      if (writeReason) {
        logBlock(toolName, writeReason, command);
        output({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `⚠️ Ação protegida: ${writeReason}. Confirme com o dono antes de prosseguir.`
          }
        });
        process.exit(0);
      }
    }
  }

  // No issues — allow silently
  process.exit(0);
}

// Fail-CLOSED: any unhandled exception in the hook path means we
// cannot determine safety, so block. Better to over-block than to
// allow a malformed payload through (regression class C6: array
// command crashed the old hook and let the command execute).
main().catch(err => {
  // Constant message plus a hash: an exception message can embed
  // caller-supplied bytes (a path, a payload fragment), and a newline
  // in it forges a second stderr record. Same rule as the log line.
  log(`[Enforce] Error — blocking as fail-closed. detail_sha256_12=${sha12(err && err.message)}`);
  process.exit(2);
});
