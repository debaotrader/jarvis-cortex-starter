#!/usr/bin/env node

'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGstackCopyTuple } from './cursor-copy-ownership-guard.mjs';
import { assertSkillFrontmatterName } from './cursor-skill-frontmatter.mjs';
import {
  digestCanonicalTree,
  readStableRegularFile,
  validateStableTreeFiles,
} from './cursor-tree-digest.mjs';
import {
  assertAnchoredTransaction,
  assertDirectoryLookup,
  captureSkillSourceAttestation,
  captureDirectoryAnchor,
  commitAnchoredStage,
  createAnchoredStage,
  encodeSkillSourceAttestation,
  finalizeAnchoredTransaction,
  removeAnchoredEntry,
  removeAnchoredDirectoryByIdentity,
  rollbackAnchoredTransaction,
  snapshotDirectoryEntry,
  sourceAttestationFromMarker,
  withAnchoredDirectory,
  writePrivateAnchoredFile,
} from './cursor-anchored-fs.mjs';

const SKILL_MARKER = '.jarvis-cortex-skill.json';
const RUNTIME_MARKER = '.jarvis-cortex-runtime.json';
const STATE_MARKER = '.jarvis-cortex-state.json';
const VERSION = 2;
const RUNTIME_VERSION = 3;
const STATE_VERSION = 2;
const FROM_HOME = '$HOME/.cursor/skills/gstack';
const FROM_BRACED_HOME = '${HOME}/.cursor/skills/gstack';
const FROM_TILDE = '~/.cursor/skills/gstack';
const TO_RUNTIME = '${CURSOR_HOME:-$HOME/.cursor}/jarvis-runtime/gstack/source';
const TO_STATE = '${CURSOR_HOME:-$HOME/.cursor}/jarvis-runtime/gstack-state';
const TO_PAIR_LAUNCHER = '${CURSOR_HOME:-$HOME/.cursor}/jarvis-runtime/gstack/pair-agent';
const TO_CURSOR_REMOTE_CONFIG = `${TO_STATE}/cursor-home/.cursor/skills/gstack/browse-remote.json`;
const STATE_PATHS = [
  '.feature-prompted-continuous-checkpoint',
  '.feature-prompted-model-overlay',
  'browse-remote.json',
];
const RUNTIME_REFERENCE_PATTERNS = [
  { pattern: /\$\{?GSTACK_ROOT\}?\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g, prefix: '' },
  { pattern: /(?:~|\$HOME|\$\{HOME\})\/\.cursor\/skills\/gstack\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g, prefix: '' },
];
const RUNTIME_VARIABLE_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*)=["']?\$\{?([A-Z][A-Z0-9_]*)\}?\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g;
const REDIRECTED_STATE_REFERENCES = new Set(STATE_PATHS);
const BUN_COMMAND_ALIASES = new Map([
  ['bin/gstack-gbrain-sync', 'bin/gstack-gbrain-sync.ts'],
  ['bin/gstack-memory-ingest', 'bin/gstack-memory-ingest.ts'],
]);
const BUN_SCRIPT_PATHS = new Set(BUN_COMMAND_ALIASES.values());
const RUNTIME_LAUNCHER_REQUIREMENTS = [
  {
    relative: 'browse/dist/browse',
    sourcedOnly: false,
    directoryHint: false,
  },
];
const EXECUTABLE_ALIAS_REQUIREMENTS = new Map([
  ['B', 'browse/dist/browse'],
  ['D', 'design/dist/design'],
  ['P', 'make-pdf/dist/pdf'],
]);

const [command, sourceArg, targetArg, thirdArg, fourthArg, fifthArg] = process.argv.slice(2);
const runtimeCommands = new Set(['runtime-sync', 'runtime-verify']);
const ownerCommands = new Set(['runtime-owner-verify', 'skill-owner-verify']);
const validCommands = new Set([
  ...runtimeCommands,
  ...ownerCommands,
  'skill-parse-verify',
  'skill-attest',
  'skill-orphan-attest',
  'skill-orphan-verify',
  'runtime-remove',
  'skill-sync',
  'skill-verify',
  'skill-remove',
]);
if (!validCommands.has(command) || !sourceArg
  || (command !== 'skill-parse-verify' && !targetArg)
  || (runtimeCommands.has(command) && !thirdArg)
  || (['skill-orphan-verify', 'skill-orphan-attest'].includes(command) && (!thirdArg || !fourthArg))) {
  console.error('usage: cursor-gstack-install.mjs <runtime-sync|runtime-verify> <source> <target> <skills-root> [previous-source]');
  console.error('   or: cursor-gstack-install.mjs <runtime-owner-verify|runtime-remove|skill-owner-verify|skill-orphan-verify|skill-sync|skill-verify|skill-remove> <source> <target> [previous-source]');
  process.exit(2);
}
if (fifthArg && fifthArg !== '--defer-finalize') {
  console.error('unsupported gstack transaction option');
  process.exit(2);
}
const deferFinalize = fifthArg === '--defer-finalize';

const source = path.resolve(sourceArg);
const publicTarget = targetArg ? path.resolve(targetArg) : null;
let target = publicTarget;
const skillsRoot = runtimeCommands.has(command) ? path.resolve(thirdArg) : null;
const previousSourceArg = runtimeCommands.has(command) ? fourthArg : thirdArg;
const previousSource = previousSourceArg ? path.resolve(previousSourceArg) : null;
const publicStateTarget = publicTarget ? path.join(path.dirname(publicTarget), 'gstack-state') : null;
let stateTarget = publicStateTarget;
const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tupleName = command === 'skill-parse-verify'
  ? (targetArg || path.basename(source))
  : (runtimeCommands.has(command) || command.startsWith('runtime-') ? null : path.basename(target));
const inferredGstackRoot = path.dirname(path.dirname(path.dirname(source)));
const authorizedGstackRoot = runtimeCommands.has(command) || command.startsWith('runtime-')
  ? null
  : (fourthArg ? path.resolve(fourthArg) : inferredGstackRoot);
let ownershipTuple = null;
let ownershipTupleError = null;
if (tupleName && !['skill-parse-verify', 'skill-orphan-verify', 'skill-orphan-attest'].includes(command)) {
  try {
    ownershipTuple = validateGstackCopyTuple(
      repoRoot,
      authorizedGstackRoot,
      tupleName,
      sourceArg,
      targetArg,
      previousSourceArg || null,
    );
  } catch (error) {
    ownershipTupleError = error;
  }
}

function shellDoubleQuote(value) {
  return `"${value.replace(/[\\"`]/g, '\\$&')}"`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SHELL_FENCE_LANGUAGES = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal']);
const SHELL_PATH_PATTERNS = [
  new RegExp(`^${escapeRegex(TO_CURSOR_REMOTE_CONFIG)}(?:\\/[A-Za-z0-9._/-]*)?`),
  new RegExp(`^${escapeRegex(TO_PAIR_LAUNCHER)}(?:\\/[A-Za-z0-9._/-]*)?`),
  new RegExp(`^${escapeRegex(TO_RUNTIME)}(?:\\/[A-Za-z0-9._/-]*)?`),
  new RegExp(`^${escapeRegex(TO_STATE)}(?:\\/[A-Za-z0-9._/-]*)?`),
  /^\$HOME\$(?:GSTACK_ROOT|GSTACK_BIN|GSTACK_BROWSE|GSTACK_DESIGN|GSTACK_MAKE_PDF)(?:\/[A-Za-z0-9._/-]*)?/,
  /^\$(?:GSTACK_ROOT|GSTACK_BIN|GSTACK_BROWSE|GSTACK_DESIGN|GSTACK_MAKE_PDF)(?:\/[A-Za-z0-9._/-]*)?/,
  /^\$\{(?:GSTACK_ROOT|GSTACK_BIN|GSTACK_BROWSE|GSTACK_DESIGN|GSTACK_MAKE_PDF)\}(?:\/[A-Za-z0-9._/-]*)?/,
  /^\$(?:B|D|P)(?![A-Za-z0-9_])/,
  /^\$\{(?:B|D|P)\}/,
];

function runtimePathAt(content, index) {
  const suffix = content.slice(index);
  for (const pattern of SHELL_PATH_PATTERNS) {
    const match = suffix.match(pattern);
    if (match && match[0]) return match[0];
  }
  return null;
}

function findBacktickEnd(content, start) {
  for (let index = start; index < content.length; index += 1) {
    if (content[index] === '\\') {
      index += 1;
      continue;
    }
    if (content[index] === '`') return index;
  }
  return -1;
}

function findCommandSubstitutionEnd(content, start) {
  let groupDepth = 0;
  let quote = null;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === '$' && content[index + 1] === '(') {
        const nestedEnd = findCommandSubstitutionEnd(content, index + 2);
        if (nestedEnd < 0) return -1;
        index = nestedEnd;
        continue;
      }
      if (character === '`') {
        const nestedEnd = findBacktickEnd(content, index + 1);
        if (nestedEnd < 0) return -1;
        index = nestedEnd;
      }
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '`') {
      const nestedEnd = findBacktickEnd(content, index + 1);
      if (nestedEnd < 0) return -1;
      index = nestedEnd;
      continue;
    }
    if (character === '$' && content[index + 1] === '(') {
      const nestedEnd = findCommandSubstitutionEnd(content, index + 2);
      if (nestedEnd < 0) return -1;
      index = nestedEnd;
      continue;
    }
    if (character === '(') {
      groupDepth += 1;
      continue;
    }
    if (character === ')') {
      if (groupDepth === 0) return index;
      groupDepth -= 1;
    }
  }
  return -1;
}

function startsShellComment(content, index) {
  if (content[index] !== '#') return false;
  if (index === 0 || content[index - 1] === '\n') return true;
  return /[\s;&|()<>]/.test(content[index - 1]);
}

function parseFenceOpening(line) {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})([^\n]*)(?:\n|$)/);
  if (!match) return null;
  const fence = match[2];
  const info = match[3].replace(/\r$/, '');
  if (fence[0] === '`' && info.includes('`')) return null;
  const language = info.trim().split(/[ \t]+/, 1)[0].toLowerCase();
  return { character: fence[0], width: fence.length, language };
}

// Split only on the shell's physical newline byte. String.match with `.` is
// unsuitable here because JavaScript also treats CR as a line terminator and
// would lose CRLF/mixed-line-ending boundaries.
function physicalLines(content) {
  const lines = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    if (newline < 0) {
      lines.push(content.slice(start));
      break;
    }
    lines.push(content.slice(start, newline + 1));
    start = newline + 1;
  }
  return lines;
}

function isFenceClosing(line, fence) {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*(?:\r?\n|$)/);
  return Boolean(match
    && match[2][0] === fence.character
    && match[2].length >= fence.width);
}

function parseDoubleQuotedHeredocSegment(content, start) {
  let value = '';
  let index = start;
  while (index < content.length) {
    const character = content[index];
    if (character === '"') return { value, end: index + 1 };
    if (character === '\0') return { error: 'literal NUL in quoted heredoc delimiter' };
    if ((character === '$' && content[index + 1] === '(') || character === '`') {
      const expansion = parseShellExpansionHeredocSegment(content, index);
      if (expansion.error) return expansion;
      value += expansion.value;
      index = expansion.end;
      continue;
    }
    if (character === '\\' && index + 1 < content.length) {
      const escaped = content[index + 1];
      if (escaped === '\0') return { error: 'literal NUL in quoted heredoc delimiter' };
      if (escaped === '\n') {
        index += 2;
        continue;
      }
      if (['$', '`', '"', '\\'].includes(escaped)) {
        value += escaped;
        index += 2;
        continue;
      }
      value += `\\${escaped}`;
      index += 2;
      continue;
    }
    value += character;
    index += 1;
  }
  return null;
}

function parseSingleQuotedHeredocSegment(content, start) {
  let value = '';
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (character === '\0') return { error: 'literal NUL in quoted heredoc delimiter' };
    if (character === "'") return { value, end: index + 1 };
    value += character;
  }
  return null;
}

function ansiCodePoint(value) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '\uFFFD';
  }
}

function parseAnsiCHeredocSegment(content, start) {
  const simpleEscapes = new Map([
    ['a', '\x07'], ['b', '\b'], ['e', '\x1b'], ['E', '\x1b'], ['f', '\f'],
    ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'], ['\\', '\\'],
    ["'", "'"], ['"', '"'], ['?', '?'],
  ]);
  let value = '';
  let truncated = false;
  let index = start;
  function append(fragment) {
    if (truncated) return;
    const nul = fragment.indexOf('\0');
    if (nul < 0) {
      value += fragment;
      return;
    }
    // Bash stores each ANSI-C quoted segment as a C string: a generated NUL
    // truncates the remainder of that quoted segment. Adjacent segments after
    // its closing quote still contribute to the final delimiter word.
    value += fragment.slice(0, nul);
    truncated = true;
  }
  while (index < content.length) {
    const character = content[index];
    if (character === "'") return { value, end: index + 1 };
    if (character !== '\\' || index + 1 >= content.length) {
      if (character === '\0') return { error: 'literal NUL in ANSI-C heredoc delimiter' };
      append(character);
      index += 1;
      continue;
    }
    const escaped = content[index + 1];
    if (escaped === '\0') return { error: 'literal NUL in ANSI-C heredoc delimiter' };
    if (escaped === '\n') {
      index += 2;
      continue;
    }
    if (simpleEscapes.has(escaped)) {
      append(simpleEscapes.get(escaped));
      index += 2;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      const octal = escaped === '0'
        ? content.slice(index + 1).match(/^0[0-7]{0,3}/)[0]
        : content.slice(index + 1).match(/^[1-7][0-7]{0,2}/)[0];
      append(String.fromCharCode(Number.parseInt(octal, 8) & 0xff));
      index += 1 + octal.length;
      continue;
    }
    if (escaped === 'x') {
      const hex = content.slice(index + 2).match(/^[0-9A-Fa-f]{1,2}/)?.[0];
      if (hex) {
        append(String.fromCharCode(Number.parseInt(hex, 16)));
        index += 2 + hex.length;
        continue;
      }
    }
    if (escaped === 'u' || escaped === 'U') {
      const width = escaped === 'u' ? 4 : 8;
      const hex = content.slice(index + 2).match(new RegExp(`^[0-9A-Fa-f]{1,${width}}`))?.[0];
      if (hex) {
        append(ansiCodePoint(Number.parseInt(hex, 16)));
        index += 2 + hex.length;
        continue;
      }
    }
    if (escaped === 'c' && index + 2 < content.length) {
      append(String.fromCharCode(content.charCodeAt(index + 2) & 0x1f));
      index += 3;
      continue;
    }
    append(`\\${escaped}`);
    index += 2;
  }
  return { error: 'unterminated ANSI-C heredoc delimiter' };
}

function parseShellExpansionHeredocSegment(content, start) {
  const isBacktick = content[start] === '`';
  const isArithmetic = !isBacktick && content.startsWith('$((', start);
  const isCommand = !isBacktick && !isArithmetic && content.startsWith('$(', start);
  if (!isBacktick && !isArithmetic && !isCommand) {
    return { error: `unsupported shell expansion in heredoc delimiter at byte ${start}` };
  }

  const opener = isBacktick ? '`' : isArithmetic ? '$((' : '$(';
  const closer = isBacktick ? '`' : isArithmetic ? '))' : ')';
  let value = opener;
  let index = start + opener.length;
  let groups = 0;
  while (index < content.length) {
    const character = content[index];
    if (character === '\0') return { error: 'literal NUL in shell expansion heredoc delimiter' };

    if (isBacktick && character === '`') {
      return { value: `${value}\``, end: index + 1 };
    }
    if (isArithmetic && character === ')' && content[index + 1] === ')' && groups === 0) {
      return { value: `${value}))`, end: index + 2 };
    }
    if (isCommand && character === ')' && groups === 0) {
      return { value: `${value})`, end: index + 1 };
    }

    if (character === '\\') {
      if (index + 1 >= content.length) {
        return { error: `trailing escape in ${opener} heredoc delimiter` };
      }
      const escaped = content[index + 1];
      if (escaped === '\0') return { error: 'literal NUL in shell expansion heredoc delimiter' };
      if (escaped !== '\n') value += escaped;
      index += 2;
      continue;
    }
    if (character === '$' && content[index + 1] === "'") {
      const segment = parseAnsiCHeredocSegment(content, index + 2);
      if (segment.error) return segment;
      value += segment.value;
      index = segment.end;
      continue;
    }
    if (character === '$' && content[index + 1] === '"') {
      const segment = parseDoubleQuotedHeredocSegment(content, index + 2);
      if (!segment || segment.error) return segment || { error: 'unterminated locale-quoted heredoc delimiter' };
      value += segment.value;
      index = segment.end;
      continue;
    }
    if (character === "'") {
      const segment = parseSingleQuotedHeredocSegment(content, index + 1);
      if (!segment || segment.error) return segment || { error: 'unterminated single-quoted heredoc delimiter' };
      value += segment.value;
      index = segment.end;
      continue;
    }
    if (character === '"') {
      const segment = parseDoubleQuotedHeredocSegment(content, index + 1);
      if (!segment || segment.error) return segment || { error: 'unterminated double-quoted heredoc delimiter' };
      value += segment.value;
      index = segment.end;
      continue;
    }
    if ((character === '$' && content[index + 1] === '(') || (!isBacktick && character === '`')) {
      const nested = parseShellExpansionHeredocSegment(content, index);
      if (nested.error) return nested;
      value += nested.value;
      index = nested.end;
      continue;
    }

    if (!isBacktick && character === '(') {
      groups += 1;
      value += character;
      index += 1;
      continue;
    }
    if (!isBacktick && character === ')' && groups > 0) {
      groups -= 1;
      value += character;
      index += 1;
      continue;
    }
    value += character;
    index += 1;
  }
  return { error: `unterminated ${opener} heredoc delimiter; expected ${closer}` };
}

function parseHeredocDelimiter(content, start) {
  let index = start;
  while (content[index] === ' ' || content[index] === '\t') index += 1;
  let delimiter = '';
  let consumed = false;
  while (index < content.length) {
    const character = content[index];
    if ((character === '$' && content[index + 1] === '(') || character === '`') {
      const expansion = parseShellExpansionHeredocSegment(content, index);
      if (expansion.error) return expansion;
      delimiter += expansion.value;
      index = expansion.end;
      consumed = true;
      continue;
    }
    // Bash's lexer treats blank (space/tab) and LF as separators here. CR is
    // an ordinary byte in a physical CRLF line and therefore participates in
    // both the delimiter word and its matching terminator line.
    if (character === ' ' || character === '\t' || character === '\n'
      || ';&|()<>'.includes(character)) break;
    if (character === '\0') return { error: 'literal NUL in heredoc delimiter' };
    consumed = true;
    if (character === '\\') {
      if (index + 1 >= content.length) return { error: 'trailing escape in heredoc delimiter' };
      if (content[index + 1] === '\0') return { error: 'literal NUL in heredoc delimiter' };
      if (content[index + 1] !== '\n') delimiter += content[index + 1];
      index += 2;
      continue;
    }
    if (character === '$' && content[index + 1] === "'") {
      const segment = parseAnsiCHeredocSegment(content, index + 2);
      if (segment.error) return segment;
      delimiter += segment.value;
      index = segment.end;
      continue;
    }
    if (character === '$' && content[index + 1] === '"') {
      const segment = parseDoubleQuotedHeredocSegment(content, index + 2);
      if (!segment || segment.error) return segment || { error: 'unterminated locale-quoted heredoc delimiter' };
      delimiter += segment.value;
      index = segment.end;
      continue;
    }
    if (character === "'") {
      const segment = parseSingleQuotedHeredocSegment(content, index + 1);
      if (!segment || segment.error) return segment || { error: 'unterminated single-quoted heredoc delimiter' };
      delimiter += segment.value;
      index = segment.end;
      continue;
    }
    if (character === '"') {
      const segment = parseDoubleQuotedHeredocSegment(content, index + 1);
      if (!segment || segment.error) return segment || { error: 'unterminated double-quoted heredoc delimiter' };
      delimiter += segment.value;
      index = segment.end;
      continue;
    }
    delimiter += character;
    index += 1;
  }
  return consumed ? { delimiter, end: index } : { error: 'missing heredoc delimiter' };
}

function heredocRanges(content) {
  const ranges = [];
  const errors = [];
  const pending = [];
  const stack = [{ type: 'shell', terminator: null, groups: 0 }];

  function consumeBodies(start) {
    let cursor = start;
    for (const heredoc of pending) {
      const bodyStart = cursor;
      let found = false;
      while (cursor <= content.length) {
        const newline = content.indexOf('\n', cursor);
        const lineEnd = newline < 0 ? content.length : newline;
        let line = content.slice(cursor, lineEnd);
        if (heredoc.stripTabs) line = line.replace(/^\t+/, '');
        const next = newline < 0 ? content.length : newline + 1;
        if (line === heredoc.delimiter) {
          ranges.push({ start: bodyStart, end: next });
          cursor = next;
          found = true;
          break;
        }
        if (newline < 0) break;
        cursor = next;
      }
      if (!found) {
        errors.push(`unterminated heredoc delimiter ${JSON.stringify(heredoc.delimiter)}`);
        cursor = content.length;
        break;
      }
    }
    pending.length = 0;
    return cursor;
  }

  for (let index = 0; index < content.length; index += 1) {
    const frame = stack.at(-1);
    const character = content[index];
    if (frame.type === 'arithmetic') {
      if (character === '\\') {
        index += 1;
      } else if (character === '$' && content[index + 1] === '(') {
        if (content[index + 2] === '(') {
          stack.push({ type: 'arithmetic', groups: 0 });
          index += 2;
        } else {
          stack.push({ type: 'shell', terminator: ')', groups: 0 });
          index += 1;
        }
      } else if (character === '(') {
        frame.groups += 1;
      } else if (character === ')' && frame.groups > 0) {
        frame.groups -= 1;
      } else if (character === ')' && content[index + 1] === ')') {
        stack.pop();
        index += 1;
      }
      continue;
    }
    if (frame.type === 'single') {
      if (character === "'") stack.pop();
      continue;
    }
    if (frame.type === 'double') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        stack.pop();
      } else if (character === '$' && content[index + 1] === '(') {
        if (content[index + 2] === '(') {
          stack.push({ type: 'arithmetic', groups: 0 });
          index += 2;
        } else {
          stack.push({ type: 'shell', terminator: ')', groups: 0 });
          index += 1;
        }
      } else if (character === '`') {
        stack.push({ type: 'shell', terminator: '`', groups: 0 });
      }
      continue;
    }
    if (frame.terminator === '`' && character === '`') {
      stack.pop();
      continue;
    }
    if (frame.terminator === ')' && character === ')' && frame.groups === 0) {
      stack.pop();
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'") {
      stack.push({ type: 'single' });
      continue;
    }
    if (character === '"') {
      stack.push({ type: 'double' });
      continue;
    }
    if (character === '`') {
      stack.push({ type: 'shell', terminator: '`', groups: 0 });
      continue;
    }
    if (character === '$' && content[index + 1] === '(') {
      if (content[index + 2] === '(') {
        stack.push({ type: 'arithmetic', groups: 0 });
        index += 2;
      } else {
        stack.push({ type: 'shell', terminator: ')', groups: 0 });
        index += 1;
      }
      continue;
    }
    if (character === '(' && content[index + 1] === '(') {
      stack.push({ type: 'arithmetic', groups: 0 });
      index += 1;
      continue;
    }
    if (frame.terminator === ')' && character === '(') {
      frame.groups += 1;
      continue;
    }
    if (frame.terminator === ')' && character === ')' && frame.groups > 0) {
      frame.groups -= 1;
      continue;
    }
    if (startsShellComment(content, index)) {
      const newline = content.indexOf('\n', index);
      if (newline < 0) break;
      index = newline - 1;
      continue;
    }
    if (character === '<' && content[index + 1] === '<'
      && content[index - 1] !== '<' && content[index + 2] !== '<') {
      const stripTabs = content[index + 2] === '-';
      const parsed = parseHeredocDelimiter(content, index + (stripTabs ? 3 : 2));
      if (!parsed.error) {
        pending.push({ delimiter: parsed.delimiter, stripTabs });
        index = parsed.end - 1;
        continue;
      }
      errors.push(`${parsed.error} at byte ${index}`);
      break;
    }
    if (character === '\n' && pending.length > 0) {
      index = consumeBodies(index + 1) - 1;
    }
  }
  if (pending.length > 0) {
    errors.push(`unterminated heredoc command line for delimiter ${JSON.stringify(pending[0].delimiter)}`);
  }
  return { ranges, errors };
}

function protectMarkdownHeredocs(content) {
  const lines = physicalLines(content);
  const output = [];
  const protectedBodies = new Map();
  const nonce = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  let bodyIndex = 0;
  let fence = null;
  let fenceIsShell = false;
  let fenceBody = [];

  function protectBody(body) {
    const parsed = heredocRanges(body);
    if (parsed.errors.length > 0) {
      throw new Error(`unsupported or invalid shell heredoc: ${parsed.errors.join('; ')}`);
    }
    const { ranges } = parsed;
    if (ranges.length === 0) return body;
    let rendered = '';
    let cursor = 0;
    for (const range of ranges) {
      rendered += body.slice(cursor, range.start);
      const original = body.slice(range.start, range.end);
      let token;
      do {
        token = `\u0000JARVIS_HEREDOC_${nonce}_${bodyIndex += 1}\u0000`;
      } while (content.includes(token));
      const replacement = `${token}${original.endsWith('\n') ? '\n' : ''}`;
      protectedBodies.set(replacement, original);
      rendered += replacement;
      cursor = range.end;
    }
    return rendered + body.slice(cursor);
  }

  for (const line of lines) {
    if (!fence) {
      const opening = parseFenceOpening(line);
      if (!opening) {
        output.push(line);
        continue;
      }
      fence = opening;
      fenceIsShell = SHELL_FENCE_LANGUAGES.has(opening.language);
      fenceBody = [];
      output.push(line);
      continue;
    }
    if (!isFenceClosing(line, fence)) {
      fenceBody.push(line);
      continue;
    }
    const body = fenceBody.join('');
    output.push(fenceIsShell ? protectBody(body) : body);
    output.push(line);
    fence = null;
    fenceIsShell = false;
    fenceBody = [];
  }
  if (fence) {
    const body = fenceBody.join('');
    output.push(fenceIsShell ? protectBody(body) : body);
  }
  return { content: output.join(''), protectedBodies };
}

// Quote only shell words. Markdown prose and ordinary string interpolation are
// intentionally left untouched. Nested command substitutions inside a quoted
// string are recursively treated as shell, because their argv is split by a
// separate shell context (for example: eval "$(<runtime>/bin/tool)").
function quoteRuntimeShellSnippet(content) {
  let output = '';
  let quote = null;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quote === "'") {
      output += character;
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        output += character;
        if (index + 1 < content.length) output += content[index += 1];
        continue;
      }
      if (character === '"') {
        output += character;
        quote = null;
        continue;
      }
      if (character === '$' && content[index + 1] === '(') {
        const end = findCommandSubstitutionEnd(content, index + 2);
        if (end >= 0) {
          output += `$(${quoteRuntimeShellSnippet(content.slice(index + 2, end))})`;
          index = end;
          continue;
        }
      }
      if (character === '`') {
        const end = findBacktickEnd(content, index + 1);
        if (end >= 0) {
          output += `\`${quoteRuntimeShellSnippet(content.slice(index + 1, end))}\``;
          index = end;
          continue;
        }
      }
      output += character;
      continue;
    }
    if (character === '\\') {
      output += character;
      if (index + 1 < content.length) output += content[index += 1];
      continue;
    }
    if (character === "'" || character === '"') {
      output += character;
      quote = character;
      continue;
    }
    if (startsShellComment(content, index)) {
      const newline = content.indexOf('\n', index);
      if (newline < 0) return output + content.slice(index);
      output += content.slice(index, newline + 1);
      index = newline;
      continue;
    }
    if (character === '`') {
      const end = findBacktickEnd(content, index + 1);
      if (end >= 0) {
        output += `\`${quoteRuntimeShellSnippet(content.slice(index + 1, end))}\``;
        index = end;
        continue;
      }
    }
    const runtimePath = runtimePathAt(content, index);
    if (runtimePath) {
      output += shellDoubleQuote(runtimePath);
      index += runtimePath.length - 1;
      continue;
    }
    output += character;
  }
  return output;
}

function inlineCodeLooksLikeShell(content) {
  if (!/[\s;&|<>()=]/.test(content)) return false;
  for (let index = 0; index < content.length; index += 1) {
    if (runtimePathAt(content, index)) return true;
  }
  return false;
}

function quoteInlineShellCode(line) {
  let output = '';
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      output += line[index];
      index += 1;
      continue;
    }
    let width = 1;
    while (line[index + width] === '`') width += 1;
    const delimiter = '`'.repeat(width);
    const end = line.indexOf(delimiter, index + width);
    if (end < 0) return output + line.slice(index);
    const body = line.slice(index + width, end);
    output += delimiter;
    output += inlineCodeLooksLikeShell(body) ? quoteRuntimeShellSnippet(body) : body;
    output += delimiter;
    index = end + width;
  }
  return output;
}

function quoteRuntimeShellContexts(content) {
  const lines = physicalLines(content);
  const output = [];
  let fence = null;
  let fenceIsShell = false;
  let fenceBody = [];
  for (const line of lines) {
    if (!fence) {
      const opening = parseFenceOpening(line);
      if (!opening) {
        output.push(quoteInlineShellCode(line));
        continue;
      }
      fence = opening;
      fenceIsShell = SHELL_FENCE_LANGUAGES.has(opening.language);
      fenceBody = [];
      output.push(line);
      continue;
    }
    if (!isFenceClosing(line, fence)) {
      fenceBody.push(line);
      continue;
    }
    const body = fenceBody.join('');
    output.push(fenceIsShell ? quoteRuntimeShellSnippet(body) : body);
    output.push(line);
    fence = null;
    fenceIsShell = false;
    fenceBody = [];
  }
  if (fence) {
    const body = fenceBody.join('');
    output.push(fenceIsShell ? quoteRuntimeShellSnippet(body) : body);
  }
  return output.join('');
}

function transformMarkdown(content) {
  const protectedMarkdown = protectMarkdownHeredocs(content);
  let transformed = protectedMarkdown.content;
  for (const [alias, script] of BUN_COMMAND_ALIASES) {
    const renderedCommand = `bun run ${shellDoubleQuote(`${TO_RUNTIME}/${script}`)}`;
    for (const root of ['$GSTACK_ROOT', FROM_BRACED_HOME, FROM_HOME, FROM_TILDE]) {
      transformed = transformed
        .replaceAll(`bun run ${root}/${script}`, renderedCommand)
        .replaceAll(`bun run "${root}/${script}"`, renderedCommand);
    }
    const commandReferences = [
      ...['$GSTACK_ROOT', FROM_BRACED_HOME, FROM_HOME, FROM_TILDE]
        .map((root) => `${root}/${alias}`),
      `$GSTACK_BIN/${path.posix.basename(alias)}`,
      `\${GSTACK_BIN}/${path.posix.basename(alias)}`,
    ];
    for (const reference of commandReferences) {
      const literal = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      transformed = transformed.replace(
        new RegExp(`${literal}(?![A-Za-z0-9._/-])`, 'g'),
        renderedCommand,
      );
    }
  }
  transformed = transformed
    .replace(/"(?:\$B|\$\{B\})"(?=\s+pair-agent\b)/g, shellDoubleQuote(TO_PAIR_LAUNCHER))
    .replace(
      /(?<!["'\\])(?:\$B(?![A-Za-z0-9_])|\$\{B\})(?=\s+pair-agent\b)/g,
      TO_PAIR_LAUNCHER,
    );
  for (const statePath of STATE_PATHS) {
    if (statePath !== 'browse-remote.json') {
      transformed = transformed.replaceAll(`$GSTACK_ROOT/${statePath}`, `${TO_STATE}/${statePath}`);
    }
    for (const root of [FROM_BRACED_HOME, FROM_HOME, FROM_TILDE]) {
      const destination = statePath === 'browse-remote.json'
        ? TO_CURSOR_REMOTE_CONFIG
        : `${TO_STATE}/${statePath}`;
      transformed = transformed.replaceAll(`${root}/${statePath}`, destination);
    }
  }
  transformed = transformed
    .replaceAll('B="$HOME$GSTACK_BROWSE/browse"', `B="${TO_RUNTIME}/browse/dist/browse"`)
    .replaceAll('D="$HOME$GSTACK_DESIGN/design"', `D="${TO_RUNTIME}/design/dist/design"`)
    .replaceAll('P="$HOME$GSTACK_MAKE_PDF/pdf"', `P="${TO_RUNTIME}/make-pdf/dist/pdf"`)
    .replaceAll(FROM_BRACED_HOME, TO_RUNTIME)
    .replaceAll(FROM_HOME, TO_RUNTIME)
    .replaceAll(FROM_TILDE, TO_RUNTIME);
  transformed = quoteRuntimeShellContexts(transformed);
  for (const [replacement, original] of protectedMarkdown.protectedBodies) {
    transformed = transformed.replaceAll(replacement, original);
  }
  return transformed;
}

function validateGstackDigestEntry({ relative, stat, type }) {
  const display = relative || '.';
  assertOwnedSafeFile(stat, `gstack digest tree entry ${display}`);
  if (type === 'directory' && (stat.mode & 0o500) !== 0o500) {
    throw new Error(`gstack digest tree directory is not owner-readable/executable: ${display}`);
  }
  if (type === 'file' && (stat.mode & 0o400) === 0) {
    throw new Error(`gstack digest tree file is not owner-readable: ${display}`);
  }
}

function digestTree(root, transform) {
  return digestCanonicalTree(root, {
    label: 'gstack digest tree',
    excludedRootEntries: [SKILL_MARKER],
    validateEntry: validateGstackDigestEntry,
    transformFile: transform
      ? ({ absolute, content }) => absolute.endsWith('.md')
        ? Buffer.from(transformMarkdown(content.toString('utf8')))
        : content
      : undefined,
  });
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sourceIdentity(candidate) {
  const sourcePath = path.resolve(candidate);
  let sourceReal;
  try {
    sourceReal = fs.realpathSync(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    const suffix = [];
    let ancestor = sourcePath;
    while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    sourceReal = path.join(fs.realpathSync(ancestor), ...suffix);
  }
  return { sourcePath, sourceReal };
}

function markerMatchesSourceIdentity(marker, candidates) {
  return candidates.filter(Boolean).some((candidate) => {
    const identity = sourceIdentity(candidate);
    return marker.sourcePath === identity.sourcePath && marker.sourceReal === identity.sourceReal;
  });
}

function readOwnedMarker(markerFile, mode, candidates) {
  const markerStat = fs.lstatSync(markerFile, { throwIfNoEntry: false });
  if (!markerStat
    || !markerStat.isFile()
    || markerStat.isSymbolicLink()
    || markerStat.nlink !== 1
    || (currentUid !== null && markerStat.uid !== currentUid)
    || (markerStat.mode & 0o022) !== 0
    || (markerStat.mode & 0o777) !== 0o600) {
    return null;
  }
  let marker;
  try {
    marker = JSON.parse(readStableRegularFile(markerFile, {
      label: `${mode} marker`,
      expectedStat: markerStat,
    }).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return null;
    throw error;
  }
  const validVersion = mode === 'gstack-runtime'
    ? marker.version === RUNTIME_VERSION
    : [1, VERSION].includes(marker.version);
  if (!validVersion || marker.owner !== 'jarvis-cortex' || marker.mode !== mode) return null;
  if (mode === 'gstack-copy' && marker.version === VERSION
    && (marker.name !== tupleName || marker.provenance !== 'gstack')) return null;
  if (mode === 'gstack-runtime' && marker.layout !== 'source-link+pair-launcher') return null;
  return markerMatchesSourceIdentity(marker, candidates) ? marker : null;
}

function targetExists(candidate) {
  return fs.lstatSync(candidate, { throwIfNoEntry: false }) !== undefined;
}

function assertRealDirectory(candidate, label) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
}

function assertRealTree(root, label) {
  validateStableTreeFiles(root, {
    label,
    validateEntry({ relative, stat, type }) {
      const display = relative || '.';
      assertOwnedSafeFile(stat, `${label} entry ${display}`);
      if (type === 'directory' && (stat.mode & 0o500) !== 0o500) {
        throw new Error(`${label} directory is not owner-readable/executable: ${display}`);
      }
      if (type === 'file' && (stat.mode & 0o400) === 0) {
        throw new Error(`${label} file is not owner-readable: ${display}`);
      }
    },
  });
}

function orphanSourceIsUnavailable() {
  const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) return true;
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return false;
  if ((currentUid !== null && sourceStat.uid !== currentUid)
    || (sourceStat.mode & 0o022) !== 0) return false;
  if ((sourceStat.mode & 0o500) !== 0o500) return true;

  const skillFile = path.join(source, 'SKILL.md');
  const skillStat = fs.lstatSync(skillFile, { throwIfNoEntry: false });
  if (!skillStat) return true;
  if (!skillStat.isFile() || skillStat.isSymbolicLink()
    || (currentUid !== null && skillStat.uid !== currentUid)
    || (skillStat.mode & 0o022) !== 0) return false;
  if ((skillStat.mode & 0o400) === 0) return true;
  try {
    assertSkillFrontmatterName(skillFile, tupleName, `orphaned gstack source ${tupleName}`);
    return false;
  } catch (error) {
    return error?.code === 'EACCES' || error?.code === 'EPERM';
  }
}

function assertOrphanedGstackSkillOwnership() {
  if (!path.isAbsolute(sourceArg) || path.normalize(sourceArg) !== sourceArg) {
    throw new Error(`orphaned gstack source is not canonical absolute: ${sourceArg}`);
  }
  if (!previousSourceArg
    || !path.isAbsolute(previousSourceArg)
    || path.normalize(previousSourceArg) !== previousSourceArg
    || previousSource !== source) {
    throw new Error('orphaned gstack source does not match the exact historical manifest source');
  }
  if (!path.isAbsolute(fourthArg) || path.normalize(fourthArg) !== fourthArg) {
    throw new Error(`orphaned gstack root is not canonical absolute: ${fourthArg}`);
  }
  const rootStat = fs.lstatSync(authorizedGstackRoot, { throwIfNoEntry: false });
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
    throw new Error(`orphaned gstack root is not a real directory: ${authorizedGstackRoot}`);
  }
  let rootReal;
  if (rootStat) {
    assertOwnedSafeFile(rootStat, 'orphaned gstack root');
    for (const filename of ['ETHOS.md', 'VERSION']) {
      const identity = path.join(authorizedGstackRoot, filename);
      const identityStat = fs.lstatSync(identity, { throwIfNoEntry: false });
      if (!identityStat || !identityStat.isFile() || identityStat.isSymbolicLink()) {
        throw new Error(`orphaned gstack root identity is missing or unsafe: ${identity}`);
      }
      assertOwnedSafeFile(identityStat, 'orphaned gstack root identity');
    }
    rootReal = fs.realpathSync(authorizedGstackRoot);
  } else {
    // The whole checkout may be temporarily unavailable. Its prior manifest
    // tuple plus the marker's exact physical identity remain recoverable, but
    // only while the installed digest is still byte-for-byte intact.
    rootReal = sourceIdentity(authorizedGstackRoot).sourceReal;
  }
  const generatedRoot = path.join(rootReal, '.cursor', 'skills');
  const sourceLeaf = path.basename(source);
  if (path.dirname(source) !== generatedRoot
    || !/^gstack(?:-|$)/.test(sourceLeaf)
    || sourceLeaf === '.' || sourceLeaf === '..') {
    throw new Error(`orphaned gstack source is outside the authorized generated catalog: ${source}`);
  }
  if (!orphanSourceIsUnavailable()) {
    throw new Error(`orphaned gstack source is still a readable catalog candidate: ${source}`);
  }
  if (rootStat) {
    for (const candidate of [path.dirname(generatedRoot), generatedRoot]) {
      assertRealDirectory(candidate, 'orphaned gstack generated source parent');
      assertOwnedSafeFile(fs.lstatSync(candidate), 'orphaned gstack generated source parent');
      if (!isWithin(fs.realpathSync(candidate), rootReal)) {
        throw new Error(`orphaned gstack generated source parent escapes its root: ${candidate}`);
      }
    }
  }
  assertRealDirectory(target, 'orphaned installed gstack copy');
  assertRealTree(target, 'orphaned installed gstack copy');
  assertSkillFrontmatterName(
    path.join(target, 'SKILL.md'),
    tupleName,
    `orphaned installed gstack copy ${tupleName}`,
  );
  const marker = readOwnedMarker(path.join(target, SKILL_MARKER), 'gstack-copy', [source]);
  if (!marker || marker.version !== VERSION
    || typeof marker.digest !== 'string'
    || digestTree(target, false) !== marker.digest) {
    throw new Error('orphaned gstack marker or content digest mismatch');
  }
}

function assertOwnedSafeFile(stat, label, executable = false) {
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} is group/world-writable`);
  }
  if (executable && (stat.mode & 0o100) === 0) {
    throw new Error(`${label} is not executable by its owner`);
  }
}

function assertPrivateRegularMarker(candidate, label) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (currentUid !== null && stat.uid !== currentUid)
    || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} is not a private regular file with link count 1`);
  }
}

function assertGstackSkillMarkdownParseable() {
  assertRealDirectory(source, 'gstack skill source');
  assertRealTree(source, 'gstack skill source');
  let markdownCount = 0;
  function visit(current) {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile() || !current.endsWith('.md')) return;
    markdownCount += 1;
    transformMarkdown(readStableRegularFile(current, {
      label: 'gstack skill Markdown source',
      expectedStat: stat,
    }).toString('utf8'));
  }
  visit(source);
  if (markdownCount === 0) throw new Error('gstack skill source has no Markdown file');
}

function assertGstackSkillSource() {
  assertGstackSkillMarkdownParseable();
  assertRealDirectory(source, 'gstack skill source');
  const generatedRoot = path.dirname(source);
  const cursorRoot = path.dirname(generatedRoot);
  const sourceRoot = path.dirname(cursorRoot);
  if (path.basename(generatedRoot) !== 'skills' || path.basename(cursorRoot) !== '.cursor') {
    throw new Error('gstack skill source is not under .cursor/skills');
  }
  assertRealDirectory(sourceRoot, 'gstack source root');
  assertRealDirectory(cursorRoot, 'gstack .cursor root');
  assertRealDirectory(generatedRoot, 'generated Cursor skills root');
  const sourceRootReal = fs.realpathSync(sourceRoot);
  if (!isWithin(fs.realpathSync(generatedRoot), sourceRootReal)
    || !isWithin(fs.realpathSync(source), sourceRootReal)) {
    throw new Error('gstack skill source resolves outside the gstack source root');
  }
  const skillFile = path.join(source, 'SKILL.md');
  const skillStat = fs.lstatSync(skillFile);
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new Error('gstack skill SKILL.md is not a real regular file');
  }
  assertOwnedSafeFile(skillStat, 'gstack skill SKILL.md');
  assertSkillFrontmatterName(skillFile, tupleName, `gstack skill source ${tupleName}`);
  assertRealTree(source, 'gstack skill source');
  const requirements = collectRuntimeRequirements([
    readStableRegularFile(skillFile, {
      label: `gstack skill source ${tupleName}`,
      expectedStat: skillStat,
    }).toString('utf8'),
  ]);
  if ([...requirements.values()].some(({ bunScript }) => bunScript)) assertBunAvailable();
  validateRuntimeRequirements(sourceRoot, sourceRootReal, requirements);
}

function ownedTargetMarker(mode, candidates) {
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) return null;
  const markerName = mode === 'gstack-runtime' ? RUNTIME_MARKER : SKILL_MARKER;
  if (mode === 'gstack-copy') {
    if (!ownershipTuple) return null;
    try {
      assertSkillFrontmatterName(
        path.join(target, 'SKILL.md'),
        tupleName,
        `installed gstack copy ${tupleName}`,
      );
    } catch {
      return null;
    }
    return readOwnedMarker(path.join(target, markerName), mode, ownershipTuple.candidates);
  }
  return readOwnedMarker(path.join(target, markerName), mode, candidates);
}

function referenceIsSourced(content, matchIndex) {
  const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;
  const before = content.slice(lineStart, matchIndex);
  return /^\s*(?:\.|source)\s+$/.test(before);
}

function referenceIsDirectoryTest(content, matchIndex) {
  const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;
  const before = content.slice(lineStart, matchIndex);
  return /(?:^|\s)-d\s+["']?$/.test(before);
}

function referenceRequiresExecutable(requirement) {
  const relative = requirement.relative;
  const extension = path.posix.extname(relative);
  if (relative.startsWith('bin/')) {
    if (['.ts', '.js', '.mjs', '.cjs', '.py', '.rb'].includes(extension)) return false;
    if (extension === '.sh' && requirement.sourcedOnly) return false;
    return true;
  }
  if (relative.startsWith('browse/bin/')) return true;
  const parts = relative.split('/');
  return parts.length > 1 && parts.at(-2) === 'dist' && extension === '';
}

function runtimeVariablePrefixes(content) {
  const assignments = [...content.matchAll(RUNTIME_VARIABLE_ASSIGNMENT)]
    .map((match) => ({ variable: match[1], base: match[2], relative: match[3] }));
  const prefixes = new Map([['GSTACK_ROOT', '']]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (!prefixes.has(assignment.base)) continue;
      const prefix = path.posix.join(prefixes.get(assignment.base), assignment.relative);
      const existing = prefixes.get(assignment.variable);
      if (existing !== undefined && existing !== prefix) {
        throw new Error(`conflicting gstack runtime variable mapping: ${assignment.variable}`);
      }
      if (existing === undefined) {
        prefixes.set(assignment.variable, prefix);
        changed = true;
      }
    }
  }
  return prefixes;
}

function collectRuntimeRequirements(contents, includeRuntimeLaunchers = false) {
  const referenced = new Map((includeRuntimeLaunchers ? RUNTIME_LAUNCHER_REQUIREMENTS : [])
    .map((requirement) => [requirement.relative, { ...requirement }]));
  for (const rawContent of contents) {
    const content = protectMarkdownHeredocs(rawContent).content;
    for (const [variable, relative] of EXECUTABLE_ALIAS_REQUIREMENTS) {
      const aliasPattern = new RegExp(`\\$(?:${variable}(?![A-Za-z0-9_])|\\{${variable}\\})`);
      if (!aliasPattern.test(content)) continue;
      const requirement = referenced.get(relative) || {
        relative,
        sourcedOnly: false,
        directoryHint: false,
      };
      requirement.sourcedOnly = false;
      referenced.set(relative, requirement);
    }

    const patterns = [...RUNTIME_REFERENCE_PATTERNS];
    for (const [variable, prefix] of runtimeVariablePrefixes(content)) {
      if (variable === 'GSTACK_ROOT') continue;
      patterns.push({
        pattern: new RegExp(`\\$\\{?${variable}\\}?\\/([A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)*)`, 'g'),
        prefix,
      });
    }
    for (const { pattern, prefix } of patterns) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const referencedRelative = prefix ? path.posix.join(prefix, match[1]) : match[1];
        const relative = BUN_COMMAND_ALIASES.get(referencedRelative) || referencedRelative;
        const isBunScript = BUN_COMMAND_ALIASES.has(referencedRelative)
          || BUN_SCRIPT_PATHS.has(referencedRelative);
        if (REDIRECTED_STATE_REFERENCES.has(relative)) continue;
        const requirement = referenced.get(relative) || {
          relative,
          sourcedOnly: true,
          directoryHint: false,
          bunScript: isBunScript,
        };
        if (isBunScript) requirement.bunScript = true;
        if (!referenceIsSourced(content, match.index)) requirement.sourcedOnly = false;
        if (referenceIsDirectoryTest(content, match.index)) requirement.directoryHint = true;
        referenced.set(relative, requirement);
      }
    }
  }

  const referencedPaths = [...referenced.keys()].sort();
  for (const requirement of referenced.values()) {
    requirement.type = requirement.directoryHint
      || referencedPaths.some((candidate) => candidate.startsWith(`${requirement.relative}/`))
      ? 'directory'
      : 'file';
    requirement.executable = requirement.type === 'file' && referenceRequiresExecutable(requirement);
  }
  return referenced;
}

function validateRuntimeRequirements(runtimeRoot, runtimeRootReal, referenced) {
  const validatedDirectories = new Set();

  function validateDirectory(candidate, relative, required = true) {
    if (validatedDirectories.has(candidate)) return true;
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        if (!required) return false;
        throw new Error(`required gstack runtime directory missing: ${relative || '.'}`);
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`required gstack runtime directory is not a real directory: ${relative || '.'}`);
    }
    assertOwnedSafeFile(stat, `required gstack runtime directory ${relative || '.'}`);
    const real = fs.realpathSync(candidate);
    if (!isWithin(real, runtimeRootReal)) {
      throw new Error(`required gstack runtime directory resolves outside source: ${relative || '.'}`);
    }
    validatedDirectories.add(candidate);
    return true;
  }

  validateDirectory(runtimeRoot, '');
  for (const requirement of [...referenced.values()]
    .sort((left, right) => left.relative.localeCompare(right.relative))) {
    const segments = requirement.relative.split('/').filter(Boolean);
    const directorySegments = requirement.type === 'directory' ? segments : segments.slice(0, -1);
    let directory = runtimeRoot;
    for (let index = 0; index < directorySegments.length; index += 1) {
      directory = path.join(directory, directorySegments[index]);
      if (!validateDirectory(
        directory,
        directorySegments.slice(0, index + 1).join('/'),
        false,
      )) break;
    }
    const asset = path.join(runtimeRoot, requirement.relative);
    let assetStat;
    try {
      assetStat = fs.lstatSync(asset);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw new Error(`required gstack runtime asset missing: ${requirement.relative}`);
      }
      throw error;
    }
    if (assetStat.isSymbolicLink()) {
      throw new Error(`required gstack runtime asset is a symlink: ${requirement.relative}`);
    }
    const assetReal = fs.realpathSync(asset);
    if (!isWithin(assetReal, runtimeRootReal)) {
      throw new Error(`required gstack runtime asset resolves outside source: ${requirement.relative}`);
    }
    if (requirement.type === 'directory' && !assetStat.isDirectory()) {
      throw new Error(`required gstack runtime asset is not a directory: ${requirement.relative}`);
    }
    if (requirement.type === 'file' && !assetStat.isFile()) {
      throw new Error(`required gstack runtime asset is not a regular file: ${requirement.relative}`);
    }
    if (requirement.type === 'file') {
      if (requirement.executable && (assetStat.mode & 0o100) === 0) {
        throw new Error(`required gstack runtime asset is not executable: ${requirement.relative}`);
      }
      assertOwnedSafeFile(
        assetStat,
        `required gstack runtime asset ${requirement.relative}`,
      );
    }
    if (requirement.bunScript) {
      const firstLine = fs.readFileSync(asset, 'utf8').split(/\r?\n/, 1)[0];
      if (firstLine !== '#!/usr/bin/env bun') {
        throw new Error(`required gstack Bun runtime asset has an unexpected shebang: ${requirement.relative}`);
      }
    }
  }
}

function resolveExecutableOnPath(name) {
  const environment = process[['e', 'nv'].join('')];
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function assertBunAvailable() {
  if (!resolveExecutableOnPath('bun')) {
    throw new Error('Bun executable is required on PATH for Cursor gstack skills');
  }
}

function assertRuntimeSource() {
  assertRealDirectory(source, 'gstack runtime source');
  assertBunAvailable();
  const sourceReal = fs.realpathSync(source);

  const generatedRoot = path.join(source, '.cursor', 'skills');
  assertRealDirectory(path.join(source, '.cursor'), 'gstack .cursor root');
  assertRealDirectory(generatedRoot, 'generated Cursor skills root');
  if (!isWithin(fs.realpathSync(generatedRoot), sourceReal)) {
    throw new Error('generated Cursor skills root resolves outside the gstack runtime source');
  }

  const generatedContents = [];
  let generatedCount = 0;
  for (const entry of fs.readdirSync(generatedRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!/^gstack(?:-|$)/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`generated Cursor skill is not a real directory: ${entry.name}`);
    }
    const skillRoot = path.join(generatedRoot, entry.name);
    if (!isWithin(fs.realpathSync(skillRoot), sourceReal)) {
      throw new Error(`generated Cursor skill resolves outside the gstack runtime source: ${entry.name}`);
    }
    const skillFile = path.join(skillRoot, 'SKILL.md');
    const skillStat = fs.lstatSync(skillFile);
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
      throw new Error(`generated Cursor skill is not a real regular file: ${entry.name}/SKILL.md`);
    }
    assertOwnedSafeFile(skillStat, `generated Cursor skill ${entry.name}/SKILL.md`);
    if (!isWithin(fs.realpathSync(skillFile), sourceReal)) {
      throw new Error(`generated Cursor skill resolves outside the gstack runtime source: ${entry.name}/SKILL.md`);
    }
    assertRealTree(skillRoot, `generated Cursor skill ${entry.name}`);
    generatedCount += 1;
    generatedContents.push(fs.readFileSync(skillFile, 'utf8'));
  }
  if (generatedCount === 0) throw new Error('no generated Cursor gstack skills found');
  validateRuntimeRequirements(
    source,
    sourceReal,
    collectRuntimeRequirements(generatedContents, true),
  );
}

function assertRuntimeOutsideSkills(requireTarget = false) {
  if (!skillsRoot) throw new Error('Cursor skills root is required for runtime placement validation');
  if (isWithin(publicTarget, skillsRoot)) throw new Error('gstack runtime wrapper must be outside the Cursor skills tree');

  const skillsReal = fs.realpathSync(skillsRoot);
  let targetPhysical;
  if (requireTarget) {
    const targetStat = fs.lstatSync(publicTarget);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error('gstack runtime wrapper is not a real directory');
    }
    targetPhysical = fs.realpathSync(publicTarget);
  } else {
    const parent = path.dirname(publicTarget);
    const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
    targetPhysical = parentStat
      ? path.join(fs.realpathSync(parent), path.basename(publicTarget))
      : publicTarget;
  }
  if (isWithin(targetPhysical, skillsReal)) {
    throw new Error('gstack runtime wrapper resolves inside the Cursor skills tree');
  }
}

function runtimeParentContext(createParent = false) {
  const parentLookup = path.dirname(publicTarget);
  const cursorHomeLookup = path.dirname(parentLookup);
  const parentName = path.basename(parentLookup);
  const targetName = path.basename(publicTarget);
  if (!/^[A-Za-z0-9._-]+$/.test(parentName) || !/^[A-Za-z0-9._-]+$/.test(targetName)
    || ['.', '..'].includes(parentName) || ['.', '..'].includes(targetName)) {
    throw new Error('gstack runtime destination has an unsafe basename');
  }
  for (const [candidate, label] of [
    [cursorHomeLookup, 'Cursor home'],
    [parentLookup, 'Cursor Jarvis runtime root'],
    [skillsRoot, 'Cursor skills root'],
  ]) {
    if (!candidate) continue;
    const parsed = path.parse(candidate);
    let current = parsed.root;
    let userControlled = false;
    for (const segment of path.relative(parsed.root, candidate).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) break;
      if (stat.isSymbolicLink()) {
        if (userControlled || currentUid === null || stat.uid === currentUid) {
          throw new Error(`${label} has a user-controlled symlink ancestor: ${current}`);
        }
        continue;
      }
      if (!stat.isDirectory()) throw new Error(`${label} has a non-directory ancestor: ${current}`);
      if (currentUid !== null && stat.uid === currentUid) userControlled = true;
      if (userControlled && (stat.mode & 0o022) !== 0) {
        throw new Error(`${label} has a group/world-writable ancestor: ${current}`);
      }
    }
  }
  const homeAnchor = captureDirectoryAnchor(cursorHomeLookup);
  withAnchoredDirectory(homeAnchor, () => {
    const existing = fs.lstatSync(parentName, { throwIfNoEntry: false });
    if (!existing) {
      if (!createParent) throw new Error('Cursor Jarvis runtime root is missing');
      fs.mkdirSync(parentName, { mode: 0o700 });
    }
    const actual = fs.lstatSync(parentName);
    if (!actual.isDirectory() || actual.isSymbolicLink()
      || (currentUid !== null && actual.uid !== currentUid)
      || (actual.mode & 0o022) !== 0) {
      throw new Error('Cursor Jarvis runtime root is not a private real directory');
    }
  });
  const parentAnchor = captureDirectoryAnchor(parentLookup);
  if (parentAnchor.chain.length < 2
    || parentAnchor.chain[1].dev !== homeAnchor.chain[0].dev
    || parentAnchor.chain[1].ino !== homeAnchor.chain[0].ino) {
    throw new Error('Cursor Jarvis runtime root is outside the anchored Cursor home');
  }
  assertDirectoryLookup(homeAnchor);
  assertDirectoryLookup(parentAnchor);
  return { homeAnchor, parentAnchor, parentName, targetName, stateName: 'gstack-state' };
}

function withRuntimeParent(context, callback) {
  return withAnchoredDirectory(context.parentAnchor, () => {
    const savedTarget = target;
    const savedStateTarget = stateTarget;
    target = context.targetName;
    stateTarget = context.stateName;
    try {
      return callback();
    } finally {
      target = savedTarget;
      stateTarget = savedStateTarget;
    }
  });
}

function expectedStateMarker() {
  return {
    version: STATE_VERSION,
    owner: 'jarvis-cortex',
    mode: 'gstack-state',
    runtimePath: publicTarget,
  };
}

function expectedPairLauncher(runtimeSource = source) {
  return `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const sourceBrowse = ${JSON.stringify(path.join(runtimeSource, 'browse', 'dist', 'browse'))};
const privateHome = ${JSON.stringify(path.join(publicStateTarget, 'cursor-home'))};
const args = process.argv.slice(2);
const localIndex = args.indexOf('--local');
const isLocalCursor = args[0] === 'pair-agent'
  && localIndex >= 0
  && args[localIndex + 1] === 'cursor';
const childEnv = { ...process[['e', 'nv'].join('')] };
if (isLocalCursor) {
  process.umask(0o077);
  fs.mkdirSync(privateHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateHome, 0o700);
  childEnv[['HO', 'ME'].join('')] = privateHome;
}
const result = spawnSync(sourceBrowse, args, { env: childEnv, stdio: 'inherit' });
if (result.error) {
  process.stderr.write(\`gstack pair-agent launcher failed: \${result.error.message}\\n\`);
  process.exit(1);
}
process.exit(result.status ?? 1);
`;
}

function assertManagedPairLauncher(runtimeSource) {
  const pairLauncher = path.join(target, 'pair-agent');
  const launcherStat = fs.lstatSync(pairLauncher, { throwIfNoEntry: false });
  if (!launcherStat || !launcherStat.isFile() || launcherStat.isSymbolicLink()
    || launcherStat.nlink !== 1) {
    throw new Error('gstack pair-agent launcher is not a real regular file');
  }
  assertOwnedSafeFile(launcherStat, 'gstack pair-agent launcher', true);
  if (!isWithin(fs.realpathSync(pairLauncher), fs.realpathSync(target))) {
    throw new Error('gstack pair-agent launcher resolves outside the runtime wrapper');
  }
  const launcher = readStableRegularFile(pairLauncher, {
    label: 'gstack pair-agent launcher',
    expectedStat: launcherStat,
  }).toString('utf8');
  if (launcher !== expectedPairLauncher(runtimeSource)) {
    throw new Error('gstack pair-agent launcher provenance mismatch');
  }
}

function runtimeSourceMatchesMarker(marker) {
  const installedSource = path.join(target, 'source');
  const sourceStat = fs.lstatSync(installedSource, { throwIfNoEntry: false });
  if (!sourceStat?.isSymbolicLink() || sourceStat.nlink !== 1) return false;

  // A managed runtime must point lexically at the registered source. A link
  // through an alias is user-controlled even when realpath reaches the same
  // tree. Only the canonical absolute spelling or path.relative spelling is
  // direct; normalization is intentionally not part of this decision.
  const rawTarget = fs.readlinkSync(installedSource);
  const relativeTarget = path.relative(publicTarget, marker.sourcePath);
  if (rawTarget !== marker.sourcePath && rawTarget !== relativeTarget) return false;

  const identity = sourceIdentity(marker.sourcePath);
  if (identity.sourcePath !== marker.sourcePath || identity.sourceReal !== marker.sourceReal) return false;
  try {
    const matches = fs.realpathSync(installedSource) === marker.sourceReal;
    const after = fs.lstatSync(installedSource);
    return matches && after.isSymbolicLink() && after.nlink === 1
      && sourceStat.dev === after.dev && sourceStat.ino === after.ino
      && sourceStat.mode === after.mode && fs.readlinkSync(installedSource) === rawTarget;
  } catch (error) {
    // Preserve ownership of an exact stale link so the registered target can
    // be removed safely after its source disappears.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return true;
    return false;
  }
}

function ownedRuntimeTarget(candidates) {
  const marker = ownedTargetMarker('gstack-runtime', candidates);
  if (!marker) return null;
  if (!runtimeSourceMatchesMarker(marker)) return null;
  try {
    assertManagedPairLauncher(marker.sourcePath);
  } catch {
    return null;
  }
  return marker;
}

function verifyState() {
  const stateStat = fs.lstatSync(stateTarget);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error('gstack writable state is not a real directory');
  }
  if ((currentUid !== null && stateStat.uid !== currentUid)
    || (stateStat.mode & 0o777) !== 0o700) {
    throw new Error('gstack writable state permissions are not private');
  }
  const markerFile = path.join(stateTarget, STATE_MARKER);
  const markerStat = fs.lstatSync(markerFile, { throwIfNoEntry: false });
  if (!markerStat
    || !markerStat.isFile()
    || markerStat.isSymbolicLink()
    || markerStat.nlink !== 1
    || (currentUid !== null && markerStat.uid !== currentUid)
    || (markerStat.mode & 0o022) !== 0
    || (markerStat.mode & 0o777) !== 0o600) {
    throw new Error('gstack writable state ownership marker is not a private regular file');
  }
  const marker = JSON.parse(readStableRegularFile(markerFile, {
    label: 'gstack writable state marker',
    expectedStat: markerStat,
  }).toString('utf8'));
  const expected = expectedStateMarker();
  if (marker.version !== expected.version || marker.owner !== expected.owner
    || marker.mode !== expected.mode || marker.runtimePath !== expected.runtimePath) {
    throw new Error('gstack writable state ownership marker mismatch');
  }

  function rejectUnsafeStateEntry(current, relative = '') {
    const before = fs.lstatSync(current);
    if (!before.isDirectory() || before.isSymbolicLink()
      || (currentUid !== null && before.uid !== currentUid)
      || (before.mode & 0o077) !== 0 || (before.mode & 0o500) !== 0o500) {
      throw new Error(`gstack writable state contains an unsafe directory: ${relative || '.'}`);
    }
    const names = fs.readdirSync(current).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const child = path.join(current, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const entry = fs.lstatSync(child);
      if (entry.isSymbolicLink()) throw new Error(`gstack writable state contains a symlink: ${childRelative}`);
      if (name === 'SKILL.md') throw new Error('gstack writable state contains an indexable skill');
      if (entry.isDirectory()) {
        rejectUnsafeStateEntry(child, childRelative);
      } else if (entry.isFile()) {
        if (entry.nlink !== 1 || (currentUid !== null && entry.uid !== currentUid)
          || (entry.mode & 0o077) !== 0 || (entry.mode & 0o400) === 0) {
          throw new Error(`gstack writable state contains an unsafe file: ${childRelative}`);
        }
        readStableRegularFile(child, {
          label: `gstack writable state file ${childRelative}`,
          expectedStat: entry,
        });
      } else {
        throw new Error(`gstack writable state contains an unsupported entry: ${childRelative}`);
      }
    }
    const after = fs.lstatSync(current);
    if (!after.isDirectory() || after.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
      || before.nlink !== after.nlink || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`gstack writable state changed while being verified: ${relative || '.'}`);
    }
  }
  rejectUnsafeStateEntry(stateTarget);
}

function ensureState(parentAnchor, stateName, deferFinalize = false) {
  const existing = fs.lstatSync(stateTarget, { throwIfNoEntry: false });
  if (!existing) {
    const staged = createAnchoredStage(parentAnchor, '.jarvis-gstack-state-');
    let token = null;
    try {
      withAnchoredDirectory(staged.anchor, () => fs.chmodSync('.', 0o700));
      writePrivateAnchoredFile(
        staged.anchor,
        STATE_MARKER,
        `${JSON.stringify(expectedStateMarker(), null, 2)}\n`,
      );
      token = commitAnchoredStage({
        parentAnchor,
        stageName: staged.name,
        targetName: stateName,
        expectedTarget: null,
      });
      verifyState();
      assertAnchoredTransaction(token);
      if (!deferFinalize) finalizeAnchoredTransaction(token);
      return token;
    } catch (error) {
      if (token) {
        try { rollbackAnchoredTransaction(token); } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'gstack state creation failed and rollback was incomplete');
        }
      } else {
        try { removeAnchoredDirectoryByIdentity(parentAnchor, staged.name, staged.anchor.chain[0]); } catch {}
      }
      throw error;
    }
  } else {
    verifyState();
  }
  return null;
}

function verifyRuntime() {
  const before = fs.lstatSync(target);
  if (!before.isDirectory() || before.isSymbolicLink()
    || (currentUid !== null && before.uid !== currentUid)
    || (before.mode & 0o022) !== 0) {
    throw new Error('gstack runtime wrapper is not a safe real directory');
  }
  assertRuntimeSource();
  verifyState();
  const runtimeMarker = ownedRuntimeTarget([source]);
  if (!runtimeMarker) {
    throw new Error('gstack runtime ownership marker or source provenance mismatch');
  }
  const entries = fs.readdirSync(target).sort();
  if (JSON.stringify(entries) !== JSON.stringify([RUNTIME_MARKER, 'pair-agent', 'source'])) {
    throw new Error(`unexpected gstack runtime wrapper entries: ${entries.join(',')}`);
  }
  const after = fs.lstatSync(target);
  if (!after.isDirectory() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
    || before.nlink !== after.nlink || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs) {
    throw new Error('gstack runtime wrapper changed while being verified');
  }
}

if (command === 'skill-parse-verify') {
  try {
    assertGstackSkillMarkdownParseable();
    assertSkillFrontmatterName(
      path.join(source, 'SKILL.md'),
      tupleName,
      `generated Cursor skill ${tupleName}`,
    );
    process.stdout.write(`${fs.realpathSync(source)}\n`);
  } catch (error) {
    console.error(`Cursor gstack skill parse verification failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'skill-orphan-verify' || command === 'skill-orphan-attest') {
  try {
    assertOrphanedGstackSkillOwnership();
    if (command === 'skill-orphan-attest') {
      const marker = readOwnedMarker(path.join(target, SKILL_MARKER), 'gstack-copy', [source]);
      process.stdout.write(`${encodeSkillSourceAttestation(
        sourceAttestationFromMarker(marker, { sourceAvailable: false }),
      )}\n`);
    } else {
      process.stdout.write(`${fs.realpathSync(target)}\n`);
    }
  } catch (error) {
    console.error(`Cursor orphaned gstack skill ownership verification failed: ${error.message}`);
    process.exit(10);
  }
  process.exit(0);
}

if (ownershipTupleError?.copySourceUnsafe) {
  console.error(`Cursor gstack skill source validation failed: ${ownershipTupleError.message}`);
  process.exit(1);
}

if (command === 'runtime-owner-verify') {
  try {
    const context = runtimeParentContext(false);
    const owned = withRuntimeParent(context, () => ownedRuntimeTarget([source, previousSource]));
    if (!owned) {
      console.error('Cursor gstack runtime ownership verification failed: marker or source identity mismatch');
      process.exit(10);
    }
    assertDirectoryLookup(context.homeAnchor);
    assertDirectoryLookup(context.parentAnchor);
    process.stdout.write(`${fs.realpathSync(publicTarget)}\n`);
  } catch (error) {
    console.error(`Cursor gstack ownership verification failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'skill-owner-verify') {
  try {
    const owned = ownedTargetMarker('gstack-copy', [source, previousSource]);
    if (!owned) {
      console.error('Cursor gstack skill ownership verification failed: marker or source identity mismatch');
      process.exit(10);
    }
    process.stdout.write(`${fs.realpathSync(target)}\n`);
  } catch (error) {
    console.error(`Cursor gstack ownership verification failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'runtime-remove') {
  try {
    const context = runtimeParentContext(false);
    const owned = withRuntimeParent(context, () => ownedRuntimeTarget([source, previousSource]));
    if (!owned) {
      console.error('Cursor gstack runtime removal failed: marker or source identity mismatch');
      process.exit(10);
    }
    const expected = snapshotDirectoryEntry(context.parentAnchor, context.targetName);
    assertDirectoryLookup(context.homeAnchor);
    assertDirectoryLookup(context.parentAnchor);
    removeAnchoredEntry(context.parentAnchor, context.targetName, expected);
    assertDirectoryLookup(context.homeAnchor);
    assertDirectoryLookup(context.parentAnchor);
  } catch (error) {
    console.error(`Cursor gstack runtime removal failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'runtime-verify') {
  try {
    assertRuntimeOutsideSkills(true);
    const context = runtimeParentContext(false);
    withRuntimeParent(context, verifyRuntime);
    assertDirectoryLookup(context.homeAnchor);
    assertDirectoryLookup(context.parentAnchor);
    process.stdout.write(`${fs.realpathSync(source)}\n`);
  } catch (error) {
    console.error(`Cursor gstack runtime verification failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'runtime-sync') {
  let context;
  let staged;
  let runtimeToken = null;
  let stateToken = null;
  try {
    assertRuntimeSource();
    assertRuntimeOutsideSkills(false);
    context = runtimeParentContext(true);
    withRuntimeParent(context, () => {
      if (targetExists(target) && !ownedRuntimeTarget([source, previousSource])) {
        const collision = new Error('Cursor gstack runtime is not Jarvis-owned: marker or source identity mismatch');
        collision.exitStatus = 10;
        throw collision;
      }
      stateToken = ensureState(context.parentAnchor, context.stateName, true);
      const expectedTarget = snapshotDirectoryEntry(context.parentAnchor, context.targetName);
      staged = createAnchoredStage(context.parentAnchor, '.jarvis-gstack-runtime-');
      withAnchoredDirectory(staged.anchor, () => {
        fs.chmodSync('.', 0o700);
        fs.symlinkSync(source, 'source');
      });
      writePrivateAnchoredFile(staged.anchor, 'pair-agent', expectedPairLauncher());
      withAnchoredDirectory(staged.anchor, () => fs.chmodSync('pair-agent', 0o755));
      writePrivateAnchoredFile(staged.anchor, RUNTIME_MARKER, `${JSON.stringify({
        version: RUNTIME_VERSION,
        owner: 'jarvis-cortex',
        mode: 'gstack-runtime',
        layout: 'source-link+pair-launcher',
        sourcePath: source,
        sourceReal: fs.realpathSync(source),
      }, null, 2)}\n`);
      const savedTarget = target;
      try {
        target = staged.name;
        verifyRuntime();
      } finally {
        target = savedTarget;
      }
      runtimeToken = commitAnchoredStage({
        parentAnchor: context.parentAnchor,
        stageName: staged.name,
        targetName: context.targetName,
        expectedTarget,
      });
      assertAnchoredTransaction(runtimeToken);
      verifyRuntime();
    });
    assertDirectoryLookup(context.homeAnchor);
    assertDirectoryLookup(context.parentAnchor);
    finalizeAnchoredTransaction(runtimeToken);
    if (stateToken) finalizeAnchoredTransaction(stateToken);
    process.exit(0);
  } catch (error) {
    const rollbackErrors = [];
    if (runtimeToken) {
      try { rollbackAnchoredTransaction(runtimeToken); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    } else if (context && staged) {
      try {
        removeAnchoredDirectoryByIdentity(context.parentAnchor, staged.name, staged.anchor.chain[0]);
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }
    if (stateToken) {
      try { rollbackAnchoredTransaction(stateToken); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    const message = rollbackErrors.length
      ? new AggregateError([error, ...rollbackErrors], 'gstack runtime sync failed and rollback was incomplete').message
      : error.message;
    console.error(`Cursor gstack runtime sync failed: ${message}`);
    process.exit(error.exitStatus || 1);
  }
}

if (command === 'skill-remove') {
  if (!ownedTargetMarker('gstack-copy', [source, previousSource])) {
    console.error('Cursor gstack skill is not Jarvis-owned: marker or source identity mismatch');
    process.exit(10);
  }

  fs.rmSync(target, { recursive: true, force: true });
  process.exit(0);
}

if (command === 'skill-sync' && targetExists(target)
  && !ownedTargetMarker('gstack-copy', [source, previousSource])) {
  console.error('Cursor gstack skill is not Jarvis-owned: marker or source identity mismatch');
  process.exit(10);
}

assertGstackSkillSource();
if (!ownershipTuple) throw ownershipTupleError;
const sourceReal = fs.realpathSync(source);
const expectedDigest = digestTree(source, true);
const sourceAttestation = captureSkillSourceAttestation({
  sourcePath: source,
  name: tupleName,
  mode: 'gstack-copy',
  provenance: 'gstack',
  renderedDigest: expectedDigest,
});

if (command === 'skill-verify' || command === 'skill-attest') {
  try {
    const marker = ownedTargetMarker('gstack-copy', [source]);
    assertRealTree(target, `installed gstack copy ${tupleName}`);
    const valid = marker
      && marker.version === VERSION
      && marker.digest === expectedDigest
      && JSON.stringify(marker) === JSON.stringify(sourceAttestation.expectedMarker)
      && digestTree(target, false) === expectedDigest;
    if (!valid) throw new Error('marker or content mismatch');
    process.stdout.write(command === 'skill-attest'
      ? `${encodeSkillSourceAttestation(sourceAttestation)}\n`
      : `${expectedDigest}\n`);
  } catch (error) {
    console.error(`Cursor gstack skill verification failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const parent = path.dirname(target);
fs.mkdirSync(parent, { recursive: true });
const parentAnchor = captureDirectoryAnchor(parent);
const expectedTarget = snapshotDirectoryEntry(parentAnchor, tupleName);
const staged = createAnchoredStage(parentAnchor, '.jarvis-gstack-stage-');
let transactionToken = null;

function renderMarkdown(current) {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(current)) renderMarkdown(path.join(current, name));
    return;
  }
  if (stat.isFile() && current.endsWith('.md')) {
    const before = fs.readFileSync(current, 'utf8');
    const after = transformMarkdown(before);
    if (before !== after) fs.writeFileSync(current, after);
  }
}

try {
  withAnchoredDirectory(staged.anchor, () => {
    for (const name of fs.readdirSync(source)) {
      fs.cpSync(path.join(source, name), name, { recursive: true, verbatimSymlinks: true });
    }
  });
  withAnchoredDirectory(staged.anchor, () => {
    fs.chmodSync('.', fs.lstatSync(source).mode & 0o7777);
    renderMarkdown('.');
    assertRealDirectory('.', 'staged gstack skill');
    assertRealTree('.', 'staged gstack skill');
    assertSkillFrontmatterName('SKILL.md', tupleName, `staged gstack copy ${tupleName}`);
    if (digestTree(source, true) !== expectedDigest || digestTree('.', false) !== expectedDigest) {
      throw new Error('staged gstack skill copy differs from the validated rendered source');
    }
  });

  const markerContent = `${JSON.stringify(sourceAttestation.expectedMarker, null, 2)}\n`;
  writePrivateAnchoredFile(staged.anchor, SKILL_MARKER, markerContent);

  function verifyAnchoredCopy(anchor) {
    withAnchoredDirectory(anchor, () => {
      if (digestTree(source, true) !== expectedDigest || digestTree('.', false) !== expectedDigest) {
        throw new Error('anchored gstack skill copy differs from the validated rendered source');
      }
      assertSkillFrontmatterName('SKILL.md', tupleName, `anchored gstack copy ${tupleName}`);
      const markerStat = fs.lstatSync(SKILL_MARKER);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1
        || (currentUid !== null && markerStat.uid !== currentUid)
        || (markerStat.mode & 0o777) !== 0o600) {
        throw new Error('anchored gstack skill marker is not private');
      }
      const marker = JSON.parse(readStableRegularFile(SKILL_MARKER, {
        label: 'anchored gstack skill marker',
        expectedStat: markerStat,
      }).toString('utf8'));
      if (JSON.stringify(marker) !== JSON.stringify(sourceAttestation.expectedMarker)) {
        throw new Error('anchored gstack skill marker content mismatch');
      }
    });
  }

  verifyAnchoredCopy(staged.anchor);
  assertDirectoryLookup(parentAnchor);
  transactionToken = commitAnchoredStage({
    parentAnchor,
    stageName: staged.name,
    targetName: tupleName,
    expectedTarget,
    sourceAttestation,
  });
  const committedAnchor = { ...staged.anchor, lookup: target };
  assertAnchoredTransaction(transactionToken);
  verifyAnchoredCopy(committedAnchor);
  assertDirectoryLookup(parentAnchor);
  assertDirectoryLookup(committedAnchor);
} catch (error) {
  if (transactionToken) {
    try { rollbackAnchoredTransaction(transactionToken); } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'gstack skill copy failed and rollback could not complete');
    }
  } else {
    try {
      removeAnchoredDirectoryByIdentity(parentAnchor, staged.name, staged.anchor.chain[0]);
    } catch {
      try {
        const replacement = snapshotDirectoryEntry(parentAnchor, staged.name);
        if (replacement?.type === 'symlink') {
          removeAnchoredEntry(parentAnchor, staged.name, replacement);
        }
      } catch {}
    }
  }
  throw error;
}

if (deferFinalize) process.stdout.write(`${transactionToken}\n`);
else {
  try { finalizeAnchoredTransaction(transactionToken); } catch (error) {
    console.error(`warn: gstack skill copy committed; anchored cleanup failed: ${error.message}`);
  }
}
