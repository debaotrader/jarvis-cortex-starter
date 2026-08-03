#!/usr/bin/env node

'use strict';

import { TextDecoder } from 'node:util';
import { readStableRegularFile } from './cursor-tree-digest.mjs';

function quotedSuffixIsComment(suffix) {
  return /^[ \t]*(?:#.*)?$/.test(suffix);
}

function asciiTrimLeft(value) {
  return value.replace(/^ */, '');
}

function asciiTrim(value) {
  return value.replace(/^ */, '').replace(/ *$/, '');
}

function isAsciiBlank(value) {
  return /^[ ]*$/.test(value);
}

function isAsciiBlankOrComment(value) {
  const content = asciiTrimLeft(value);
  return content === '' || content.startsWith('#');
}

function parseSingleQuotedScalar(raw) {
  let value = '';
  for (let index = 1; index < raw.length; index += 1) {
    if (raw[index] !== "'") {
      value += raw[index];
      continue;
    }
    if (raw[index + 1] === "'") {
      value += "'";
      index += 1;
      continue;
    }
    return quotedSuffixIsComment(raw.slice(index + 1)) ? value : null;
  }
  return null;
}

function parseDoubleQuotedScalar(raw) {
  const simpleEscapes = new Map([
    ['0', '\0'], ['a', '\x07'], ['b', '\b'], ['t', '\t'], ['n', '\n'],
    ['v', '\v'], ['f', '\f'], ['r', '\r'], ['e', '\x1b'], [' ', ' '],
    ['"', '"'], ['/', '/'], ['\\', '\\'], ['_', '\u00a0'], ['N', '\u0085'],
    ['L', '\u2028'], ['P', '\u2029'],
  ]);
  let value = '';
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"') {
      return quotedSuffixIsComment(raw.slice(index + 1)) ? value : null;
    }
    if (character !== '\\') {
      value += character;
      continue;
    }
    const escaped = raw[index += 1];
    if (escaped === undefined) return null;
    if (simpleEscapes.has(escaped)) {
      value += simpleEscapes.get(escaped);
      continue;
    }
    const widths = new Map([['x', 2], ['u', 4], ['U', 8]]);
    const width = widths.get(escaped);
    if (!width) return null;
    const hex = raw.slice(index + 1, index + 1 + width);
    if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
    try {
      value += String.fromCodePoint(codePoint);
    } catch {
      return null;
    }
    index += width;
  }
  return null;
}

function parsePlainScalar(raw) {
  const value = asciiTrim(raw);
  if (!value) return { value: '' };

  // This auditor deliberately implements only block-context plain scalars.
  // Unsupported YAML syntax must fail closed instead of being normalized into
  // a different value by trimming comments or accepting indicator prefixes.
  if (/^[,\[\]{}#&*!|>'"%@`]/.test(value)
    || /^[-?:](?:[ \t]|$)/.test(value)
    || /:(?:[ \t]|$)/.test(value)
    || /(?:^|[ \t])#/.test(value)) {
    return { error: 'plain scalar uses unsupported YAML indicator, mapping separation, or comment syntax' };
  }
  return { value };
}

function isYamlCoreImplicitNonString(value) {
  const nullOrBoolean = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE)$/;
  const integer = /^[-+]?(?:[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;
  const finiteFloat = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
  const infinity = /^[-+]?\.(?:inf|Inf|INF)$/;
  const notANumber = /^\.(?:nan|NaN|NAN)$/;
  return nullOrBoolean.test(value) || integer.test(value) || finiteFloat.test(value)
    || infinity.test(value) || notANumber.test(value);
}

function parseYamlNameScalar(raw) {
  const value = asciiTrimLeft(raw);
  if (!value) return { error: 'empty name scalar' };
  if (/^[&*!|>\[{@`]/.test(value) || value.startsWith('? ')) {
    return { error: 'anchors, aliases, tags, block scalars, and flow scalars are unsupported for name' };
  }
  if (value.startsWith("'")) {
    const parsed = parseSingleQuotedScalar(value);
    return parsed === null || !parsed || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(parsed)
      ? { error: 'invalid or multiline single-quoted name scalar' }
      : { value: parsed };
  }
  if (value.startsWith('"')) {
    const parsed = parseDoubleQuotedScalar(value);
    return parsed === null || !parsed || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(parsed)
      ? { error: 'invalid or multiline double-quoted name scalar' }
      : { value: parsed };
  }
  const parsed = parsePlainScalar(value);
  if (parsed.error || !parsed.value) {
    return { error: 'plain name scalar is outside the supported [A-Za-z0-9._#-]+ subset' };
  }
  if (isYamlCoreImplicitNonString(parsed.value)) {
    return { error: 'implicit non-string YAML scalars are unsupported for name' };
  }
  if (!/^[A-Za-z0-9._#-]+$/.test(parsed.value)) {
    return { error: 'plain name scalar is outside the supported [A-Za-z0-9._#-]+ subset' };
  }
  return { value: parsed.value };
}

function metadataError(relative, code, message) {
  return { error: { path: relative, code, message } };
}

function isValidYamlCharacter(codePoint) {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
    || (codePoint >= 0x20 && codePoint <= 0x7e)
    || codePoint === 0x85
    || (codePoint >= 0xa0 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function validateYamlCharacters(text) {
  for (const character of text) {
    if (!isValidYamlCharacter(character.codePointAt(0))) return false;
  }
  return true;
}

function blockHeader(raw) {
  const value = asciiTrimLeft(raw);
  if (!/^[|>]/.test(value)) return null;
  const match = value.match(/^([|>])((?:[+-][1-9]?|[1-9][+-]?)?)(?:[ ]+(?:#.*)?)?$/);
  if (!match) return { error: 'invalid block scalar chomping or indentation indicator' };
  const indicator = match[2];
  const digit = indicator.match(/[1-9]/)?.[0];
  return { indent: digit ? Number.parseInt(digit, 10) : null };
}

function validateGeneralScalar(raw) {
  const value = asciiTrimLeft(raw);
  if (!value || value.startsWith('#')) return { value: '' };
  if (/^[&*!\[{@`]/.test(value) || value.startsWith('? ')) {
    return { error: 'anchors, aliases, tags, and flow collections are outside the frontmatter subset' };
  }
  if (value.startsWith("'")) {
    const parsed = parseSingleQuotedScalar(value);
    return parsed === null || !validateYamlCharacters(parsed)
      ? { error: 'invalid single-quoted scalar' }
      : { value: parsed };
  }
  if (value.startsWith('"')) {
    const parsed = parseDoubleQuotedScalar(value);
    return parsed === null || !validateYamlCharacters(parsed)
      ? { error: 'invalid double-quoted scalar or Unicode escape' }
      : { value: parsed };
  }
  const parsed = parsePlainScalar(value);
  if (parsed.error) return parsed;
  return validateYamlCharacters(parsed.value)
    ? parsed
    : { error: 'plain scalar contains an invalid Unicode character' };
}

export function parseSkillFrontmatterName(file, relative) {
  let bytes;
  try {
    bytes = readStableRegularFile(file, { label: `SKILL.md ${relative}` });
  } catch (error) {
    return metadataError(relative, 'unsafe-regular-file', error.message);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return metadataError(relative, 'invalid-unicode', 'SKILL.md is not valid UTF-8');
  }
  const frontmatter = text.match(/^---[ ]*\r?\n([\s\S]*?)\r?\n---[ ]*(?:\r?\n|$)/);
  if (!frontmatter) {
    return metadataError(relative, 'missing-frontmatter', 'SKILL.md has no supported YAML frontmatter');
  }
  if (!validateYamlCharacters(frontmatter[1])) {
    return metadataError(relative, 'invalid-unicode', 'frontmatter contains a character disallowed by YAML');
  }
  const lines = frontmatter[1].split(/\r?\n/);
  if (lines.some((line) => line.includes('\t'))) {
    return metadataError(relative, 'unsupported-yaml-structure', 'tabs are unsupported in frontmatter indentation or scalar bodies');
  }

  const indentation = (line) => line.match(/^ */)[0].length;
  const ignorable = (line) => isAsciiBlankOrComment(line);
  const nextContent = (start) => {
    let index = start;
    while (index < lines.length && ignorable(lines[index])) index += 1;
    return index;
  };
  let found = null;
  let failure = null;

  const fail = (code, message) => {
    if (!failure) failure = metadataError(relative, code, message);
  };

  const consumeBlock = (lineIndex, parentIndent, header) => {
    if (header.error) {
      fail('invalid-block-scalar', header.error);
      return lines.length;
    }
    const requiredExplicit = header.indent === null ? null : parentIndent + header.indent;
    let required = requiredExplicit;
    let index = lineIndex + 1;
    while (index < lines.length) {
      const line = lines[index];
      if (isAsciiBlank(line)) {
        index += 1;
        continue;
      }
      const currentIndent = indentation(line);
      if (currentIndent <= parentIndent) break;
      if (required === null) required = currentIndent;
      if (currentIndent < required) {
        fail('invalid-block-scalar', `block scalar body indentation ${currentIndent} is below required ${required}`);
        return lines.length;
      }
      index += 1;
    }
    return index;
  };

  const parseEntry = (content, lineIndex, mapIndent, depth, seen) => {
    if (/^(?:["']name["']|\?+[ ]+["']?name["']?)[ ]*:?[ ]*/.test(content)
      || (/^[&!*]/.test(content) && /(?:^|[ ])name[ ]*:/.test(content))
      || /[\[{,][ ]*["']name["'][ ]*:/.test(content)) {
      fail('unsupported-name-key', 'quoted, complex, tagged, anchored, or flow name keys are unsupported');
      return lines.length;
    }
    const entry = content.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:$|[ ]+(.*))$/);
    if (!entry) {
      fail('unsupported-yaml-structure',
        'frontmatter mapping keys require no space before colon and ASCII-space separation after colon');
      return lines.length;
    }
    const key = entry[1];
    const rawValue = entry[2] ?? '';
    if (seen.has(key)) {
      fail(key === 'name' ? 'duplicate-name-key' : 'duplicate-key', `frontmatter mapping has duplicate key: ${key}`);
      return lines.length;
    }
    seen.add(key);
    if (key === 'name') {
      if (depth !== 0) {
        fail('unsupported-yaml-structure', 'name is only supported as a top-level plain mapping key');
        return lines.length;
      }
      found = rawValue;
    }

    const header = blockHeader(rawValue);
    if (header) return consumeBlock(lineIndex, mapIndent, header);
    if (isAsciiBlankOrComment(rawValue)) {
      const childIndex = nextContent(lineIndex + 1);
      if (childIndex < lines.length && indentation(lines[childIndex]) > mapIndent) {
        return parseNode(childIndex, indentation(lines[childIndex]), depth + 1);
      }
      return lineIndex + 1;
    }
    const scalar = validateGeneralScalar(rawValue);
    if (scalar.error) {
      fail('unsupported-yaml-structure', scalar.error);
      return lines.length;
    }
    return lineIndex + 1;
  };

  const parseMapping = (start, indent, depth, initial = null) => {
    const seen = initial?.seen || new Set();
    let index = start;
    if (initial) index = parseEntry(initial.content, initial.lineIndex, indent, depth, seen);
    while (!failure) {
      index = nextContent(index);
      if (index >= lines.length) return index;
      const currentIndent = indentation(lines[index]);
      if (currentIndent < indent) return index;
      if (currentIndent > indent) {
        fail('unsupported-yaml-structure', `unexpected indentation ${currentIndent}; expected ${indent}`);
        return lines.length;
      }
      if (/^-(?:[ ]|$)/.test(lines[index].slice(indent))) return index;
      index = parseEntry(lines[index].slice(indent), index, indent, depth, seen);
    }
    return lines.length;
  };

  const parseSequence = (start, indent, depth) => {
    let index = start;
    while (!failure) {
      index = nextContent(index);
      if (index >= lines.length) return index;
      const currentIndent = indentation(lines[index]);
      if (currentIndent < indent) return index;
      if (currentIndent > indent) {
        fail('unsupported-yaml-structure', `unexpected sequence indentation ${currentIndent}; expected ${indent}`);
        return lines.length;
      }
      const sequence = lines[index].slice(indent).match(/^-(?:[ ]+(.*))?$/);
      if (!sequence) return index;
      const item = sequence[1] ?? '';
      if (isAsciiBlankOrComment(item)) {
        const childIndex = nextContent(index + 1);
        if (childIndex < lines.length && indentation(lines[childIndex]) > indent) {
          index = parseNode(childIndex, indentation(lines[childIndex]), depth + 1);
        } else {
          index += 1;
        }
        continue;
      }
      if (/^[A-Za-z][A-Za-z0-9_-]*:(?:$|[ ]+)/.test(item)) {
        index = parseMapping(index + 1, indent + 2, depth + 1, {
          content: item,
          lineIndex: index,
          seen: new Set(),
        });
        continue;
      }
      const scalar = validateGeneralScalar(item);
      if (scalar.error) {
        fail('unsupported-yaml-structure', scalar.error);
        return lines.length;
      }
      index += 1;
    }
    return lines.length;
  };

  function parseNode(start, indent, depth) {
    const index = nextContent(start);
    if (index >= lines.length) return index;
    return /^-(?:[ ]|$)/.test(lines[index].slice(indent))
      ? parseSequence(index, indent, depth)
      : parseMapping(index, indent, depth);
  }

  const start = nextContent(0);
  if (start < lines.length) {
    if (indentation(lines[start]) !== 0) {
      fail('unsupported-yaml-structure', 'top-level frontmatter keys must start at column zero');
    } else {
      const end = parseMapping(start, 0, 0);
      const remaining = nextContent(end);
      if (!failure && remaining < lines.length) {
        fail('unsupported-yaml-structure', 'frontmatter contains an unsupported mixed mapping/sequence structure');
      }
    }
  }
  if (failure) return failure;
  if (found === null) {
    return metadataError(relative, 'missing-name-key', 'frontmatter has no supported top-level plain name key');
  }
  const parsed = parseYamlNameScalar(found);
  if (parsed.error) {
    return metadataError(relative, 'unsupported-name-scalar', parsed.error);
  }
  return { name: parsed.value };
}

export function assertSkillFrontmatterName(file, expectedName, label = 'Cursor skill') {
  const parsed = parseSkillFrontmatterName(file, file);
  if (parsed.error) {
    const { code, message } = parsed.error;
    throw new Error(`${label} frontmatter is invalid (${code}): ${message}`);
  }
  if (parsed.name !== expectedName) {
    throw new Error(`${label} frontmatter name mismatch: expected ${expectedName}, got ${parsed.name}`);
  }
  return parsed.name;
}
