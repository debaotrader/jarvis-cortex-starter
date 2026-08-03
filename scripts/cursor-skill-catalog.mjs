#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import {
  assertSkillFrontmatterName,
  parseSkillFrontmatterName,
} from './cursor-skill-frontmatter.mjs';

const PROMOTED_LINKS = Object.freeze([
  'dead-code-audit',
  'loop-hermes',
  'orchestrate',
  'security-audit',
  'strategic-compact',
  'verification-loop',
  'jarvis-learn',
]);

const CAVEMAN_LINKS = Object.freeze([
  'cavecrew',
  'caveman',
  'caveman-commit',
  'caveman-compress',
  'caveman-help',
  'caveman-review',
  'caveman-stats',
]);

// A removed link is prunable only while its exact historical identity remains
// here. Never infer tombstones from active/skills, a manifest row, or a broad
// namespace: add one deliberately in the same change that removes a managed
// link. `learn` was renamed to `jarvis-learn` to avoid the external skill name.
const LINK_TOMBSTONES = Object.freeze([
  Object.freeze({
    name: 'learn',
    relativeSource: Object.freeze(['active', 'skills', 'learn']),
    mode: 'link',
    provenance: 'cortex',
    reason: 'renamed to jarvis-learn',
  }),
]);

function canonicalPath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return resolved;
    throw error;
  }
}

function add(rows, name, source, mode, provenance, required = true, tombstone = false) {
  rows.push(Object.freeze({ name, source, mode, provenance, required, tombstone }));
}

function validateCatalog(rows, uniqueNames) {
  const seenNames = new Set();
  const seenTuples = new Set();
  const validOwnership = new Set([
    'link:cortex',
    'link:hm',
    'link:caveman',
    'cursor-copy:cortex',
    'gstack-copy:gstack',
  ]);
  for (const row of rows) {
    if (!/^[A-Za-z0-9._-]+$/.test(row.name) || row.name === '.' || row.name === '..') {
      throw new Error(`invalid Cursor skill name: ${row.name || '<empty>'}`);
    }
    const tuple = `${row.name}\0${row.source}\0${row.mode}\0${row.provenance}`;
    if (seenTuples.has(tuple)) throw new Error(`duplicate Cursor skill catalog tuple: ${row.name}`);
    if (uniqueNames && seenNames.has(row.name)) {
      throw new Error(`duplicate Cursor skill catalog name: ${row.name}`);
    }
    if (!path.isAbsolute(row.source) || path.normalize(row.source) !== row.source) {
      throw new Error(`non-canonical Cursor skill catalog source: ${row.name}`);
    }
    if (!validOwnership.has(`${row.mode}:${row.provenance}`)) {
      throw new Error(`invalid Cursor skill catalog ownership: ${row.name}`);
    }
    if (!row.tombstone) {
      const skillFile = path.join(row.source, 'SKILL.md');
      const skillStat = fs.lstatSync(skillFile, { throwIfNoEntry: false });
      if (!skillStat) {
        if (row.required || fs.lstatSync(row.source, { throwIfNoEntry: false })) {
          throw new Error(`Cursor skill catalog source is missing SKILL.md: ${row.name}`);
        }
      } else {
        if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
          throw new Error(`Cursor skill catalog SKILL.md is not a real regular file: ${row.name}`);
        }
        assertSkillFrontmatterName(skillFile, row.name, `Cursor skill catalog ${row.name}`);
      }
    }
    seenNames.add(row.name);
    seenTuples.add(tuple);
  }
}

/**
 * Return the single canonical Cursor skill catalog used by both manifest
 * generation and stale-link ownership checks. Tombstones never enter the
 * desired manifest; they only preserve an exact, reviewable removal path.
 */
export function buildCursorSkillCatalog(repoRootArg, gstackRootArg, options = {}) {
  const repoRoot = canonicalPath(repoRootArg);
  const gstackRoot = gstackRootArg ? canonicalPath(gstackRootArg) : null;
  const active = [];

  for (const name of PROMOTED_LINKS) {
    add(active, name, path.join(repoRoot, 'active', 'skills', name), 'link', 'cortex');
  }
  add(
    active,
    'impeccable',
    path.join(repoRoot, 'active', 'skills', 'impeccable'),
    'cursor-copy',
    'cortex',
  );
  add(
    active,
    'jarvis-cortex',
    path.join(repoRoot, 'codex', 'skill-source', 'jarvis-cortex'),
    'link',
    'cortex',
  );

  const hmRoot = path.join(repoRoot, 'codex', 'skills-local');
  for (const name of fs.readdirSync(hmRoot).filter((entry) => entry.startsWith('hm-')).sort()) {
    add(active, name, path.join(hmRoot, name), 'link', 'hm');
  }

  for (const name of CAVEMAN_LINKS) {
    add(active, name, path.join(repoRoot, 'codex', 'agent-skills', name), 'link', 'caveman');
  }

  if (gstackRoot) {
    const gstackSkills = path.join(gstackRoot, '.cursor', 'skills');
    if (fs.existsSync(gstackSkills)) {
      for (const sourceName of fs.readdirSync(gstackSkills).filter((entry) => /^gstack(?:-|$)/.test(entry)).sort()) {
        const source = path.join(gstackSkills, sourceName);
        const parsed = parseSkillFrontmatterName(
          path.join(source, 'SKILL.md'),
          `${sourceName}/SKILL.md`,
        );
        if (parsed.error) {
          throw new Error(
            `invalid gstack Cursor catalog frontmatter ${sourceName}: `
            + `${parsed.error.code}: ${parsed.error.message}`,
          );
        }
        add(active, parsed.name, source, 'gstack-copy', 'gstack', false);
      }
    }
  }

  const tombstones = LINK_TOMBSTONES.map((entry) => Object.freeze({
    name: entry.name,
    source: path.join(repoRoot, ...entry.relativeSource),
    mode: entry.mode,
    provenance: entry.provenance,
    required: false,
    tombstone: true,
    reason: entry.reason,
  }));
  // Desired rows are unique by name because the manifest is keyed by name.
  // Historical rows are a separate exact-tuple namespace: a removed Cortex
  // link may legitimately share its name with a current third-party skill.
  validateCatalog(active, true);
  validateCatalog(tombstones, false);
  const rows = options.includeTombstones ? [...active, ...tombstones] : active;
  return Object.freeze(rows);
}
