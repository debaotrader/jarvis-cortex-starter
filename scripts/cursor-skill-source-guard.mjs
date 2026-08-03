#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { validateStableTreeFiles } from './cursor-tree-digest.mjs';

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

/**
 * Validate a link:* skill source without following any source-tree symlink.
 * Callers must complete this check before treating a destination link as owned.
 */
export function validateLinkSkillSource(repoRootArg, sourceArg, label = 'Cursor link skill source') {
  const repoRoot = path.resolve(repoRootArg);
  const source = path.resolve(sourceArg);
  const repoStat = fs.lstatSync(repoRoot, { throwIfNoEntry: false });
  if (!repoStat || !repoStat.isDirectory() || repoStat.isSymbolicLink()) {
    throw new Error(`${label} cortex root is not a real directory: ${repoRoot}`);
  }
  assertOwnedAndSafe(repoStat, `${label} cortex root`, repoRoot);

  const repoReal = fs.realpathSync(repoRoot);
  if (!isWithin(source, repoRoot)) {
    throw new Error(`${label} is outside the cortex root: ${source}`);
  }

  let current = repoRoot;
  const segments = path.relative(repoRoot, source).split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`${label} cannot be the cortex root: ${source}`);
  }
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new Error(`${label} path component is missing: ${current}`);
    if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`${label} path component is not a real directory: ${current}`);
    assertOwnedAndSafe(stat, `${label} path component`, current);
    const currentReal = fs.realpathSync(current);
    if (!isWithin(currentReal, repoReal)) {
      throw new Error(`${label} path escapes the cortex root: ${current}`);
    }
  }

  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${source}`);
  }

  const skillFile = path.join(source, 'SKILL.md');
  const skillStat = fs.lstatSync(skillFile, { throwIfNoEntry: false });
  if (!skillStat) throw new Error(`${label} SKILL.md is missing: ${skillFile}`);
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new Error(`${label} SKILL.md is not a real regular file: ${skillFile}`);
  }
  assertOwnedAndSafe(skillStat, `${label} SKILL.md`, skillFile);
  const skillReal = fs.realpathSync(skillFile);
  const sourceReal = fs.realpathSync(source);
  if (!isWithin(sourceReal, repoReal) || !isWithin(skillReal, sourceReal)) {
    throw new Error(`${label} SKILL.md escapes its trusted source: ${skillFile}`);
  }
  validateStableTreeFiles(source, {
    label,
    validateEntry({ stat, absolute }) {
      assertOwnedAndSafe(stat, `${label} tree entry`, absolute);
    },
  });
  return sourceReal;
}
