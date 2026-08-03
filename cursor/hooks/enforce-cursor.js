#!/usr/bin/env node
'use strict';

/**
 * Cursor PreToolUse / beforeShellExecution / beforeMCPExecution adapter for
 * cortex enforce.js.
 *
 * IMPORTANT: with failClosed:true, Cursor treats empty stdout as hook failure
 * and BLOCKS the action. Every exit path must emit JSON (allow or deny).
 *
 * CEILING: this adapter does not inspect commands itself — it delegates to
 * active/rules/enforce.js and therefore inherits that file's ceiling
 * exactly. See the CEILING block there. In short: it is a token-matching
 * gate, not a shell parser, and command substitution, unspaced operators
 * (`;`, `&&`, `|`) and unusual executable path forms are known-open by
 * decision. What THIS file adds is payload-shape discipline — fail-closed
 * on unreadable input, no alias shadowing across case or container, a
 * parseable JSON verdict on every exit path — not command understanding.
 * Cursor maps every non-allow verdict to deny because there is no human
 * to ask, which makes the shape discipline matter more here, and makes
 * the command ceiling no worse here than upstream.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Same discipline as logBlock in active/rules/enforce.js: a diagnostic
// carries a constant plus a hash, never a caller-supplied value.
function sha12(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12);
}

// NOTHING caller-supplied is reflected into the output any more.
//
// The previous approach truncated instead of redacting: clip() bounded a
// 400 kB tool_name so the reply still fit the pipe buffer, but a 30-byte
// one came back verbatim in user_message / agent_message. Bounding is not
// redaction. Every diagnostic below now carries a CONSTANT plus a
// sha256 prefix, the same rule logBlock follows in
// active/rules/enforce.js.
//
// Debuggability is preserved without reflection: the hash is stable, so
// an operator who suspects a particular tool name can hash that candidate
// and compare — the hook confirms a hypothesis without ever emitting the
// value. Truncation is no longer needed either, since a hash is fixed
// width whatever the input size.

/**
 * Write synchronously and only then exit. `process.stdout.write` on a
 * pipe is asynchronous; exiting straight after it can drop buffered
 * bytes and emit half a JSON object, which under failClosed is the
 * dangerous "no parseable verdict" case.
 */
function emitAndExit(payload) {
  const line = `${JSON.stringify(payload)}\n`;
  const buf = Buffer.from(line, 'utf8');
  let written = 0;
  while (written < buf.length) {
    try {
      written += fs.writeSync(1, buf, written, buf.length - written);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      break;
    }
  }
  process.exit(0);
}

function allow() {
  emitAndExit({ permission: 'allow' });
}

function deny(user_message, agent_message) {
  emitAndExit({
    permission: 'deny',
    user_message,
    agent_message: agent_message || user_message,
  });
}

function resolveEnforce() {
  try {
    const real = fs.realpathSync(__filename);
    const fromCortex = path.join(path.dirname(real), '..', '..', 'active', 'rules', 'enforce.js');
    if (fs.existsSync(fromCortex)) return fromCortex;
  } catch {
    /* ignore */
  }
  const home = process.env.HOME || '';
  const fromClaude = path.join(home, '.claude', 'active', 'rules', 'enforce.js');
  if (fs.existsSync(fromClaude)) return fromClaude;
  return null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Own entries of `obj` whose FOLDED key is in `foldedKeys`, in declaration
 * order, skipping explicit `undefined`.
 *
 * Key lookup used to be exact-case `hasOwnProperty`, which was argued to
 * be safe on the grounds that an unrecognised spelling simply goes unread
 * and the branch then fails toward deny. That argument holds for a
 * payload carrying ONE spelling. It breaks on a COLLISION: with a safe
 * canonical key present next to a dangerous folded one —
 * `{path:'/tmp/safe.ts', File_Path:'/project/.env'}`,
 * `{tool_input:{...safe}, Tool_Input:{...dangerous}}`,
 * `{command:'ls', Command:'cat .env'}` — the canonical value satisfied the
 * branch, the dangerous one was never seen, and the verdict was allow.
 * Folding the accepted key names is what closes that.
 */
function foldedEntries(obj, foldedKeys) {
  const out = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (foldedKeys.has(key.toLowerCase()) && value !== undefined) out.push([key, value]);
  }
  return out;
}

/**
 * Read a value that may arrive under several accepted alias keys.
 *
 * First-present-wins is a shadowing bypass: with `{tool_name:"Read",
 * toolName:"Write"}` or `{path:"/tmp/safe.txt",
 * file_path:"/project/prod.env"}` the caller picks which alias gets
 * validated while the runtime may act on the other. We cannot know
 * which one Cursor honours, so disagreement is refused outright.
 */
function aliasValue(obj, keys, label) {
  // The accepted spellings are matched case-insensitively, so `Tool_Name`
  // and `TOOLNAME` are the same alias as `tool_name` — and therefore
  // subject to the same disagreement rule instead of being invisible.
  const folded = new Set(keys.map(k => k.toLowerCase()));
  const present = foldedEntries(obj, folded);
  if (present.length === 0) return { ok: true, value: undefined };
  const head = present[0][1];
  for (const [, value] of present.slice(1)) {
    if (!sameValue(value, head)) {
      return {
        ok: false,
        reason: `conflicting ${label} aliases (${present.length}) names_sha256_12=${sha12(present.map(([k]) => k).join(','))}`,
      };
    }
  }
  return { ok: true, value: head };
}

/**
 * Order-independent deep equality. Safe: payload depth is bounded
 * before this runs. JSON.stringify comparison was key-order dependent,
 * so `{a:1,b:2}` and `{b:2,a:1}` were reported as conflicting aliases
 * and denied — a false block on equivalent input.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    k => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]),
  );
}

/**
 * A supplied tool name / event name must be a non-empty primitive
 * string. `["Read"]` used to coerce via String() to "Read" and inherit
 * the read-only allowlist, so an array walked straight into allow.
 *
 * Absent (`undefined`) is distinct from supplied-but-blank: the first
 * is a field the payload simply does not carry, the second is a value
 * we failed to understand. Returning '' for both let a whitespace name
 * satisfy a contract that says non-empty.
 */
// Unicode control (Cc), format (Cf) and separator categories. `.trim()`
// alone left NUL, ESC, U+0085 NEL, U+009B CSI and zero-width joiners
// in place, so a name that renders as nothing counted as "usable" and
// reached allow.
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu;

function normalizeName(value) {
  if (value === undefined) return { ok: true, value: '' };
  if (typeof value !== 'string') {
    return { ok: false, reason: `expected string, got ${Array.isArray(value) ? 'array' : typeof value}` };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: 'value was blank' };
  // A name must contain at least one VISIBLE character. Something that
  // renders as nothing cannot be attributed, matched against the
  // allowlist, or meaningfully shown to a human.
  if (!trimmed.replace(INVISIBLE_CHARS, '')) {
    return { ok: false, reason: 'value contained only invisible characters' };
  }
  return { ok: true, value: trimmed };
}

/** `file:///x` → `/x`. Returns null when not a file URI. */
function fileUriToPath(value) {
  if (typeof value !== 'string' || !/^file:\/\//i.test(value)) return null;
  return value.replace(/^file:\/\/(?:localhost)?/i, '');
}

/**
 * Percent-decode until stable. One pass is not enough: `%252E` decodes
 * to `%2E`, which still hides the dot.
 */
function decodeRepeatedly(value, rounds = 4) {
  let current = value;
  for (let i = 0; i < rounds; i += 1) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Every spelling of one destination that must be validated. Accepting
 * `uri` verbatim meant `file:///project/%2Eenv` was allowed while the
 * identical plain path was denied — same target, opposite verdicts,
 * with the encoded spelling winning.
 */
function destinationForms(value) {
  const forms = [value];
  const asPath = fileUriToPath(value);
  if (asPath) forms.push(asPath);
  for (const form of [...forms]) {
    const decoded = decodeRepeatedly(form);
    if (decoded !== form) forms.push(decoded);
  }
  return [...new Set(forms.filter(f => typeof f === 'string' && f.trim()))];
}

/** Cursor beforeMCPExecution often sends tool_input as a JSON string. */
function coerceObjectInput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, value: raw };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    // An explicitly-supplied blank string is not a no-argument call —
    // it is a payload we failed to understand. Absent is `undefined`,
    // handled below.
    if (!trimmed) return { ok: false, reason: 'tool_input was an empty string' };
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, value: parsed };
      }
      return { ok: false, reason: 'tool_input JSON must be an object' };
    } catch (err) {
      // Hash the INPUT, matching logBlock's detail_sha256_12 convention:
      // V8 returns an identical message for distinct malformed inputs
      // (`{bad AAAA` and `{{{{ BBBB` both say "position 1"), so hashing the
      // message made every parse failure indistinguishable.
      //
      // A JSON parse error message embeds the input, and this reason is
      // reflected into agent_message on stdout — so a payload of
      // `{"tool_input":"SK_7f4c"}` echoed the secret back verbatim to
      // anything reading the hook's output. Every other diagnostic in
      // these hooks is a constant plus a hash; this was the one site that
      // still reflected raw bytes.
      return {
        ok: false,
        reason: `tool_input JSON parse failed detail_sha256_12=${sha12(trimmed)}`,
      };
    }
  }
  // A missing field is a no-argument call. Anything else non-object
  // (array, number, boolean, explicit null) is a shape enforce.js
  // cannot scan for paths — it would return "no paths found" and the
  // call would sail through unvalidated.
  if (raw === undefined) return { ok: true, value: {} };
  return {
    ok: false,
    reason: `tool_input must be an object, got ${Array.isArray(raw) ? 'array' : (raw === null ? 'null' : typeof raw)}`,
  };
}

/**
 * Tools with no write target and therefore nothing for enforce.js to
 * validate. Only names that are unambiguously READ-ONLY belong here.
 *
 * Explicit aliases, compared case-insensitively. Do NOT normalize by
 * stripping punctuation: that makes unknown variants inherit trust
 * from a listed name (`Read.File` collapsing onto `readfile`), which
 * is a free pass for any tool whose name merely resembles one here.
 *
 * Mutation-capable tools are excluded on purpose, even ones that only
 * write agent-side state (todo_write) or create artifacts
 * (create_diagram). They belong in a mapped branch, not in a
 * read-only bypass.
 */
const READ_ONLY_TOOLS = new Set([
  'read', 'readfile', 'read_file', 'openfile', 'open_file',
  'notebookread', 'read_notebook',
  'glob', 'grep', 'grepsearch', 'grep_search', 'search',
  'filesearch', 'file_search', 'codebasesearch', 'codebase_search',
  'semanticsearch', 'semantic_search',
  'list', 'listdir', 'list_dir', 'listfiles', 'list_files', 'ls',
  'fetch', 'webfetch', 'web_fetch', 'websearch', 'web_search',
  'fetchrules', 'fetch_rules', 'readlints', 'read_lints',
]);

function isReadOnlyTool(n) {
  return READ_ONLY_TOOLS.has(String(n || '').trim().toLowerCase());
}

// Serialising a deeply nested payload throws RangeError. Unguarded,
// that exited 1 with EMPTY stdout — the case this file's header calls
// out as dangerous under failClosed. Bound the input before any
// traversal or serialisation touches it.
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_PAYLOAD_DEPTH = 64;

/** Iterative, so measuring depth cannot itself overflow the stack. */
function exceedsDepth(root, limit) {
  const stack = [[root, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}

const raw = readStdin();
// Fail-closed: no payload means no tool call we can evaluate. Denying
// a payload-less invocation blocks nothing real (there is no action
// attached to it); allowing one would wave through any real call that
// arrives with a lost stdin.
if (!raw.trim()) {
  deny('Hook enforce: payload vazio — bloqueado (fail-closed).', 'empty stdin');
}

// Buffer.byteLength, not String.length: multi-byte characters make the
// two differ, and the limit is about bytes on the wire.
const rawBytes = Buffer.byteLength(raw, 'utf8');
if (rawBytes > MAX_PAYLOAD_BYTES) {
  deny(
    'Hook enforce: payload grande demais — bloqueado (fail-closed).',
    `payload ${rawBytes} bytes exceeds ${MAX_PAYLOAD_BYTES}`,
  );
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  deny('Hook enforce: payload JSON inválido.');
}

// `null`, `5`, `"str"`, `[]` and `true` are all valid JSON. Reading
// `.tool_name` off null threw an uncaught TypeError and exited 1 with
// ZERO stdout — and under failClosed an empty stdout is exactly the
// undefined-behaviour case this file's header warns about. Every exit
// path must emit JSON.
if (!input || typeof input !== 'object' || Array.isArray(input)) {
  deny(
    'Hook enforce: payload deve ser um objeto JSON — bloqueado (fail-closed).',
    `top-level payload was ${Array.isArray(input) ? 'array' : (input === null ? 'null' : typeof input)}`,
  );
}

if (exceedsDepth(input, MAX_PAYLOAD_DEPTH)) {
  deny(
    'Hook enforce: payload aninhado demais — bloqueado (fail-closed).',
    `payload nesting exceeds ${MAX_PAYLOAD_DEPTH} levels`,
  );
}

const ENFORCE = resolveEnforce();
if (!ENFORCE) {
  deny('enforce.js não encontrado — ação bloqueada (fail-closed).', 'resolveEnforce() returned null');
}

const namePick = aliasValue(input, ['tool_name', 'toolName', 'tool'], 'tool_name');
if (!namePick.ok) {
  deny('Hook enforce: aliases de tool_name conflitantes — bloqueado (fail-closed).', namePick.reason);
}
const inputPick = aliasValue(input, ['tool_input', 'toolInput', 'input'], 'tool_input');
if (!inputPick.ok) {
  deny('Hook enforce: aliases de tool_input conflitantes — bloqueado (fail-closed).', inputPick.reason);
}

const namePicked = normalizeName(namePick.value);
if (!namePicked.ok) {
  deny(
    'Hook enforce: tool_name inválido — bloqueado (fail-closed).',
    `tool_name ${namePicked.reason}`,
  );
}
const name = namePicked.value;
const tiRaw = inputPick.value;

// hook_event_name gets the same alias policy as tool_name: conflicting
// values decide which branch validates the call, so disagreement is
// refused rather than resolved by declaration order.
const eventPick = aliasValue(input, ['hook_event_name', 'hookEventName'], 'hook_event_name');
if (!eventPick.ok) {
  deny('Hook enforce: aliases de hook_event_name conflitantes — bloqueado (fail-closed).', eventPick.reason);
}
const eventPicked = normalizeName(eventPick.value);
if (!eventPicked.ok) {
  deny(
    'Hook enforce: hook_event_name inválido — bloqueado (fail-closed).',
    `hook_event_name ${eventPicked.reason}`,
  );
}

// H2 — event authority must not be decided by exact spelling.
//
// The comparisons below used to be exact string equality against an
// attacker-controlled string. `BeforeMCPExecution` — one capital away
// from canonical — matched neither the `beforeShellExecution` nor the
// `beforeMCPExecution` test, so the event/name compatibility check never
// fired and routing fell through to the tool name: a payload named
// `Shell` carrying `{command:'ls', path:'/project/.env'}` took the shell
// branch, had only its command validated, and returned allow.
//
// Authority is now resolved by a case-folded lookup against the events
// this adapter is actually registered for (cursor/hooks.json), so a
// near-miss spelling resolves to the real event and is held to the same
// event/name agreement rule as the canonical one.
//
// An event we do not recognise grants NO authority — it does not deny.
// Denying unknown spellings would mean that if Cursor ever spells the
// preToolUse payload differently from its registration key, every Write
// and Edit in Cursor hard-fails. Granting nothing is the safe half of
// that trade: routing falls back to the tool name, whose branches each
// validate their own inputs and whose default is deny.
const CANONICAL_EVENTS = new Map([
  ['beforeshellexecution', 'beforeShellExecution'],
  ['beforemcpexecution', 'beforeMCPExecution'],
  ['pretooluse', 'preToolUse'],
]);
const eventSupplied = eventPicked.value;
const event = CANONICAL_EVENTS.get(eventSupplied.toLowerCase()) || '';

/**
 * Hand one payload to enforce.js. Denies and exits on any non-allow
 * verdict or unreadable result; returns normally only when clean, so
 * callers can validate several destinations in sequence.
 */
function enforceOrDeny(payloadObj) {
  let claudePayload;
  try {
    claudePayload = JSON.stringify(payloadObj);
  } catch (err) {
    // Same rule: constant plus hash, never the exception text.
    deny(
      'Payload não serializável — bloqueado (fail-closed).',
      `payload serialization failed detail_sha256_12=${sha12(err && err.message)}`,
    );
  }

  const result = spawnSync(process.execPath, [ENFORCE], {
    input: claudePayload,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  if (result.error || (result.status !== 0 && result.status !== 2)) {
    deny(
      'enforce.js falhou ao validar a ação — bloqueado (fail-closed).',
      result.error
        ? result.error.message
        : (result.stderr || result.stdout || `enforce exit ${result.status}`),
    );
  }

  if (result.status === 2) {
    deny('enforce.js bloqueou a ação (fail-closed).', result.stderr || result.stdout || 'enforce fail-closed');
  }

  // Exit 0 with empty stdout is enforce.js signalling "no issue".
  if (!result.stdout.trim()) return;

  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    deny('enforce.js retornou JSON inválido — bloqueado (fail-closed).');
  }

  const decision = output?.hookSpecificOutput?.permissionDecision
    || output?.permissionDecision
    || output?.permission;

  // Any JSON enforce.js emits carries a decision, so a decision-less
  // object is an unexpected shape, not an approval.
  if (!decision) {
    deny(
      'enforce.js retornou uma decisão irreconhecível — bloqueado (fail-closed).',
      `enforce output without a decision field: ${result.stdout.slice(0, 200)}`,
    );
  }

  if (decision === 'allow') return;

  deny(
    output?.hookSpecificOutput?.permissionDecisionReason
      || output?.permissionDecisionReason
      || output?.user_message
      || 'Ação sensível — bloqueada pelo enforce do cortex.',
  );
}

let mappedName = name;
let mappedInput = tiRaw;

// The explicit event is authoritative, and a name that contradicts it
// is refused rather than resolved. Branch order used to decide: the
// shell test ran first, so a `beforeMCPExecution` payload named
// `Shell` took the shell path — its command was validated while its
// protected path argument never was, and the call returned allow.
const NAME_IS_SHELL = /^(Shell|Bash|sh|shell|bash)$/i.test(name);
const NAME_IS_MCP = /^mcp__/i.test(name) || /^MCP:/i.test(name);
if (event === 'beforeShellExecution' && (NAME_IS_MCP || (name && !NAME_IS_SHELL))) {
  deny(
    'Hook enforce: evento e tool_name incompatíveis — bloqueado (fail-closed).',
    `event beforeShellExecution with a non-shell tool_name name_sha256_12=${sha12(name)}`,
  );
}
if (event === 'beforeMCPExecution' && name && !NAME_IS_MCP) {
  deny(
    'Hook enforce: evento e tool_name incompatíveis — bloqueado (fail-closed).',
    `event beforeMCPExecution with a non-MCP tool_name name_sha256_12=${sha12(name)}`,
  );
}

// Safe to test the name here: the incompatible combinations were
// already refused above, so a shell name can no longer coexist with a
// non-shell event. A plain preToolUse call named Shell still routes.
if (event === 'beforeShellExecution' || NAME_IS_SHELL) {
  mappedName = 'Bash';
  const ti = (typeof tiRaw === 'object' && tiRaw) ? tiRaw : {};
  // `tool_input.command` and top-level `command` are both accepted, so
  // they get the alias policy too: if both are present and disagree,
  // we cannot know which one the runtime will execute.
  const COMMAND_FIELDS = new Set(['command']);
  const commandSources = [
    ...foldedEntries(ti, COMMAND_FIELDS).map(([, value]) => value),
    ...foldedEntries(input, COMMAND_FIELDS).map(([, value]) => value),
  ];
  // `every`, not a two-element compare: folding means more than two
  // spellings can now be present at once.
  if (commandSources.length > 1
      && !commandSources.every(c => sameValue(c, commandSources[0]))) {
    deny(
      'Hook enforce: comandos conflitantes em tool_input.command e command — bloqueado (fail-closed).',
      'conflicting command aliases',
    );
  }
  const command = commandSources.length && typeof commandSources[0] === 'string'
    ? commandSources[0]
    : null;
  // Fail-closed: a shell event whose command we cannot read is a
  // shell event we cannot validate. `command: ""` is still a string
  // and falls through to enforce.js (which allows it — nothing runs);
  // only an absent or non-string field is denied.
  if (command === null) {
    deny(
      'Shell sem comando legível — bloqueado (fail-closed).',
      'beforeShellExecution payload has no string `command` field',
    );
  }
  mappedInput = { command };
} else if (
  event === 'beforeMCPExecution'
  || /^mcp__/i.test(name)
  || /^MCP:/i.test(name)
) {
  const coerced = coerceObjectInput(tiRaw);
  if (!coerced.ok) {
    deny('MCP tool_input inválido — bloqueado (fail-closed).', coerced.reason);
  }
  // A nameless MCP call cannot be attributed or routed, so it is not
  // validated — it is refused. The old `|| 'tool'` placeholder made a
  // missing name look like a legitimate one.
  if (!name) {
    deny(
      'Hook enforce: chamada MCP sem nome de ferramenta — bloqueada (fail-closed).',
      'beforeMCPExecution payload carried no usable tool name',
    );
  }
  mappedName = /^mcp__/i.test(name)
    ? name
    : `mcp__cursor__${name.replace(/\W+/g, '_').toLowerCase()}`;
  mappedInput = coerced.value;
} else if (/^(Write|Edit|StrReplace|Delete|NotebookEdit|EditNotebook)$/i.test(name)) {
  const ti = (tiRaw && typeof tiRaw === 'object' && !Array.isArray(tiRaw)) ? tiRaw : null;
  // Validate EVERY destination the payload supplies, not the first one
  // that happens to be readable. Picking one lets a caller park a safe
  // `path` next to a protected `file_path` and have the safe one
  // checked while the runtime may act on the other.
  // Folded spellings of the SAME vocabulary — no field name was added.
  // `filepath` covers both `filepath` and the former `filePath` entry.
  const DEST_FIELDS = new Set([
    'path', 'file_path', 'filepath', 'target_file', 'target_notebook', 'uri',
  ]);
  const targets = [];
  let unreadableField = null;
  for (const [field, value] of foldedEntries(ti, DEST_FIELDS)) {
    if (typeof value !== 'string' || !value.trim()) {
      unreadableField = field;
      break;
    }
    for (const form of destinationForms(value)) {
      if (!targets.includes(form)) targets.push(form);
    }
  }
  // A mutation tool whose destination we cannot read is a mutation we
  // cannot validate. Missing / string / array `tool_input` all used to
  // reach enforce.js as `file_path: undefined`, which it correctly
  // reports as "nothing protected here" — an allow by omission.
  if (unreadableField || targets.length === 0) {
    deny(
      'Ferramenta de escrita sem caminho legível — bloqueada (fail-closed). '
        + 'Se o payload usa outro campo de destino, mapeie-o em cursor/hooks/enforce-cursor.js.',
      unreadableField
        ? `mutation tool name_sha256_12=${sha12(name)} had an unreadable destination `
          + `field_sha256_12=${sha12(unreadableField)}`
        : `mutation tool name_sha256_12=${sha12(name)} carried no usable path field`,
    );
  }
  mappedName = /Write|Delete/i.test(name) ? 'Write' : 'Edit';
  const content = ti.contents || ti.new_string || ti.content;
  for (const target of targets) {
    enforceOrDeny({
      tool_name: mappedName,
      tool_input: { file_path: target, path: target, content },
    });
  }
  allow();
} else if (isReadOnlyTool(name)) {
  // Read-only tools carry no write target for enforce.js to check.
  // cursor/hooks.json only routes write-shaped tools through
  // preToolUse, so these should never arrive; the allowlist is
  // belt-and-braces for an install with a broader matcher, so that
  // fail-closed below cannot brick ordinary navigation.
  allow();
} else {
  // Fail-closed default (the file header's doctrine). Previously any
  // unrecognized tool name was allowed with zero validation, so an
  // upstream tool rename would silently disable enforcement — and in
  // Cursor this hook is the only gate (permissions.json runs
  // approvalMode "unrestricted" with terminalAllowlist "*").
  deny(
    'Ferramenta não reconhecida pelo enforce do cortex — bloqueada (fail-closed). '
      + 'Se for legítima, mapeie-a em cursor/hooks/enforce-cursor.js (branch de Write/Edit) '
      + 'ou adicione-a a READ_ONLY_TOOLS quando for somente leitura.',
    `unmapped tool name_sha256_12=${sha12(name)} event_sha256_12=${sha12(eventSupplied)}`,
  );
}

enforceOrDeny({
  tool_name: mappedName,
  tool_input: mappedInput,
});

allow();
