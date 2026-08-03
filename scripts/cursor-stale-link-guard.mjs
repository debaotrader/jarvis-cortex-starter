#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawLinkTargetIsExact } from './cursor-link-target.mjs';
import { buildCursorSkillCatalog } from './cursor-skill-catalog.mjs';
import { validateLinkSkillSource } from './cursor-skill-source-guard.mjs';

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertOwnedAndSafe(stat, label, candidate) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user: ${candidate}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} is group/world-writable: ${candidate}`);
  }
}

function staleSourceSafetyError(error) {
  error.staleSourceUnsafe = true;
  return error;
}

/**
 * Prove ownership of a dangling stale link without resolving its absent source.
 * This is intentionally narrower than normal link ownership: only an exact
 * active catalog/tombstone tuple and exact stored symlink spelling are accepted.
 */
export function validateStaleLink(
  repoRootArg,
  name,
  source,
  modeArg,
  provenanceArg,
  targetArg,
  gstackRootArg = null,
) {
  // Compatibility with the original five-argument API: mode was implicitly
  // `link`. New callers pass it explicitly so mode drift is reviewable.
  const legacyCall = targetArg === undefined;
  const mode = legacyCall ? 'link' : modeArg;
  const provenance = legacyCall ? modeArg : provenanceArg;
  const target = legacyCall ? provenanceArg : targetArg;
  const gstackRoot = legacyCall ? null : gstackRootArg;
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid stale Cursor link name: ${name || '<empty>'}`);
  }
  if (!path.isAbsolute(source) || path.normalize(source) !== source) {
    throw new Error(`stale Cursor link source is not canonical absolute: ${source}`);
  }

  const repoRoot = path.resolve(repoRootArg);
  const repoStat = fs.lstatSync(repoRoot, { throwIfNoEntry: false });
  if (!repoStat || !repoStat.isDirectory() || repoStat.isSymbolicLink()) {
    throw new Error(`stale Cursor link cortex root is not a real directory: ${repoRoot}`);
  }
  assertOwnedAndSafe(repoStat, 'stale Cursor link cortex root', repoRoot);
  const repoReal = fs.realpathSync(repoRoot);
  let catalog;
  try {
    catalog = buildCursorSkillCatalog(repoReal, gstackRoot, { includeTombstones: true });
  } catch (error) {
    // Catalog construction now validates every immediate SKILL.md identity.
    // Treat any failure here as source-namespace corruption so bootstrap
    // cannot downgrade it to an ordinary stale collision.
    throw staleSourceSafetyError(error);
  }
  const expected = catalog.find((entry) => entry.name === name
    && entry.source === source
    && entry.mode === mode
    && entry.provenance === provenance);
  if (!expected) {
    throw new Error(
      `stale Cursor link exact tuple is absent from the canonical catalog/tombstones: ${name}`,
    );
  }
  if (expected.mode !== 'link') {
    throw new Error(`stale Cursor catalog entry is not link-managed: ${name}`);
  }
  if (path.basename(target) !== name) {
    throw new Error(`stale Cursor link target basename does not match manifest name: ${target}`);
  }

  const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
  let sourceReal = null;
  if (sourceStat) {
    try {
      sourceReal = validateLinkSkillSource(repoReal, source, `Cursor stale link source ${name}`);
    } catch (error) {
      throw staleSourceSafetyError(error);
    }
  } else {
    let current = repoReal;
    let missingAncestor = false;
    for (const segment of path.relative(repoReal, path.dirname(source)).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) {
        missingAncestor = true;
        continue;
      }
      if (missingAncestor) {
        throw staleSourceSafetyError(
          new Error(`stale Cursor link has an existing child below a missing source ancestor: ${current}`),
        );
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw staleSourceSafetyError(
          new Error(`stale Cursor link source namespace contains a non-directory or symlink: ${current}`),
        );
      }
      try {
        assertOwnedAndSafe(stat, 'stale Cursor link source namespace', current);
      } catch (error) {
        throw staleSourceSafetyError(error);
      }
      if (!isWithin(fs.realpathSync(current), repoReal)) {
        throw staleSourceSafetyError(
          new Error(`stale Cursor link source namespace escapes the cortex root: ${current}`),
        );
      }
    }
  }

  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!targetStat?.isSymbolicLink() || !rawLinkTargetIsExact(target, source)) {
    throw new Error(`stale Cursor link target does not store its exact prior source: ${target}`);
  }
  if (sourceReal !== null && fs.realpathSync(target) !== sourceReal) {
    throw new Error(`stale Cursor link target resolves outside its prior source: ${target}`);
  }
  return true;
}

// Compatibility export for callers/tests from the first stale-link repair.
export const validateMissingStaleLink = validateStaleLink;

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
let invokedDirectly = false;
try {
  invokedDirectly = fs.realpathSync(invokedPath) === fs.realpathSync(modulePath);
} catch {
  invokedDirectly = invokedPath === modulePath;
}
if (invokedDirectly) {
  const [command, repoRoot, gstackRoot, name, source, mode, provenance, target] = process.argv.slice(2);
  if (command !== 'verify' || !repoRoot || !gstackRoot || !name || !source || !mode || !provenance || !target) {
    console.error('usage: cursor-stale-link-guard.mjs verify <repo-root> <gstack-root> <name> <source> <mode> <provenance> <target>');
    process.exit(2);
  }
  try {
    validateStaleLink(repoRoot, name, source, mode, provenance, target, gstackRoot);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
