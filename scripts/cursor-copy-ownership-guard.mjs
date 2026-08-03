#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { buildCursorSkillCatalog } from './cursor-skill-catalog.mjs';
import { assertSkillFrontmatterName } from './cursor-skill-frontmatter.mjs';
import { validateCortexCatalogSource } from './cursor-link-ownership-guard.mjs';
import { readStableRegularFile } from './cursor-tree-digest.mjs';

function assertOwnedAndSafe(stat, label, candidate) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stat.uid !== currentUid) {
    const error = new Error(`${label} is not owned by the current user: ${candidate}`);
    error.copySourceUnsafe = true;
    throw error;
  }
  if ((stat.mode & 0o022) !== 0) {
    const error = new Error(`${label} is group/world-writable: ${candidate}`);
    error.copySourceUnsafe = true;
    throw error;
  }
}

function assertCanonicalAbsolute(candidate, label) {
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
    throw new Error(`${label} is not canonical absolute: ${candidate}`);
  }
}

function assertTargetName(targetArg, name) {
  const target = path.resolve(targetArg);
  if (path.basename(target) !== name) {
    throw new Error(`Cursor copy target basename does not match tuple name ${name}: ${target}`);
  }
  return target;
}

function activeEntry(repoRoot, gstackRoot, name, mode, provenance) {
  const expected = buildCursorSkillCatalog(repoRoot, gstackRoot)
    .find((entry) => entry.name === name);
  if (!expected || expected.tombstone
    || expected.mode !== mode || expected.provenance !== provenance) {
    throw new Error(`Cursor copy tuple is absent from the active catalog: ${name} ${mode}:${provenance}`);
  }
  return expected;
}

function validateGstackCheckoutRoot(rootArg) {
  const root = path.resolve(rootArg);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`gstack copy root is not a real directory: ${root}`);
  }
  assertOwnedAndSafe(rootStat, 'gstack copy root', root);
  const rootReal = fs.realpathSync(root);
  for (const filename of ['ETHOS.md', 'VERSION']) {
    const identity = path.join(root, filename);
    const stat = fs.lstatSync(identity, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`gstack copy root identity is missing or unsafe: ${identity}`);
    }
    assertOwnedAndSafe(stat, 'gstack copy root identity', identity);
    readStableRegularFile(identity, {
      label: 'gstack copy root identity',
      expectedStat: stat,
    });
  }
  return rootReal;
}

function validateGstackCandidate(candidateArg, name, relativeSource) {
  assertCanonicalAbsolute(candidateArg, `gstack copy source ${name}`);
  const candidate = path.resolve(candidateArg);
  const segments = relativeSource.split(path.sep).filter(Boolean);
  let checkoutRoot = candidate;
  for (const _segment of segments) checkoutRoot = path.dirname(checkoutRoot);
  if (path.join(checkoutRoot, ...segments) !== candidate) {
    throw new Error(`gstack copy source does not match catalog-relative source for ${name}: ${candidate}`);
  }
  const checkoutReal = validateGstackCheckoutRoot(checkoutRoot);
  let current = checkoutReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`gstack copy source path is missing or unsafe: ${current}`);
    }
    assertOwnedAndSafe(stat, 'gstack copy source path', current);
  }
  const skillFile = path.join(candidate, 'SKILL.md');
  const skillStat = fs.lstatSync(skillFile, { throwIfNoEntry: false });
  if (!skillStat || !skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new Error(`gstack copy source SKILL.md is missing or unsafe: ${skillFile}`);
  }
  assertOwnedAndSafe(skillStat, 'gstack copy source SKILL.md', skillFile);
  assertSkillFrontmatterName(skillFile, name, `gstack copy source ${name}`);
  return fs.realpathSync(candidate);
}

export function validateCursorCopyTuple(
  repoRootArg,
  name,
  sourceArg,
  targetArg,
  previousSourceArg = null,
) {
  const repoRoot = fs.realpathSync(path.resolve(repoRootArg));
  const source = path.resolve(sourceArg);
  assertCanonicalAbsolute(sourceArg, `Cursor copy source ${name}`);
  assertTargetName(targetArg, name);
  const expected = activeEntry(repoRoot, null, name, 'cursor-copy', 'cortex');
  validateCortexCatalogSource(repoRoot, expected.source, source, name);
  assertSkillFrontmatterName(
    path.join(source, 'SKILL.md'),
    name,
    `Cursor copy source ${name}`,
  );
  const candidates = [source];
  if (previousSourceArg) {
    try {
      assertCanonicalAbsolute(previousSourceArg, `previous Cursor copy source ${name}`);
      const previousSource = path.resolve(previousSourceArg);
      validateCortexCatalogSource(repoRoot, expected.source, previousSource, name);
      assertSkillFrontmatterName(
        path.join(previousSource, 'SKILL.md'),
        name,
        `previous Cursor copy source ${name}`,
      );
      candidates.push(previousSource);
    } catch {
      // A bad previous row grants no ownership. The exact current tuple still
      // remains independently valid.
    }
  }
  return { expected, candidates: [...new Set(candidates)] };
}

export function validateGstackCopyTuple(
  repoRootArg,
  gstackRootArg,
  name,
  sourceArg,
  targetArg,
  previousSourceArg = null,
) {
  const repoRoot = fs.realpathSync(path.resolve(repoRootArg));
  const gstackRoot = validateGstackCheckoutRoot(gstackRootArg);
  const source = path.resolve(sourceArg);
  assertTargetName(targetArg, name);
  const expected = activeEntry(repoRoot, gstackRoot, name, 'gstack-copy', 'gstack');
  const relativeSource = path.relative(gstackRoot, expected.source);
  if (!relativeSource || relativeSource === '..' || relativeSource.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeSource)) {
    throw new Error(`gstack catalog source is not relative to its authorized root: ${name}`);
  }
  try {
    validateGstackCandidate(source, name, relativeSource);
  } catch (error) {
    error.copySourceUnsafe = true;
    throw error;
  }
  const candidates = [source];
  if (previousSourceArg) {
    try {
      assertCanonicalAbsolute(previousSourceArg, `previous gstack copy source ${name}`);
      const previousSource = path.resolve(previousSourceArg);
      validateGstackCandidate(previousSource, name, relativeSource);
      candidates.push(previousSource);
    } catch {
      // Invalid relocation candidates are excluded, never ownership proof.
    }
  }
  if (source !== expected.source) {
    // A non-current source is eligible only as the same-name physical
    // relocation shape validated above. The configured root remains the sole
    // authority for the active tuple.
    validateGstackCandidate(expected.source, name, relativeSource);
  }
  return { expected, candidates: [...new Set(candidates)] };
}
