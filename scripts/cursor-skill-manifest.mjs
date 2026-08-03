#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCursorSkillCatalog } from './cursor-skill-catalog.mjs';
import { assertSkillFrontmatterName } from './cursor-skill-frontmatter.mjs';
import { validateLinkSkillSource } from './cursor-skill-source-guard.mjs';

const [repoArg, gstackArg] = process.argv.slice(2);
if (!repoArg || !gstackArg) {
  console.error('usage: cursor-skill-manifest.mjs <repo-root> <gstack-repo-root>');
  process.exit(2);
}

function canonicalPath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return resolved;
    throw error;
  }
}

// The shared catalog emits physical cortex paths and the exact configured
// gstack root. Manifest generation and stale ownership cannot drift.
const repoRoot = canonicalPath(repoArg);
const rows = buildCursorSkillCatalog(repoRoot, gstackArg);
const gstackTool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cursor-gstack-install.mjs');

function validateSource({ name, source, mode, provenance, required }) {
  const skillFile = path.join(source, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    if (required) throw new Error(`required Cursor skill source missing: ${skillFile}`);
    return false;
  }
  assertSkillFrontmatterName(skillFile, name, `Cursor manifest source ${name}`);
  if (mode === 'gstack-copy' && provenance === 'gstack') {
    const parsed = spawnSync(process.execPath, [gstackTool, 'skill-parse-verify', source, name], {
      encoding: 'utf8',
    });
    if (parsed.status !== 0) {
      throw new Error(`invalid generated Cursor skill ${name}: ${parsed.stderr.trim() || `exit ${parsed.status}`}`);
    }
  }
  return true;
}

const seen = new Set();
const errors = [];
const desiredRows = [];
for (const row of rows) {
  if (!validateSource(row)) continue;
  if (!/^[A-Za-z0-9._-]+$/.test(row.name)) errors.push(`invalid Cursor skill name: ${row.name}`);
  if (seen.has(row.name)) errors.push(`duplicate Cursor manifest name: ${row.name}`);
  if ([row.source, row.mode, row.provenance].some((value) => /[\t\r\n]/.test(value))) {
    errors.push(`invalid tab or newline in Cursor manifest row: ${row.name}`);
  }
  if (row.mode === 'link') {
    try {
      validateLinkSkillSource(repoRoot, row.source, `Cursor link skill ${row.name}`);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (row.mode === 'cursor-copy' && row.provenance === 'cortex') {
    // Copy sources are recursively consumed later. Validate the complete
    // canonical tree while manifest generation is still read-only so an
    // unsafe existing source (symlink, hardlink, FIFO, or unsafe mode) cannot
    // be misreported as an unrelated stale-tuple mismatch after reconciliation
    // starts. Collect the diagnostic with link-source errors to retain the
    // catalog's deterministic ordering and atomic stdout.
    try {
      validateLinkSkillSource(
        repoRoot,
        row.source,
        `Cursor copy manifest source ${row.name}`,
      );
    } catch (error) {
      errors.push(error.message);
    }
  }
  seen.add(row.name);
  desiredRows.push(row);
}
if (errors.length > 0) throw new Error(errors.join('; '));

const output = desiredRows
  .map((row) => [row.name, row.source, row.mode, row.provenance].join('\t'))
  .join('\n');
if (output) process.stdout.write(`${output}\n`);
