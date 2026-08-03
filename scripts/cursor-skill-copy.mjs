#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCursorCopyTuple } from './cursor-copy-ownership-guard.mjs';
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
  withAnchoredDirectory,
  writePrivateAnchoredFile,
} from './cursor-anchored-fs.mjs';

const MARKER = '.jarvis-cortex-skill.json';
const VERSION = 2;
const FROM = '$HOME/.agents/skills/impeccable';
const TO = '${CURSOR_HOME:-$HOME/.cursor}/skills/impeccable';

const [command, sourceArg, targetArg, previousSourceArg, transactionArg] = process.argv.slice(2);
if (!['sync', 'verify', 'attest', 'owner-verify', 'remove'].includes(command) || !sourceArg || !targetArg) {
  console.error('usage: cursor-skill-copy.mjs <sync|verify|attest|owner-verify|remove> <source> <target> [previous-source]');
  process.exit(2);
}
if (transactionArg && transactionArg !== '--defer-finalize') {
  console.error('unsupported Cursor copy transaction option');
  process.exit(2);
}
const deferFinalize = transactionArg === '--defer-finalize';

const source = path.resolve(sourceArg);
const target = path.resolve(targetArg);
const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tupleName = path.basename(target);
let ownershipTuple = null;
let ownershipTupleError = null;
try {
  ownershipTuple = validateCursorCopyTuple(
    repoRoot,
    tupleName,
    sourceArg,
    targetArg,
    previousSourceArg || null,
  );
} catch (error) {
  ownershipTupleError = error;
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

function ownedTargetMarker() {
  if (!ownershipTuple) return null;
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) return null;
  const markerFile = path.join(target, MARKER);
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
      label: 'Cursor skill copy marker',
      expectedStat: markerStat,
    }).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return null;
    throw error;
  }
  if (![1, VERSION].includes(marker.version)
    || marker.owner !== 'jarvis-cortex'
    || marker.mode !== 'cursor-copy') return null;
  if (marker.version === VERSION
    && (marker.name !== tupleName || marker.provenance !== 'cortex')) return null;
  try {
    assertSkillFrontmatterName(
      path.join(target, 'SKILL.md'),
      tupleName,
      `installed Cursor copy ${tupleName}`,
    );
  } catch {
    return null;
  }
  const matches = ownershipTuple.candidates.some((candidate) => {
    const identity = sourceIdentity(candidate);
    return marker.sourcePath === identity.sourcePath && marker.sourceReal === identity.sourceReal;
  });
  return matches ? marker : null;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertRealDirectory(candidate, label) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
}

function assertRealTree(root, label) {
  validateStableTreeFiles(root, { label });
}

if (ownershipTupleError?.copySourceUnsafe) {
  console.error(`Cursor skill copy source validation failed: ${ownershipTupleError.message}`);
  process.exit(1);
}

if (command === 'owner-verify' || command === 'remove') {
  try {
    if (!ownedTargetMarker()) {
      console.error('Cursor skill copy ownership verification failed: marker or source identity mismatch');
      process.exit(10);
    }
    if (command === 'remove') fs.rmSync(target, { recursive: true, force: true });
    else process.stdout.write(`${fs.realpathSync(target)}\n`);
  } catch (error) {
    console.error(`Cursor skill copy ownership verification failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'sync' && fs.lstatSync(target, { throwIfNoEntry: false })
  && !ownedTargetMarker()) {
  console.error('Cursor skill copy is not Jarvis-owned: marker or source identity mismatch');
  process.exit(10);
}

assertRealDirectory(source, 'Cursor skill copy source');
assertRealTree(source, 'Cursor skill copy source');
const sourceReal = fs.realpathSync(source);
if (!ownershipTuple) throw ownershipTupleError;

function transformedContent(file, content) {
  return file.endsWith('.md') ? content.replaceAll(FROM, TO) : content;
}

function validateDigestEntry({ relative, stat, type }) {
  const display = relative || '.';
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(`Cursor skill copy tree entry is not owned by the current user: ${display}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`Cursor skill copy tree entry is group/world-writable: ${display}`);
  }
  if (type === 'directory' && (stat.mode & 0o500) !== 0o500) {
    throw new Error(`Cursor skill copy tree directory is not owner-readable/executable: ${display}`);
  }
  if (type === 'file' && (stat.mode & 0o400) === 0) {
    throw new Error(`Cursor skill copy tree file is not owner-readable: ${display}`);
  }
}

function digestTree(root, transformMarkdown) {
  return digestCanonicalTree(root, {
    label: 'Cursor skill copy tree',
    excludedRootEntries: [MARKER],
    validateEntry: validateDigestEntry,
    transformFile: transformMarkdown
      ? ({ absolute, content }) => absolute.endsWith('.md')
        ? Buffer.from(transformedContent(absolute, content.toString('utf8')))
        : content
      : undefined,
  });
}

const expectedDigest = digestTree(source, true);
const sourceAttestation = captureSkillSourceAttestation({
  sourcePath: source,
  name: tupleName,
  mode: 'cursor-copy',
  provenance: 'cortex',
  renderedDigest: expectedDigest,
});

if (command === 'verify' || command === 'attest') {
  try {
    const marker = ownedTargetMarker();
    const targetDigest = digestTree(target, false);
    const valid = marker
      && marker.version === VERSION
      && marker.digest === expectedDigest
      && JSON.stringify(marker) === JSON.stringify(sourceAttestation.expectedMarker)
      && targetDigest === expectedDigest;
    if (!valid) throw new Error('marker or content mismatch');
    process.stdout.write(command === 'attest'
      ? `${encodeSkillSourceAttestation(sourceAttestation)}\n`
      : `${expectedDigest}\n`);
  } catch (error) {
    console.error(`Cursor skill copy verification failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const parent = path.dirname(target);
fs.mkdirSync(parent, { recursive: true });
const parentAnchor = captureDirectoryAnchor(parent);
const expectedTarget = snapshotDirectoryEntry(parentAnchor, tupleName);
const staged = createAnchoredStage(parentAnchor, '.jarvis-cursor-stage-');
let transactionToken = null;

try {
  function transformMarkdown(current) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) transformMarkdown(path.join(current, name));
      return;
    }
    if (stat.isFile() && current.endsWith('.md')) {
      const before = fs.readFileSync(current, 'utf8');
      const after = transformedContent(current, before);
      if (after !== before) fs.writeFileSync(current, after);
    }
  }

  withAnchoredDirectory(staged.anchor, () => {
    for (const name of fs.readdirSync(source)) {
      fs.cpSync(path.join(source, name), name, { recursive: true, verbatimSymlinks: true });
    }
  });
  withAnchoredDirectory(staged.anchor, () => {
    fs.chmodSync('.', fs.lstatSync(source).mode & 0o7777);
    transformMarkdown('.');
    assertRealDirectory('.', 'staged Cursor skill copy');
    assertRealTree('.', 'staged Cursor skill copy');
    assertSkillFrontmatterName('SKILL.md', tupleName, `staged Cursor copy ${tupleName}`);
    if (digestTree(source, true) !== expectedDigest || digestTree('.', false) !== expectedDigest) {
      throw new Error('staged Cursor skill copy differs from the validated rendered source');
    }
  });

  const markerContent = `${JSON.stringify(sourceAttestation.expectedMarker, null, 2)}\n`;
  writePrivateAnchoredFile(staged.anchor, MARKER, markerContent);

  function verifyAnchoredCopy(anchor) {
    withAnchoredDirectory(anchor, () => {
      if (digestTree(source, true) !== expectedDigest || digestTree('.', false) !== expectedDigest) {
        throw new Error('anchored Cursor skill copy differs from the validated rendered source');
      }
      assertSkillFrontmatterName('SKILL.md', tupleName, `anchored Cursor copy ${tupleName}`);
      const markerStat = fs.lstatSync(MARKER);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1
        || (currentUid !== null && markerStat.uid !== currentUid)
        || (markerStat.mode & 0o777) !== 0o600) {
        throw new Error('anchored Cursor marker is not private');
      }
      const marker = JSON.parse(readStableRegularFile(MARKER, {
        label: 'anchored Cursor skill marker',
        expectedStat: markerStat,
      }).toString('utf8'));
      if (JSON.stringify(marker) !== JSON.stringify(sourceAttestation.expectedMarker)) {
        throw new Error('anchored Cursor skill marker content mismatch');
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
      throw new AggregateError([error, rollbackError], 'Cursor skill copy failed and rollback could not complete');
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
    console.error(`warn: Cursor skill copy committed; anchored cleanup failed: ${error.message}`);
  }
}
