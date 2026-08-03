#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawLinkTargetIsExact } from './cursor-link-target.mjs';
import { buildCursorSkillCatalog } from './cursor-skill-catalog.mjs';
import { validateLinkSkillSource } from './cursor-skill-source-guard.mjs';
import { readStableRegularFile } from './cursor-tree-digest.mjs';

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

export function validateCortexCheckoutIdentity(checkoutRoot) {
  const rootStat = fs.lstatSync(checkoutRoot, { throwIfNoEntry: false });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`previous Cursor link checkout is not a real directory: ${checkoutRoot}`);
  }
  assertOwnedAndSafe(rootStat, 'previous Cursor link checkout', checkoutRoot);
  const rootReal = fs.realpathSync(checkoutRoot);
  if (rootReal !== checkoutRoot) {
    throw new Error(`previous Cursor link checkout is not canonical: ${checkoutRoot}`);
  }

  for (const filename of ['JARVIS.md', 'BOOT.md']) {
    const candidate = path.join(checkoutRoot, filename);
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`previous Cursor link checkout identity is missing or unsafe: ${candidate}`);
    }
    assertOwnedAndSafe(stat, 'previous Cursor link checkout identity', candidate);
    readStableRegularFile(candidate, {
      label: 'previous Cursor link checkout identity',
      expectedStat: stat,
    });
    if (!isWithin(fs.realpathSync(candidate), rootReal)) {
      throw new Error(`previous Cursor link checkout identity escapes its root: ${candidate}`);
    }
  }
  return rootReal;
}

export function validateCortexCatalogSource(repoRootArg, expectedSourceArg, candidateSourceArg, name) {
  const repoRoot = fs.realpathSync(path.resolve(repoRootArg));
  const expectedSource = path.resolve(expectedSourceArg);
  const candidateSource = path.resolve(candidateSourceArg);
  const relativeSource = path.relative(repoRoot, expectedSource);
  if (!relativeSource
    || relativeSource === '..'
    || relativeSource.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeSource)) {
    throw new Error(`active Cursor source is not catalog-relative: ${name}`);
  }
  const segments = relativeSource.split(path.sep).filter(Boolean);
  let candidateRoot = candidateSource;
  for (const _segment of segments) candidateRoot = path.dirname(candidateRoot);
  if (path.join(candidateRoot, ...segments) !== candidateSource) {
    throw new Error(`previous Cursor source is not the exact catalog-relative source: ${candidateSource}`);
  }
  try {
    const candidateRootReal = validateCortexCheckoutIdentity(candidateRoot);
    return validateLinkSkillSource(
      candidateRootReal,
      candidateSource,
      `previous Cursor source ${name}`,
    );
  } catch (error) {
    error.copySourceUnsafe = true;
    throw error;
  }
}

/**
 * Authorize repointing a link from a previous physical Jarvis checkout.
 *
 * A manifest row is not ownership proof by itself. The desired tuple must be
 * the exact active catalog row; the recorded mode/provenance must still match;
 * and the recorded source must be the same catalog-relative source in a real,
 * safe Jarvis checkout that still exists. This deliberately rejects dangling
 * relocation records and same-mode/name substitutions such as hm-init pointing
 * at hm-deploy.
 */
export function validatePreviousLinkOwnership(
  repoRootArg,
  gstackRootArg,
  name,
  previousSourceArg,
  previousMode,
  previousProvenance,
  targetArg,
  desiredSourceArg,
  desiredMode,
  desiredProvenance,
) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid previous Cursor link name: ${name || '<empty>'}`);
  }
  const repoRoot = fs.realpathSync(path.resolve(repoRootArg));
  const gstackRoot = gstackRootArg ? path.resolve(gstackRootArg) : null;
  const desiredSource = path.resolve(desiredSourceArg);
  const previousSource = path.resolve(previousSourceArg);
  const target = path.resolve(targetArg);
  if (!path.isAbsolute(previousSourceArg) || path.normalize(previousSourceArg) !== previousSourceArg) {
    throw new Error(`previous Cursor link source is not canonical absolute: ${previousSourceArg}`);
  }

  const expected = buildCursorSkillCatalog(repoRoot, gstackRoot)
    .find((entry) => entry.name === name);
  if (!expected || expected.tombstone || expected.mode !== 'link') {
    throw new Error(`previous Cursor link is not an active link catalog entry: ${name}`);
  }
  if (expected.source !== desiredSource
    || expected.mode !== desiredMode
    || expected.provenance !== desiredProvenance) {
    throw new Error(`desired Cursor link tuple does not match the active catalog: ${name}`);
  }
  if (previousMode !== expected.mode || previousProvenance !== expected.provenance) {
    throw new Error(
      `previous Cursor link ownership does not match the active catalog: ${name} `
      + `(recorded ${previousMode}:${previousProvenance}, canonical ${expected.mode}:${expected.provenance})`,
    );
  }
  if (path.basename(target) !== name) {
    throw new Error(`previous Cursor link target basename does not match its name: ${target}`);
  }

  const previousSourceReal = validateCortexCatalogSource(
    repoRoot,
    expected.source,
    previousSource,
    name,
  );
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!targetStat?.isSymbolicLink() || !rawLinkTargetIsExact(target, previousSource)) {
    throw new Error(`previous Cursor link target does not store its exact source: ${target}`);
  }
  if (fs.realpathSync(target) !== previousSourceReal) {
    throw new Error(`previous Cursor link target resolves outside its recorded source: ${target}`);
  }
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
let invokedDirectly = false;
try {
  invokedDirectly = fs.realpathSync(invokedPath) === fs.realpathSync(modulePath);
} catch {
  invokedDirectly = invokedPath === modulePath;
}
if (invokedDirectly) {
  const [
    command,
    repoRoot,
    gstackRoot,
    name,
    previousSource,
    previousMode,
    previousProvenance,
    target,
    desiredSource,
    desiredMode,
    desiredProvenance,
  ] = process.argv.slice(2);
  if (command !== 'verify'
    || !repoRoot || !gstackRoot || !name || !previousSource || !previousMode
    || !previousProvenance || !target || !desiredSource || !desiredMode || !desiredProvenance) {
    console.error(
      'usage: cursor-link-ownership-guard.mjs verify <repo-root> <gstack-root> <name> '
      + '<previous-source> <previous-mode> <previous-provenance> <target> '
      + '<desired-source> <desired-mode> <desired-provenance>',
    );
    process.exit(2);
  }
  try {
    validatePreviousLinkOwnership(
      repoRoot,
      gstackRoot,
      name,
      previousSource,
      previousMode,
      previousProvenance,
      target,
      desiredSource,
      desiredMode,
      desiredProvenance,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
