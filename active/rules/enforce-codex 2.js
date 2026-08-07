#!/usr/bin/env node
/**
 * Codex shell guard for JARVIS.
 *
 * Codex hooks cover shell-oriented PreToolUse flows. This guard uses a
 * tokenizer (not regex) for the high-risk commands (git push, rm) to
 * defeat flag-anchoring bypasses. Other patterns are regex-based.
 *
 * Hard-block semantics: dangerous commands exit 2 so Codex blocks the
 * command instead of silently continuing. Fail-closed on any error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const path_resolve = path.resolve;

// Codex debug dir. Honors JARVIS_CORTEX_ROOT (same convention as
// the Claude side) so CI runs do not silently write to
// /home/runner/.codex/debug. Falls back to ~/.codex/debug for
// legacy installs.
function getCodexDir() {
  if (process.env.JARVIS_CORTEX_ROOT) {
    return path.join(process.env.JARVIS_CORTEX_ROOT, 'codex');
  }
  return path.join(os.homedir(), '.codex');
}

// === PROTECTED FILES (ported from active/rules/enforce.js) ===
// SUBSTRING matcher, not a shell parser. Covers any path whose
// literal text contains `.env` (including prod.env and $D.env) in a
// file_path field, a redirect target, a write-command argument, or
// anywhere in the command text. Does NOT cover names the shell
// COMPOSES from pieces — `printf x > .e''nv` (quote concatenation),
// escapes, globbing, expansion — verified open here and upstream.
// Accepted cost: `process.env` mentions also gate. Keep in sync with
// active/rules/enforce.js. Rule ids/labels are CONSTANT: never build
// a reason out of matched text or a path, it is logged unhashed.
const PROTECTED_FILES = [
  { id: 'env-file', label: 'arquivo .env', re: /\.env/i },
  { id: 'pm2-ecosystem', label: 'ecosystem.config', re: /ecosystem\.config\./i },
  { id: 'nginx-config', label: 'config nginx', re: /nginx\./i },
  { id: 'nginx-dir', label: 'diretorio nginx', re: /[\/\\]nginx[\/\\]/i },
  { id: 'pm2-config', label: 'pm2.config', re: /pm2\.config\./i },
  // Hook files — LLM must not rewrite its own safety boundary
  { id: 'hook-file', label: 'hook enforce', re: /active[\/\\]rules[\/\\]enforce(-codex)?\.js$/i },
  { id: 'hook-skill', label: 'hook strategic-compact', re: /active[\/\\]skills[\/\\]strategic-compact[\/\\].*\.(js|json)$/i },
  { id: 'hook-compact', label: 'hook compact', re: /strategic-compact[\/\\](session-start|pre-compact|suggest-compact)\.js$/i },
  // Round 7 (audit M3): adjacent backup files (.bak/.backup/.copy/
  // .orig/.old/.bk/.prev/.tmp/~/.swp/.rej/.save) that an attacker
  // can `mv` over the real hook file.
  { id: 'hook-file-bak', label: 'backup de hook enforce', re: /active[\/\\]rules[\/\\]enforce(-codex)?\.js(~|\.(bak|backup|copy|orig|old|bk|prev|tmp|swp|rej|save))?$/i },
  { id: 'hook-compact-bak', label: 'backup de hook compact', re: /strategic-compact[\/\\](session-start|pre-compact|suggest-compact)\.js(~|\.(bak|backup|copy|orig|old|bk|prev|tmp|swp|rej|save))?$/i }
];

const TEMPLATE_SUFFIXES = /\.env\.(example|sample|template|dist|default)$/i;

function isProtectedFile(filePath) {
  if (!filePath) return null;
  if (TEMPLATE_SUFFIXES.test(filePath)) return null;
  let resolved;
  try {
    resolved = path_resolve(filePath);
  } catch {
    return 'path invalido (regra: bad-path)';
  }
  const candidates = [filePath, resolved];
  for (const candidate of candidates) {
    for (const rule of PROTECTED_FILES) {
      if (rule.re.test(candidate)) {
        return `${rule.label} (regra: ${rule.id})`;
      }
    }
  }
  return null;
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

// === TOKEN-BASED DANGEROUS COMMAND DETECTION ===

function shellTokens(command) {
  const tokens = [];
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let match;

  while ((match = tokenPattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }

  return tokens;
}

// === EXECUTABLE IDENTITY (repair cycle 4) ===
// `tokens[i] !== 'git'` and `token === 'rm'` decided detection by exact
// spelling of an attacker-controlled executable name. Both halves of that
// were wrong ON THIS PLATFORM. Measured here, not assumed:
//
//   Git --version    -> git version 2.54.0
//   command -v RM    -> /bin/RM
//   command -v GIT   -> /opt/homebrew/bin/GIT
//
// macOS's default filesystem is case-INSENSITIVE, so `Git` and `RM` launch
// the real binaries; and a path invocation (`/bin/rm`, `./rm`,
// `/usr/bin/git`) never equals the bare name. This guard was hit harder
// than the Claude one because it has NO regex backstop for git push or
// rm — the tokenizer is its only detector, so every one of these forms
// passed free here while enforce.js still caught them via its /i regexes.
//
// Fix: compare the folded BASENAME. Narrow on purpose — executables only.
// Flags, git subcommands and env var names stay case-sensitive, because
// that reasoning does hold: `git PUSH` is rejected by git itself
// ("'PUSH' is not a git command", verified on this machine), `--MIRROR`
// is not a git flag, and `git_exec_path=` is not honoured.
//
// Unlike the Claude twin, this file has no /i regex backstop for git push
// or rm, so here the statement really is file-wide: the tokenizer is the
// only detector for those two, and its case rules are the file's case
// rules. The full rationale for basename folding — including the platform
// measurements — lives once in active/rules/enforce.js; this note is the
// short form plus what differs here.
//
// A token starting with `-` is a flag, never an executable, so it folds
// to '' and matches no name.
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

function isGitForcePush(tokens) {
  // Find 'git' followed by 'push' (skipping flag tokens that may
  // intervene, e.g. `git --git-dir=X push`). Round 8.1: handle
  // space-separated long flags (H-1) and immediately return on
  // --receive-pack / --upload-pack / --push-option / -o (RCE
  // vectors). Round 8.2 (CRIT-6): -o is shorthand for --push-option.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!isExec(tokens[i], 'git')) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j];
      if (!tok.startsWith('-')) break;
      if (tok === '-C' || tok === '-c') {
        j += 2;
      } else if (tok === '-o' || tok === '--push-option' || tok.startsWith('--push-option=')) {
        return 'git -o/--push-option (forwarded to remote hook — RCE vector)';
      } else if (tok === '--receive-pack' || tok.startsWith('--receive-pack=')) {
        return 'git --receive-pack (RCE vector — arbitrary program launched on remote)';
      } else if (tok === '--upload-pack' || tok.startsWith('--upload-pack=')) {
        return 'git --upload-pack (RCE vector — arbitrary program launched)';
      } else if (tok.includes('=') || tok.startsWith('--no-')) {
        j += 1;
      } else if (GIT_LONG_FLAGS_WITH_VALUE.has(tok)) {
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
      // Round 8.1 C-5: force refspec `+` anywhere (leading,
      // trailing, or in src:dst pair).
      if (/\+/.test(arg) && /[A-Za-z0-9_\-\.\/]/.test(arg)) {
        return 'Force push (force refspec +)';
      }
      if (arg === '--mirror') return 'git push --mirror (mass ref overwrite)';
      if (arg === '--all') return 'git push --all';
      if (arg === '--delete' || arg === '-d' || arg === '-D') {
        return 'git push --delete (ref deletion)';
      }
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

    return null;
  }
  return null;
}

// === ROUND 8.1 / 8.2 BACKPORT (CRIT-01) ===
// Mirrors the Claude variant additions. The Codex side uses
// tokenizer-based detection; the new helpers (DANGEROUS_GIT_CONFIG,
// GIT_CONFIG_* env, flattenShellCommand) extend the coverage.

const GIT_LONG_FLAGS_WITH_VALUE = new Set([
  '--git-dir', '--work-tree', '--namespace', '--exec-path',
  '--super-prefix', '--config-env', '--push-option',
  '--receive-pack', '--upload-pack'
]);

const DANGEROUS_GIT_CONFIG_KEYS = [
  'core.gitproxy', 'core.sshcommand', 'core.askpass', 'core.pager',
  'diff.external', 'credential.helper', 'core.hookspath',
  'include.path', 'includeif.path',
  'protocol.file.allow', 'protocol.git.allow'
];
const DANGEROUS_GIT_ALIAS = /^alias\.[^=]+=!/;

function isDangerousGitConfig(command) {
  if (!command || typeof command !== 'string') return null;
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
    if (DANGEROUS_GIT_CONFIG_KEYS.includes(key)) {
      return `git -c ${key}= (RCE via sub-process launcher)`;
    }
    if (DANGEROUS_GIT_ALIAS.test(val)) {
      return `git -c alias.x=!cmd (shell alias injection)`;
    }
  }
  return null;
}

function isDangerousGitConfigEnv(command) {
  if (!command || typeof command !== 'string') return null;
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

function flattenShellCommand(command) {
  if (typeof command !== 'string') return command;
  let result = command;
  let prev;
  let iterations = 0;
  do {
    prev = result;
    result = result.replace(
      /\$\(([^()]*\([^()]*\)[^()]*|[^()]*)\)/g,
      (match, inner, offset, full) => {
        const before = offset > 0 ? full[offset - 1] : ' ';
        const after = offset + match.length < full.length ? full[offset + match.length] : ' ';
        const isInline = /\S/.test(before) || /\S/.test(after);
        return isInline ? '' : ' ' + inner + ' ';
      }
    );
    result = result.replace(/`([^`]*)`/g, (match, inner, offset, full) => {
      const before = offset > 0 ? full[offset - 1] : ' ';
      const after = offset + match.length < full.length ? full[offset + match.length] : ' ';
      const isInline = /\S/.test(before) || /\S/.test(after);
      return isInline ? '' : ' ' + inner + ' ';
    });
    // /i: the shell name is an executable name, subject to the same
    // case-insensitive resolution as `git` and `rm`. Without it,
    // `BASH -c "rm -rf /"` was never flattened and — with no regex
    // backstop in this file — passed free.
    result = result.replace(
      /\b(?:bash|sh|zsh|dash|ksh|fish)\s+-c\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gi,
      ' $1$2 '
    );
    iterations++;
  } while (result !== prev && iterations < 32);
  return result;
}

function isDangerousRm(tokens) {
  // EVERY rm in the token stream, not just the first. `findIndex` stopped
  // at the first match and judged only that one, so a harmless leading rm
  // consumed the search and the dangerous one behind it was never looked
  // at. Note the residual, which is in the STOP bucket and documented in
  // the CEILING block: this still has no notion of command separators, so
  // whether the two rms are separate commands is not something this can
  // know. Iterating all matches is strictly better than judging one.
  for (let rmIndex = 0; rmIndex < tokens.length; rmIndex++) {
    if (!isExec(tokens[rmIndex], 'rm')) continue;

    let hasRecursive = false;
    let hasForce = false;
    let targetIndex = rmIndex + 1;

    for (; targetIndex < tokens.length; targetIndex++) {
      const token = tokens[targetIndex];
      if (!token.startsWith('-') || token === '-') break;
      if (token.includes('r') || token.includes('R')) hasRecursive = true;
      if (token.includes('f')) hasForce = true;
    }

    if (!hasRecursive || !hasForce) continue;

    const target = tokens[targetIndex] || '';
    if (
      target === '/' ||
      target === '.' ||
      target === '..' ||
      target === '~' ||
      target.startsWith('/') ||
      target.startsWith('./') ||
      target.startsWith('../') ||
      target.startsWith('~/') ||
      target === '$HOME' ||
      target.startsWith('$HOME/') ||
      target === '${HOME}' ||
      target.startsWith('${HOME}/') ||
      target === '$PWD' ||
      target.startsWith('$PWD/') ||
      target === '${PWD}' ||
      target.startsWith('${PWD}/')
    ) {
      return 'Recursive force delete on root/home/cwd';
    }
  }

  return null;
}

// === REGEX-BASED PATTERNS (applied to normalized command string) ===
const DANGEROUS_COMMANDS = [
  { pattern: /\bpm2\s+(restart|stop|delete)\b/i, reason: 'PM2 lifecycle command' },

  // Filesystem destruction
  { pattern: /\bfind\s+(?:\S+\s+){0,5}-delete\b/i, reason: 'find -delete (mass recursive delete)' },
  { pattern: /\bdd\s+.*\bof=\/dev\/(sd|nvme|hd|vd)/i, reason: 'dd of=/dev/sd* (disk wipe)' },
  { pattern: /\bmkfs(\.\w+)?\s+\/dev\/(sd|nvme|hd|vd)/i, reason: 'mkfs on raw disk (filesystem wipe)' },
  { pattern: /\bchmod\s+(?:-R\s+|--recursive\s+)?[0-7]{3,4}\s+\//i, reason: 'chmod -R on root (privilege escalation prep)' },
  { pattern: /\bchown\s+(?:-R\s+|--recursive\s+)\S+\s+\//i, reason: 'chown -R on root' },

  // Process / system control
  { pattern: /^\s*:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:&\s*\}\s*;:/i, reason: 'fork bomb (:(){:|:&};:)' },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, reason: 'system shutdown/reboot' },
  { pattern: /\bkill\b[^&|;]*?\b1(?!\d)/i, reason: 'kill PID 1 (init)' },

  // Remote code execution
  { pattern: /\b(curl|wget|fetch)\s+[^|]*\|\s*(bash|sh|zsh|dash|ksh|fish|python|perl|ruby|node)\b/i, reason: 'curl|sh (remote code execution)' },
  { pattern: /\b(curl|wget|fetch)\s+[^|&]*?(-[oO]\s+\S+|--output\s+\S+|>\s*\S+)[^|&;]*&&\s*(bash|sh|zsh|dash|ksh|fish|python|perl|ruby|node)\b/i, reason: 'curl >/-o file && bash (download + execute)' },
  { pattern: /\b(bash|sh|zsh|dash|ksh|fish)\s+<\s*\(\s*(curl|wget|fetch)\b/i, reason: 'bash <(curl) (process substitution RCE)' },
  { pattern: /\beval\s+(\$\(|\$\{|`)/i, reason: 'eval $(cmd) or eval ${} (RCE via substitution)' },
  { pattern: /\b(python|python3|perl|ruby|node|php)\s+-e\s+.*?(os\.system|subprocess|exec|system|spawn|child_process)/i, reason: 'python -c os.system / child_process.exec (RCE)' },

  // SQL — DROP/**/ (MySQL comment as whitespace) handled by [\s/*]+
  { pattern: /\bDROP[\s\/*]+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|FUNCTION|PROCEDURE|TRIGGER|USER|ROLE)\b/i, reason: 'SQL DROP statement' },
  { pattern: /\bTRUNCATE\s+(TABLE\s+)?\S+/i, reason: 'SQL TRUNCATE' },
  { pattern: /\bDELETE\s+FROM\s+\S+\s*;?\s*$/i, reason: 'SQL DELETE FROM (no WHERE)' },
  { pattern: /\bGRANT\s+ALL\b/i, reason: 'SQL GRANT ALL' },

  // Shell env injection (RCE bypass). PATH/IFS/PROMPT_COMMAND/
  // PYTHONSTARTUP excluded — too common in legitimate shell idioms.
  // Case-SENSITIVE on purpose, and the /i here was a real cost: POSIX
  // environment names are case-sensitive, so `env=development node app.js`
  // does not set ENV and `git_config_count=1 git status` does not set
  // GIT_CONFIG_COUNT — yet both were asking. Ordinary commands
  // interrupted is the failure mode this removes. Executable names stay
  // folded (see execName); only names the shell itself treats as
  // case-sensitive stay exact.
  { pattern: /\b(GIT_SSH_COMMAND|GIT_ASKPASS|LD_PRELOAD|LD_AUDIT|BASH_ENV|ENV)\s*=/, reason: 'shell env var injection' }
];

// === KEY LOOKUP IS CASE-FOLDED (repair cycle 2) ===
// These helpers used to read literal property paths (`data.command`,
// `data?.tool_input?.file_path`, ...). A property name is part of the
// payload, so the caller controls its spelling, and the exact-case read
// failed OPEN: `{"tool_input":{"Command":"rm -rf /"}}` was invisible to
// the guard and exited 0, while the lowercase spelling exited 2. Same
// defect class as the tool-name gate in active/rules/enforce.js, but
// failing open rather than closed.
//
// The fix is the pattern that file already uses in getMcpFilePaths
// (`fieldSet.has(k.toLowerCase())`): enumerate the container's OWN keys,
// fold each one, and match it EXACTLY against a fixed set. Exact-after-
// folding is the load-bearing part — a prefix or substring match would
// drag in unrelated names, whereas here `PATH`, `command_prefix` and
// `cmdline` match nothing.
//
// The key vocabulary is unchanged by all of this: `command`/`cmd`,
// `argv`, `file_path`/`filepath`. Nothing was added to it.
//
// === CONTAINER COVERAGE IS SYMMETRIC ON PURPOSE (repair cycle 3) ===
// The three extractors used to disagree about WHERE to look, and the
// disagreement was drift rather than design: commands were read from the
// top-level payload, paths were not; `argv` was read from `tool_input`
// and `input`, but not from `arguments`. There is no principled reason a
// command is visible at the top level while a path at the same level is
// invisible, and the gap failed OPEN — `{"file_path":"/project/.env"}`
// and `{"arguments":{"argv":["rm","-rf","/"]}}` both exited 0.
//
// So the container list is now declared ONCE and consumed by all three
// extractors. That is the anti-drift property: coverage cannot diverge
// again without deleting a shared call site, which reads as a change
// rather than as an oversight. No container is excluded — all four are
// ordinary argument bags of the same shape, and there is none where
// reading genuinely does not make sense.
const COMMAND_KEYS = new Set(['command', 'cmd']);
const ARGV_KEYS = new Set(['argv']);
const FILE_PATH_KEYS = new Set(['file_path', 'filepath']);

// The four places a Codex payload can carry tool arguments. Every
// extractor reads all of them. Non-object entries are tolerated by
// valuesForKeys, so a payload that omits a container costs nothing.
//
// Container NAMES are folded, for exactly the reason the leaf keys were:
// `data.tool_input` was a literal read, so `Tool_Input`, `INPUT` and
// `ARGUMENTS` were invisible — and a safe canonical container shadowed a
// dangerous folded twin, which is the collision shape that has now bitten
// this codebase three times. EVERY matching container is returned,
// collisions included; none wins over another.
const CONTAINER_KEYS = new Set(['tool_input', 'input', 'arguments']);

function payloadContainers(data) {
  const out = [data];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (CONTAINER_KEYS.has(key.toLowerCase())) out.push(value);
    }
  }
  return out;
}

// Every own key of `container` whose folded name is in `keySet`, in the
// order the payload declared them. Collisions yield BOTH values: an
// object carrying `command` AND `Command` produces two candidates, so
// one spelling cannot silently shadow the other — the same validate-all
// property the alias fix won, now applied across case as well as across
// containers. A null / array / primitive container yields nothing
// instead of throwing.
function valuesForKeys(container, keySet) {
  const out = [];
  if (!container || typeof container !== 'object' || Array.isArray(container)) return out;
  for (const [key, value] of Object.entries(container)) {
    if (keySet.has(key.toLowerCase())) out.push(value);
  }
  return out;
}

// Returns EVERY command spelling the payload supplies, not the first
// usable one. First-match-wins was an alias-shadowing bypass: a safe
// top-level `command` shadowed a dangerous `tool_input.command`, and
// the caller chose which one got validated. Same class as the Cursor
// adapter fix; both are now validate-all.
function commandsFromPayload(data) {
  const out = [];
  const collect = (value) => {
    if (typeof value === 'string') {
      if (value.trim() && !out.includes(value)) out.push(value);
    } else if (Array.isArray(value)) {
      const joined = value.filter(x => typeof x === 'string').join(' ');
      if (joined.trim() && !out.includes(joined)) out.push(joined);
    }
  };

  for (const container of payloadContainers(data)) {
    for (const value of valuesForKeys(container, COMMAND_KEYS)) collect(value);
  }

  // `argv` keeps its stricter contract: every element must be a string
  // before the join is trusted. A mixed-type array is not a command line
  // we can reconstruct, so it is left alone rather than half-joined.
  for (const container of payloadContainers(data)) {
    for (const argv of valuesForKeys(container, ARGV_KEYS)) {
      if (Array.isArray(argv) && argv.every(item => typeof item === 'string')) {
        const joined = argv.join(' ');
        if (joined.trim() && !out.includes(joined)) out.push(joined);
      }
    }
  }

  return out;
}

// Same fix: every supplied path is validated, so a safe
// `tool_input.file_path` cannot shadow a protected `input.file_path` —
// and, since repair cycle 3, so a path parked at the top level cannot
// slip past simply because only commands were read from there.
function filePathsFromPayload(data) {
  const out = [];
  for (const container of payloadContainers(data)) {
    for (const value of valuesForKeys(container, FILE_PATH_KEYS)) {
      if (typeof value === 'string' && value.trim() && !out.includes(value)) {
        out.push(value);
      }
    }
  }
  return out;
}

function dangerousReason(command) {
  // NFKC normalize (defeats unicode tricks) + whitespace collapse.
  const normalized = (command || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const flattened = flattenShellCommand(normalized);
  const tokens = shellTokens(flattened);
  const structuredReason = isGitForcePush(tokens) || isDangerousRm(tokens);
  if (structuredReason) return structuredReason;

  // Round 8.1 / 8.2 (CRIT-01 backport): git config RCE + env
  // injection. Both run on the flattened string.
  const configReason = isDangerousGitConfig(flattened);
  if (configReason) return configReason;

  // GIT_CONFIG_* env vars — run on the original (env vars are at
  // the start of the command, the flatten pass leaves them alone).
  const configEnvReason = isDangerousGitConfigEnv(normalized);
  if (configEnvReason) return configEnvReason;

  for (const { pattern, reason } of DANGEROUS_COMMANDS) {
    // Check both original (preserves $() / backtick markers for
    // `eval $()` / `bash <(curl)` patterns) and flattened (catches
    // patterns hidden inside subshells).
    if (pattern.test(normalized) || pattern.test(flattened)) return reason;
  }
  return null;
}

/**
 * Round 7 (audit C9): Bash commands that write to a protected
 * file via tee/cp/mv/sed/dd/ln/install/touch/redirection bypass
 * the file-level Edit/Write protection. This function tokenizes
 * the command and tests every potential destination against
 * PROTECTED_FILES. Returns a reason string if the command would
 * write to a protected file, null otherwise.
 */
function checkBashWriteToProtected(command) {
  if (!command || typeof command !== 'string') return null;
  const normalized = command.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // Pull redirect targets (>, >>, >|, 2>, 2>&1, etc.) — file
  // destinations, not arguments. Round 7 reviewer: strip surrounding
  // quotes from the captured target.
  const redirectTargets = [];
  const reRedirect = /(?:^|\s)(?:&?\d?>+\s*|&?\d*>&?\d*\s*)([^\s|&;"']+)/g;
  let m;
  while ((m = reRedirect.exec(normalized)) !== null) {
    const target = m[1].replace(/^["']|["']$/g, '');
    if (/^[\/.\w-]+\.\w+$/.test(target) || target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) {
      redirectTargets.push(target);
    }
  }

  // Find write-introducer tokens and pull their destination args
  // (`sed -i` and `perl -pi/-i` are in-place edits)
  const tokens = normalized.split(/\s+/);
  const writeIdxs = [];
  for (let i = 0; i < tokens.length; i++) {
    // Folded basename, so `/bin/tee` and `TEE` are recognised. The
    // in-place FLAGS stay case-sensitive: `sed -I` is not sed's in-place
    // flag.
    const exec = execName(tokens[i]);
    if (WRITE_INTRO_EXECS.has(exec)) writeIdxs.push(i);
    if (exec === 'sed' && /^-i[.\w]*$|^--in-place$/.test(tokens[i + 1] || '')) {
      writeIdxs.push(i);
    }
    if (exec === 'perl' && /^-pi[.\w]*$|^-i[.\w]*$/.test(tokens[i + 1] || '')) {
      writeIdxs.push(i);
    }
  }
  if (writeIdxs.length > 0 || redirectTargets.length > 0) {
    const destCandidates = [];
    for (const idx of writeIdxs) {
      for (let j = idx + 1; j < tokens.length; j++) {
        const tok = tokens[j];
        if (tok === '|' || tok === '||' || tok === '&&' || tok === ';') break;
        if (tok.startsWith('-')) continue;
        destCandidates.push(tok.replace(/^["']|["']$/g, ''));
      }
    }

    const allCandidates = [...redirectTargets, ...destCandidates];
    for (const cand of allCandidates) {
      const reason = isProtectedFile(cand);
      if (reason) {
        return `Bash escreve em arquivo protegido: ${reason}`;
      }
    }
  }

  // Final pass (round 7 reviewer MEDIUM-3): scan the whole command
  // for any protected-path substring. Catches a DOTTED protected path
  // buried in a quoted argument to a non-introducer command, e.g.
  // `python3 -c "open('/project/.env','w')"`. The old example here was
  // `open('/env','w')`, which this does NOT catch and never did —
  // `/\.env/i` needs a literal dot and `/env` has none. False-positive risk
  // acceptable. NOTE: this hook HARD-BLOCKS (exit 2); there is no
  // confirm step on the Codex side, so a false positive stops the
  // command outright.
  for (const rule of PROTECTED_FILES) {
    if (rule.re.test(normalized)) {
      return `Bash menciona caminho protegido: ${rule.label} (regra: ${rule.id})`;
    }
  }

  return null;
}

// One record is exactly one line, and no field is caller-controlled:
// constants, an internal timestamp, and hashes only. The assembled
// line is stripped of newlines and control characters so nothing can
// forge a record boundary. Keep in sync with active/rules/enforce.js.
// Unicode control/format/line-separator categories. The old
// \x00-\x1f\x7f class left the C1 block (U+0085 NEL, U+009B CSI).
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

function logBlock(reason, command) {
  const debugDir = path.join(getCodexDir(), 'debug');
  const logPath = path.join(debugDir, 'jarvis-enforce.log');
  const commandHash = crypto.createHash('sha256').update(String(command ?? '')).digest('hex').slice(0, 12);
  const line = `${[
    `[${new Date().toISOString()}]`,
    'BLOCKED',
    `reason=${reason}`,
    `command_sha256_12=${commandHash}`,
  ].join(' ').replace(CONTROL_CHARS, ' ')}\n`;
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch {
    // Guard behavior should not depend on logging.
  }
}

// === MAIN ===

let data;
try {
  const raw = fs.readFileSync(0, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    // Empty stdin: legitimate (no tool call yet). Allow silently.
    process.exit(0);
  }
  data = JSON.parse(trimmed);
} catch (err) {
  // Fail-CLOSED: cannot parse → block. Same rationale as Claude side.
  // Constant message plus a hash. Interpolating err.message echoed
  // caller-supplied bytes and, because the message embeds the input,
  // a newline in the payload produced a physical second stderr line —
  // the record forgery just made structurally impossible for the log,
  // reappearing on the error path.
  console.error(
    '[JARVIS Codex Guard] Falha ao parsear payload — bloqueado (fail-closed). '
    + `detail_sha256_12=${crypto.createHash('sha256').update(String(err && err.message)).digest('hex').slice(0, 12)}`,
  );
  process.exit(2);
}

// H3 — reject non-plain-object top levels.
//
// `typeof [] === 'object'` and `[]` is truthy, so an array payload
// satisfied the old check and flowed into the extraction helpers below,
// where `data.command` and `data.tool_input` are undefined: the guard
// then exited 0 having validated nothing. No JSON array can actually
// carry those fields, so this is a shape defect rather than a
// demonstrated bypass — but the top level of a tool payload is a plain
// object or it is not a payload this guard can evaluate. Mirrors the
// identical check in active/rules/enforce.js.
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  process.exit(2);
}

// 1) File protection (Edit/Write tools, or any payload with file_path)
for (const filePath of filePathsFromPayload(data)) {
  const reason = isProtectedFile(filePath);
  if (reason) {
    logBlock(reason, filePath);
    console.error(`[JARVIS Codex Guard] Arquivo bloqueado: ${reason}. Bloqueio definitivo (hard block).`);
    process.exit(2);
  }
}

// 2) Command protection (Bash tool, or any payload with command/argv)
for (const command of commandsFromPayload(data)) {
  const reason = dangerousReason(command) || checkBashWriteToProtected(command);
  if (reason) {
    logBlock(reason, command);
    console.error(`[JARVIS Codex Guard] Acao bloqueada: ${reason}. Bloqueio definitivo (hard block).`);
    process.exit(2);
  }
}

process.exit(0);
