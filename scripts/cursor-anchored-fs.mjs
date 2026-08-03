#!/usr/bin/env node

'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSkillFrontmatterName } from './cursor-skill-frontmatter.mjs';
import {
  digestCanonicalTree,
  readStableRegularFile,
  validateStableTreeFiles,
} from './cursor-tree-digest.mjs';

function statIdentity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    type: stat.isDirectory() ? 'directory'
      : stat.isFile() ? 'file'
        : stat.isSymbolicLink() ? 'symlink' : 'other',
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.type === right.type;
}

function sameDirectoryAnchorIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.type === right.type;
}

function statRelative(candidate) {
  return statIdentity(fs.lstatSync(candidate, { bigint: true }));
}

function currentChain() {
  const chain = [];
  let relative = '.';
  while (true) {
    const current = statRelative(relative);
    if (current.type !== 'directory') throw new Error(`anchored cwd component is not a directory: ${relative}`);
    chain.push(current);
    const parent = statRelative(path.join(relative, '..'));
    if (sameIdentity(current, parent)) break;
    relative = path.join(relative, '..');
  }
  return chain;
}

function safeBasename(value, label) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
    || path.basename(value) !== value || value.includes('/') || value.includes('\\')
    || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} is not a safe basename`);
  }
  return value;
}

function decodeToken(raw, label) {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function encodeToken(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function assertCurrentDirectoryAnchor(anchor) {
  if (!anchor || anchor.version !== 1 || !Array.isArray(anchor.chain) || anchor.chain.length === 0) {
    throw new Error('directory anchor is malformed');
  }
  const actual = currentChain();
  if (actual.length !== anchor.chain.length
    || actual.some((entry, index) => !sameDirectoryAnchorIdentity(entry, anchor.chain[index]))) {
    throw new Error('anchored directory or its physical parent chain changed');
  }
}

export function captureDirectoryAnchor(directory) {
  const lookup = path.resolve(directory);
  const lookupStat = fs.lstatSync(lookup);
  if (!lookupStat.isDirectory() || lookupStat.isSymbolicLink()) {
    throw new Error(`anchor lookup is not a real directory: ${lookup}`);
  }
  const saved = process.cwd();
  try {
    process.chdir(lookup);
    const first = currentChain();
    const anchor = { version: 1, lookup, chain: first };
    assertCurrentDirectoryAnchor(anchor);
    return anchor;
  } finally {
    process.chdir(saved);
  }
}

export function assertDirectoryLookup(anchor) {
  const stat = fs.lstatSync(anchor.lookup);
  const expected = anchor.chain[0];
  const actual = statIdentity(fs.lstatSync(anchor.lookup, { bigint: true }));
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameDirectoryAnchorIdentity(expected, actual)) {
    throw new Error(`directory lookup changed: ${anchor.lookup}`);
  }
  const saved = process.cwd();
  try {
    process.chdir(anchor.lookup);
    assertCurrentDirectoryAnchor(anchor);
  } finally {
    process.chdir(saved);
  }
}

export function assertAlternateDirectoryLookup(anchor, lookup) {
  assertDirectoryLookup({ ...anchor, lookup: path.resolve(lookup) });
}

export function withAnchoredDirectory(anchor, callback) {
  assertDirectoryLookup(anchor);
  const saved = process.cwd();
  try {
    process.chdir(anchor.lookup);
    assertCurrentDirectoryAnchor(anchor);
    const result = callback();
    assertCurrentDirectoryAnchor(anchor);
    return result;
  } finally {
    process.chdir(saved);
  }
}

function recoveredDirectoryLookup(anchor) {
  try {
    assertDirectoryLookup(anchor);
    return anchor.lookup;
  } catch (lookupError) {
    if (anchor.chain.length < 2) throw lookupError;
    const parentAnchor = {
      version: 1,
      lookup: path.dirname(anchor.lookup),
      chain: anchor.chain.slice(1),
    };
    const parentLookup = recoveredDirectoryLookup(parentAnchor);
    const matches = [];
    const saved = process.cwd();
    try {
      process.chdir(parentLookup);
      assertCurrentDirectoryAnchor(parentAnchor);
      for (const name of fs.readdirSync('.')) {
        const stat = fs.lstatSync(name, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        if (sameDirectoryAnchorIdentity(anchor.chain[0], statIdentity(stat))) {
          matches.push(path.join(parentLookup, name));
        }
      }
      assertCurrentDirectoryAnchor(parentAnchor);
    } finally {
      process.chdir(saved);
    }
    if (matches.length !== 1) {
      throw new AggregateError(
        [lookupError],
        `anchored directory lookup changed and inode recovery found ${matches.length} matches`,
      );
    }
    return matches[0];
  }
}

function withRecoveredAnchoredDirectory(anchor, callback) {
  const lookup = recoveredDirectoryLookup(anchor);
  const saved = process.cwd();
  try {
    process.chdir(lookup);
    assertCurrentDirectoryAnchor(anchor);
    const result = callback();
    assertCurrentDirectoryAnchor(anchor);
    return result;
  } finally {
    process.chdir(saved);
  }
}

export function snapshotDirectoryEntry(anchor, name) {
  safeBasename(name, 'entry name');
  return withAnchoredDirectory(anchor, () => {
    const stat = fs.lstatSync(name, { throwIfNoEntry: false, bigint: true });
    return stat ? statIdentity(stat) : null;
  });
}

export function removeAnchoredEntry(anchor, name, expected = null) {
  safeBasename(name, 'removed entry name');
  return withRecoveredAnchoredDirectory(anchor, () => {
    if (expected) requireEntrySnapshot(name, expected);
    const stat = fs.lstatSync(name, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(name);
    else if (stat.isDirectory()) fs.rmSync(name, { recursive: true, force: true });
    else throw new Error(`refusing to remove unsupported anchored entry: ${name}`);
  });
}

export function removeAnchoredDirectoryByIdentity(anchor, name, expectedDirectory) {
  safeBasename(name, 'removed directory name');
  return withRecoveredAnchoredDirectory(anchor, () => {
    const stat = fs.lstatSync(name, { throwIfNoEntry: false, bigint: true });
    if (!stat) return;
    const actual = statIdentity(stat);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || !sameDirectoryAnchorIdentity(expectedDirectory, actual)) {
      throw new Error(`anchored directory inode changed before cleanup: ${name}`);
    }
    fs.rmSync(name, { recursive: true, force: true });
  });
}

function requireEntrySnapshot(name, expected) {
  const stat = fs.lstatSync(name, { throwIfNoEntry: false, bigint: true });
  const actual = stat ? statIdentity(stat) : null;
  if (expected === null ? actual !== null : !actual || !sameIdentity(expected, actual)) {
    throw new Error(`anchored entry changed before commit: ${name}`);
  }
}

function stablePathFingerprint(name) {
  const records = [];

  function visit(candidate, relative) {
    const before = fs.lstatSync(candidate, { bigint: true });
    const identity = statIdentity(before);
    if (before.isSymbolicLink()) {
      if (before.nlink !== 1n) throw new Error(`fingerprinted symlink has unexpected link count: ${relative}`);
      const target = fs.readlinkSync(candidate);
      const after = fs.lstatSync(candidate, { bigint: true });
      if (!sameIdentity(identity, statIdentity(after))) {
        throw new Error(`fingerprinted symlink changed while being read: ${relative}`);
      }
      records.push({ relative, identity, target });
      return;
    }
    if (before.isFile()) {
      if (before.nlink !== 1n) throw new Error(`fingerprinted file has unexpected link count: ${relative}`);
      const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        if (!sameIdentity(identity, statIdentity(fs.fstatSync(descriptor, { bigint: true })))) {
          throw new Error(`fingerprinted file changed before read: ${relative}`);
        }
        const content = fs.readFileSync(descriptor);
        if (!sameIdentity(identity, statIdentity(fs.fstatSync(descriptor, { bigint: true })))
          || !sameIdentity(identity, statIdentity(fs.lstatSync(candidate, { bigint: true })))) {
          throw new Error(`fingerprinted file changed while being read: ${relative}`);
        }
        records.push({
          relative,
          identity,
          size: content.length,
          digest: crypto.createHash('sha256').update(content).digest('hex'),
        });
      } finally {
        fs.closeSync(descriptor);
      }
      return;
    }
    if (!before.isDirectory()) throw new Error(`fingerprinted entry has unsupported type: ${relative}`);
    const names = fs.readdirSync(candidate).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    records.push({ relative, identity, names });
    for (const child of names) visit(path.join(candidate, child), relative ? `${relative}/${child}` : child);
    if (!sameIdentity(identity, statIdentity(fs.lstatSync(candidate, { bigint: true })))) {
      throw new Error(`fingerprinted directory changed while being walked: ${relative}`);
    }
  }

  visit(name, '');
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function captureEntryRecord(name) {
  const identity = statRelative(name);
  return { identity, fingerprint: stablePathFingerprint(name) };
}

function requireEntryRecord(name, expected, label) {
  requireEntrySnapshot(name, expected.identity);
  if (stablePathFingerprint(name) !== expected.fingerprint) {
    throw new Error(`${label} content changed`);
  }
}

function sameEntryRecord(left, right) {
  return Boolean(left && right
    && sameIdentity(left.identity, right.identity)
    && left.fingerprint === right.fingerprint);
}

function assertSafeSkillSourceTree(sourcePath, label) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  validateStableTreeFiles(sourcePath, {
    label,
    validateEntry({ relative, stat, type }) {
      const display = relative || '.';
      if (currentUid !== null && stat.uid !== currentUid) {
        throw new Error(`${label} entry is not owned by the current user: ${display}`);
      }
      if ((stat.mode & 0o022) !== 0) {
        throw new Error(`${label} entry is group/world-writable: ${display}`);
      }
      if (type === 'directory' && (stat.mode & 0o500) !== 0o500) {
        throw new Error(`${label} directory is not owner-readable/executable: ${display}`);
      }
      if (type === 'file' && (stat.mode & 0o400) === 0) {
        throw new Error(`${label} file is not owner-readable: ${display}`);
      }
    },
  });
}

function expectedMarkerForSourceAttestation(attestation) {
  return {
    version: 2,
    owner: 'jarvis-cortex',
    mode: attestation.mode,
    name: attestation.name,
    provenance: attestation.provenance,
    sourcePath: attestation.sourcePath,
    sourceReal: attestation.sourceReal,
    digest: attestation.renderedDigest,
    sourceIdentity: attestation.sourceRecord.identity,
    sourceFingerprint: attestation.sourceRecord.fingerprint,
    sourceCanonicalDigest: attestation.sourceCanonicalDigest,
  };
}

function validateSourceAttestationShape(attestation) {
  if (!attestation || attestation.version !== 1
    || attestation.kind !== 'skill-source-attestation'
    || typeof attestation.name !== 'string'
    || !['cursor-copy', 'gstack-copy'].includes(attestation.mode)
    || !['cortex', 'gstack'].includes(attestation.provenance)
    || (attestation.mode === 'cursor-copy' ? attestation.provenance !== 'cortex'
      : attestation.provenance !== 'gstack')
    || attestation.frontmatterName !== attestation.name
    || !path.isAbsolute(attestation.sourcePath)
    || path.normalize(attestation.sourcePath) !== attestation.sourcePath
    || typeof attestation.sourceReal !== 'string'
    || !attestation.sourceRecord?.identity
    || typeof attestation.sourceRecord.fingerprint !== 'string'
    || typeof attestation.sourceCanonicalDigest !== 'string'
    || typeof attestation.renderedDigest !== 'string'
    || typeof attestation.sourceAvailable !== 'boolean') {
    throw new Error('skill source attestation has unsupported shape');
  }
  safeBasename(attestation.name, 'attested skill name');
  const expectedMarker = expectedMarkerForSourceAttestation(attestation);
  if (JSON.stringify(attestation.expectedMarker) !== JSON.stringify(expectedMarker)) {
    throw new Error(`skill source attestation marker tuple mismatch: ${attestation.name}`);
  }
  return attestation;
}

export function captureSkillSourceAttestation({
  sourcePath: sourceArg,
  name,
  mode,
  provenance,
  renderedDigest,
}) {
  const sourcePath = path.resolve(sourceArg);
  if (sourceArg !== sourcePath) throw new Error('skill source attestation path is not canonical absolute');
  const root = fs.lstatSync(sourcePath);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`skill source attestation root is not a real directory: ${sourcePath}`);
  }
  safeBasename(name, 'attested skill name');
  const sourceReal = fs.realpathSync(sourcePath);
  const before = captureEntryRecord(sourcePath);
  assertSafeSkillSourceTree(sourcePath, `attested skill source ${name}`);
  assertSkillFrontmatterName(
    path.join(sourcePath, 'SKILL.md'),
    name,
    `attested skill source ${name}`,
  );
  const sourceCanonicalDigest = digestCanonicalTree(sourcePath, {
    label: `attested skill source ${name}`,
  });
  const after = captureEntryRecord(sourcePath);
  if (!sameEntryRecord(before, after) || fs.realpathSync(sourcePath) !== sourceReal) {
    throw new Error(`attested skill source changed while it was captured: ${name}`);
  }
  const attestation = {
    version: 1,
    kind: 'skill-source-attestation',
    name,
    mode,
    provenance,
    frontmatterName: name,
    sourcePath,
    sourceReal,
    sourceRecord: before,
    sourceCanonicalDigest,
    renderedDigest,
    sourceAvailable: true,
  };
  attestation.expectedMarker = expectedMarkerForSourceAttestation(attestation);
  return validateSourceAttestationShape(attestation);
}

export function sourceAttestationFromMarker(marker, { sourceAvailable = false } = {}) {
  const attestation = {
    version: 1,
    kind: 'skill-source-attestation',
    name: marker?.name,
    mode: marker?.mode,
    provenance: marker?.provenance,
    frontmatterName: marker?.name,
    sourcePath: marker?.sourcePath,
    sourceReal: marker?.sourceReal,
    sourceRecord: marker?.sourceIdentity && typeof marker?.sourceFingerprint === 'string'
      ? { identity: marker.sourceIdentity, fingerprint: marker.sourceFingerprint }
      : null,
    sourceCanonicalDigest: marker?.sourceCanonicalDigest,
    renderedDigest: marker?.digest,
    sourceAvailable,
  };
  attestation.expectedMarker = marker;
  return validateSourceAttestationShape(attestation);
}

export function encodeSkillSourceAttestation(attestation) {
  return encodeToken(validateSourceAttestationShape(attestation));
}

function decodeSkillSourceAttestation(raw) {
  return validateSourceAttestationShape(decodeToken(raw, 'skill source attestation'));
}

function validateSkillSourceAttestation(attestation, { allowUnavailable = false } = {}) {
  validateSourceAttestationShape(attestation);
  const sourceStat = fs.lstatSync(attestation.sourcePath, { throwIfNoEntry: false });
  if (!sourceStat) {
    if (!allowUnavailable || attestation.sourceAvailable) {
      throw new Error(`attested skill source is missing: ${attestation.name}`);
    }
    return attestation.sourceRecord;
  }
  if (!attestation.sourceAvailable) {
    throw new Error(`historically unavailable skill source unexpectedly exists: ${attestation.name}`);
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()
    || fs.realpathSync(attestation.sourcePath) !== attestation.sourceReal) {
    throw new Error(`attested skill source physical identity mismatch: ${attestation.name}`);
  }
  const before = captureEntryRecord(attestation.sourcePath);
  if (!sameEntryRecord(before, attestation.sourceRecord)) {
    throw new Error(`attested skill source record mismatch: ${attestation.name}`);
  }
  assertSafeSkillSourceTree(attestation.sourcePath, `attested skill source ${attestation.name}`);
  assertSkillFrontmatterName(
    path.join(attestation.sourcePath, 'SKILL.md'),
    attestation.frontmatterName,
    `attested skill source ${attestation.name}`,
  );
  const canonicalDigest = digestCanonicalTree(attestation.sourcePath, {
    label: `attested skill source ${attestation.name}`,
  });
  const after = captureEntryRecord(attestation.sourcePath);
  if (canonicalDigest !== attestation.sourceCanonicalDigest
    || !sameEntryRecord(before, after)
    || !sameEntryRecord(after, attestation.sourceRecord)
    || fs.realpathSync(attestation.sourcePath) !== attestation.sourceReal) {
    throw new Error(`attested skill source changed or has an unexpected digest: ${attestation.name}`);
  }
  return after;
}

export function createAnchoredStage(parentAnchor, prefix) {
  safeBasename(`${prefix}x`, 'stage prefix');
  const name = withAnchoredDirectory(parentAnchor, () => {
    const created = fs.mkdtempSync(prefix);
    const basename = path.basename(created);
    safeBasename(basename, 'created stage');
    const stat = fs.lstatSync(basename, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('created stage is not a real directory');
    return basename;
  });
  const anchor = captureDirectoryAnchor(path.join(parentAnchor.lookup, name));
  if (!sameDirectoryAnchorIdentity(anchor.chain[1], parentAnchor.chain[0])) {
    throw new Error('created stage is not a child of the anchored parent');
  }
  return { name, anchor };
}

export function commitAnchoredStage({
  parentAnchor,
  stageName,
  targetName,
  expectedTarget,
  sourceAttestation = null,
}) {
  safeBasename(stageName, 'stage name');
  safeBasename(targetName, 'target name');
  const previousName = `.jarvis-previous-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  safeBasename(previousName, 'previous name');
  const transaction = withAnchoredDirectory(parentAnchor, () => {
    assertCurrentDirectoryAnchor(parentAnchor);
    requireEntrySnapshot(targetName, expectedTarget);
    const stageStat = fs.lstatSync(stageName, { bigint: true });
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) throw new Error('stage changed before commit');
    const stageIdentity = statIdentity(stageStat);
    const expectedPrevious = expectedTarget ? captureEntryRecord(targetName) : null;
    if (expectedTarget) {
      fs.renameSync(targetName, previousName);
      requireEntryRecord(previousName, expectedPrevious, 'transaction previous target');
    }
    try {
      fs.renameSync(stageName, targetName);
    } catch (error) {
      if (expectedTarget && !fs.lstatSync(targetName, { throwIfNoEntry: false })) {
        fs.renameSync(previousName, targetName);
      }
      throw error;
    }
    const installed = captureEntryRecord(targetName);
    if (!sameIdentity(stageIdentity, installed.identity)) throw new Error('committed target inode differs from stage');
    return { installed, expectedPrevious };
  });
  return encodeToken({
    version: 3,
    parentAnchor,
    targetName,
    previousName: expectedTarget ? previousName : null,
    installed: transaction.installed,
    expectedPrevious: transaction.expectedPrevious,
    sourceAttestation: sourceAttestation
      ? validateSourceAttestationShape(sourceAttestation)
      : null,
  });
}

function decodeTransaction(raw) {
  const token = decodeToken(raw, 'transaction token');
  if (token.version !== 3 || !token.parentAnchor || !token.installed?.identity
    || typeof token.installed.fingerprint !== 'string'
    || (token.previousName === null ? token.expectedPrevious !== null
      : !token.expectedPrevious?.identity || typeof token.expectedPrevious.fingerprint !== 'string')) {
    throw new Error('transaction token has unsupported shape');
  }
  safeBasename(token.targetName, 'transaction target');
  if (token.previousName !== null) safeBasename(token.previousName, 'transaction previous');
  if (token.sourceAttestation !== null) validateSourceAttestationShape(token.sourceAttestation);
  return token;
}

export function assertAnchoredTransaction(raw) {
  const token = decodeTransaction(raw);
  withAnchoredDirectory(token.parentAnchor, () => {
    requireEntryRecord(token.targetName, token.installed, 'transaction installed target');
    if (token.previousName !== null) {
      requireEntryRecord(token.previousName, token.expectedPrevious, 'transaction previous target');
    }
  });
  return token;
}

export function rollbackAnchoredTransaction(raw) {
  const token = decodeTransaction(raw);
  withRecoveredAnchoredDirectory(token.parentAnchor, () => {
    // The installed tree may have been mutated after commit. Its root inode is
    // still sufficient to remove it safely: recursive removal never follows a
    // child symlink. A replaced root is never claimed.
    requireEntrySnapshot(token.targetName, token.installed.identity);
    if (token.previousName !== null) {
      // A divergent previous entry is attacker/user-owned. Never delete,
      // relocate, or overwrite it merely to complete Jarvis recovery.
      requireEntryRecord(token.previousName, token.expectedPrevious, 'transaction previous target');
    }
    const rejected = `.jarvis-rejected-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    safeBasename(rejected, 'rejected name');
    fs.renameSync(token.targetName, rejected);
    try {
      if (token.previousName !== null) {
        fs.renameSync(token.previousName, token.targetName);
        try {
          requireEntryRecord(token.targetName, token.expectedPrevious, 'restored transaction target');
        } catch (restoreError) {
          // The entry moved from previousName was swapped after its last check.
          // Put the divergent artifact back under the quarantine name before
          // returning the exact installed target to its public name.
          if (!fs.lstatSync(token.previousName, { throwIfNoEntry: false })
            && fs.lstatSync(token.targetName, { throwIfNoEntry: false })) {
            fs.renameSync(token.targetName, token.previousName);
          }
          if (!fs.lstatSync(token.targetName, { throwIfNoEntry: false })
            && fs.lstatSync(rejected, { throwIfNoEntry: false })) {
            fs.renameSync(rejected, token.targetName);
          }
          throw restoreError;
        }
      }
      fs.rmSync(rejected, { recursive: true, force: true });
    } catch (error) {
      if (!fs.lstatSync(token.targetName, { throwIfNoEntry: false })
        && fs.lstatSync(rejected, { throwIfNoEntry: false })) {
        fs.renameSync(rejected, token.targetName);
      }
      throw error;
    }
  });
}

export function finalizeAnchoredTransaction(raw) {
  const token = assertAnchoredTransaction(raw);
  if (token.previousName === null) return;
  let cleanupName;
  let previousIdentity;
  withAnchoredDirectory(token.parentAnchor, () => {
    requireEntryRecord(token.previousName, token.expectedPrevious, 'transaction previous target');
    const previous = fs.lstatSync(token.previousName, { bigint: true });
    if (!previous.isDirectory() || previous.isSymbolicLink()) {
      throw new Error('transaction previous target is not a real directory');
    }
    const outer = statRelative('..');
    if (!token.parentAnchor.chain[1]
      || !sameDirectoryAnchorIdentity(token.parentAnchor.chain[1], outer)) {
      throw new Error('transaction cleanup parent differs from the anchored Cursor home');
    }
    cleanupName = `.jarvis-copy-cleanup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    safeBasename(cleanupName, 'transaction cleanup name');
    previousIdentity = token.expectedPrevious.identity;
    fs.renameSync(token.previousName, path.join('..', cleanupName));
  });
  const outerAnchor = {
    version: 1,
    lookup: path.dirname(token.parentAnchor.lookup),
    chain: token.parentAnchor.chain.slice(1),
  };
  try {
    withRecoveredAnchoredDirectory(outerAnchor, () => {
      requireEntryRecord(cleanupName, token.expectedPrevious, 'transaction cleanup target');
      fs.rmSync(cleanupName, { recursive: true, force: true });
    });
  } catch (error) {
    throw new Error(`transaction cleanup failed outside Cursor skills: ${error.message}`);
  }
}

function openPrivateExclusive(name) {
  safeBasename(name, 'private file name');
  const descriptor = fs.openSync(
    name,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  fs.fchmodSync(descriptor, 0o600);
  return descriptor;
}

function assertPrivateDescriptor(descriptor, label) {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} is not a private regular file with link count 1`);
  }
}

export function writePrivateAnchoredFile(anchor, name, content, { beforeOpen = null } = {}) {
  return withAnchoredDirectory(anchor, () => {
    let descriptor;
    try {
      if (beforeOpen) beforeOpen();
      assertCurrentDirectoryAnchor(anchor);
      descriptor = openPrivateExclusive(name);
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
      fs.fsyncSync(descriptor);
      assertPrivateDescriptor(descriptor, name);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
        descriptor = undefined;
      }
      try { fs.unlinkSync(name); } catch {}
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    const stat = fs.lstatSync(name);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`${name} changed after private creation`);
    }
  });
}

export function appendPrivateAnchoredFile(anchor, name, content) {
  safeBasename(name, 'append file name');
  return withAnchoredDirectory(anchor, () => {
    const initial = fs.lstatSync(name);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1
      || (initial.mode & 0o777) !== 0o600) throw new Error(`${name} is not a private append target`);
    const descriptor = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_APPEND
      | (fs.constants.O_NOFOLLOW || 0));
    try {
      assertPrivateDescriptor(descriptor, name);
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
      fs.fsyncSync(descriptor);
      assertPrivateDescriptor(descriptor, name);
    } finally {
      fs.closeSync(descriptor);
    }
  });
}

function privateFileSnapshot(anchor, name) {
  safeBasename(name, 'private file name');
  return withAnchoredDirectory(anchor, () => {
    const stat = fs.lstatSync(name);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`${name} is not a private regular file with link count 1`);
    }
    const content = readStableRegularFile(name, {
      label: `anchored private file ${name}`,
      expectedStat: stat,
    });
    return {
      identity: statIdentity(fs.lstatSync(name, { bigint: true })),
      size: content.length,
      digest: crypto.createHash('sha256').update(content).digest('hex'),
      content,
    };
  });
}

export function capturePrivateFileToken(anchor, name) {
  const snapshot = privateFileSnapshot(anchor, name);
  return encodeToken({
    version: 1,
    anchorIdentity: anchor.chain[0],
    name,
    identity: snapshot.identity,
    size: snapshot.size,
    digest: snapshot.digest,
  });
}

function requirePrivateFileToken(anchor, raw, expectedName) {
  const token = decodeToken(raw, 'private file token');
  if (token.version !== 1 || token.name !== expectedName
    || !token.identity || typeof token.digest !== 'string'
    || !sameDirectoryAnchorIdentity(token.anchorIdentity, anchor.chain[0])) {
    throw new Error('private file token has unsupported shape');
  }
  const actual = privateFileSnapshot(anchor, expectedName);
  if (!sameIdentity(token.identity, actual.identity)
    || token.size !== actual.size || token.digest !== actual.digest) {
    throw new Error('manifest temporary file changed after its expected identity/hash was captured');
  }
  return actual.content;
}

function parseInstalledManifest(content) {
  const rows = [];
  const seen = new Set();
  for (const line of content.toString('utf8').split(/\n/).filter(Boolean)) {
    const fields = line.split('\t');
    if (fields.length !== 4) throw new Error('installed manifest has a malformed row');
    const [name, source, mode, provenance] = fields;
    safeBasename(name, 'installed skill name');
    if (!path.isAbsolute(source)
      || !new Set(['link:cortex', 'link:hm', 'link:caveman', 'cursor-copy:cortex', 'gstack-copy:gstack'])
        .has(`${mode}:${provenance}`)) {
      throw new Error(`installed manifest has an unsafe row: ${name}`);
    }
    if (seen.has(name)) throw new Error(`installed manifest has a duplicate row: ${name}`);
    seen.add(name);
    rows.push({ name, source, mode, provenance });
  }
  return rows;
}

function validateInstalledCopy(row, attestation) {
  validateSkillSourceAttestation(attestation, {
    allowUnavailable: row.mode === 'gstack-copy',
  });
  const markerName = '.jarvis-cortex-skill.json';
  const targetStat = fs.lstatSync(row.name);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()
    || (currentUid !== null && targetStat.uid !== currentUid)
    || (targetStat.mode & 0o022) !== 0) {
    throw new Error(`installed copy target is unsafe: ${row.name}`);
  }
  assertSkillFrontmatterName(path.join(row.name, 'SKILL.md'), row.name, `installed copy ${row.name}`);
  const markerFile = path.join(row.name, markerName);
  const markerStat = fs.lstatSync(markerFile);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1
    || (currentUid !== null && markerStat.uid !== currentUid)
    || (markerStat.mode & 0o777) !== 0o600) {
    throw new Error(`installed copy marker is unsafe: ${row.name}`);
  }
  const marker = JSON.parse(readStableRegularFile(markerFile, {
    label: `installed copy marker ${row.name}`,
    expectedStat: markerStat,
  }).toString('utf8'));
  if (JSON.stringify(marker) !== JSON.stringify(attestation.expectedMarker)
    || marker.name !== row.name || marker.mode !== row.mode
    || marker.provenance !== row.provenance || marker.sourcePath !== row.source) {
    throw new Error(`installed copy marker tuple mismatch: ${row.name}`);
  }
  const digest = digestCanonicalTree(row.name, {
    label: `installed copy ${row.name}`,
    excludedRootEntries: [markerName],
    validateEntry({ relative, stat, type }) {
      const display = relative || '.';
      if (currentUid !== null && stat.uid !== currentUid) {
        throw new Error(`installed copy entry is not owned by current user: ${row.name}/${display}`);
      }
      if ((stat.mode & 0o022) !== 0) {
        throw new Error(`installed copy entry is group/world-writable: ${row.name}/${display}`);
      }
      if (type === 'directory' && (stat.mode & 0o500) !== 0o500) {
        throw new Error(`installed copy directory is not readable/executable: ${row.name}/${display}`);
      }
    },
  });
  if (digest !== marker.digest || digest !== attestation.renderedDigest) {
    throw new Error(`installed copy digest mismatch: ${row.name}`);
  }
}

function validateManagedLinkSource(row) {
  const sourceStat = fs.lstatSync(row.source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`managed link source is not a real directory: ${row.name}`);
  }
  const sourceReal = fs.realpathSync(row.source);
  const before = captureEntryRecord(row.source);
  assertSafeSkillSourceTree(row.source, `managed link source ${row.name}`);
  assertSkillFrontmatterName(
    path.join(row.source, 'SKILL.md'),
    row.name,
    `managed link source ${row.name}`,
  );
  const canonicalDigest = digestCanonicalTree(row.source, {
    label: `managed link source ${row.name}`,
  });
  const after = captureEntryRecord(row.source);
  if (!sameEntryRecord(before, after) || fs.realpathSync(row.source) !== sourceReal) {
    throw new Error(`managed link source changed while terminally validated: ${row.name}`);
  }
  return {
    sourceReal,
    sourceRecord: before,
    canonicalDigest,
  };
}

function validateInstalledRows(skillsAnchor, rows, attestations) {
  return withAnchoredDirectory(skillsAnchor, () => {
    const snapshots = new Map();
    for (const row of rows) {
      let sourceSnapshot;
      if (row.mode === 'link') {
        sourceSnapshot = validateManagedLinkSource(row);
        const stat = fs.lstatSync(row.name);
        const rawTarget = fs.readlinkSync(row.name);
        const relativeTarget = path.relative(process.cwd(), row.source);
        if (!stat.isSymbolicLink() || stat.nlink !== 1
          || (rawTarget !== row.source && rawTarget !== relativeTarget)
          || fs.realpathSync(row.name) !== fs.realpathSync(row.source)) {
          throw new Error(`installed managed link mismatch: ${row.name}`);
        }
      } else {
        const attestation = attestations.get(row.name);
        if (!attestation) throw new Error(`installed copy lacks source attestation: ${row.name}`);
        validateInstalledCopy(row, attestation);
        sourceSnapshot = {
          sourceReal: attestation.sourceReal,
          sourceRecord: attestation.sourceRecord,
          canonicalDigest: attestation.sourceCanonicalDigest,
          sourceAvailable: attestation.sourceAvailable,
        };
      }
      snapshots.set(row.name, {
        targetRecord: captureEntryRecord(row.name),
        sourceSnapshot,
      });
    }
    return snapshots;
  });
}

function requireSameInstalledRows(skillsAnchor, rows, attestations, expected) {
  const actual = validateInstalledRows(skillsAnchor, rows, attestations);
  for (const row of rows) {
    const before = expected.get(row.name);
    const after = actual.get(row.name);
    if (!before || !after || !sameEntryRecord(before.targetRecord, after.targetRecord)
      || JSON.stringify(before.sourceSnapshot) !== JSON.stringify(after.sourceSnapshot)) {
      throw new Error(`installed skill changed across manifest publication: ${row.name}`);
    }
  }
}

function rollbackTransactions(tokens) {
  const errors = [];
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    try { rollbackAnchoredTransaction(tokens[index]); } catch (error) { errors.push(error); }
  }
  return errors;
}

export function terminalVerifyAndPublish({
  homeAnchor,
  skillsAnchor,
  publicHome,
  manifestToken,
  sourceName,
  targetName,
  attestationTokens,
  transactionTokens,
}) {
  safeBasename(sourceName, 'manifest source');
  safeBasename(targetName, 'manifest target');
  const tokens = transactionTokens.map(decodeTransaction);
  const attestations = new Map();
  for (const raw of attestationTokens) {
    const attestation = decodeSkillSourceAttestation(raw);
    if (attestations.has(attestation.name)) {
      throw new Error(`duplicate skill source attestation: ${attestation.name}`);
    }
    attestations.set(attestation.name, attestation);
  }
  let rows;
  let beforeRows;
  let previousManifest = null;
  let previousName = null;
  let publishedIdentity = null;
  let manifestState = 'prepared';

  function validateTerminalSkillState(expectedRows = null) {
    assertAlternateDirectoryLookup(homeAnchor, publicHome);
    assertAlternateDirectoryLookup(skillsAnchor, path.join(publicHome, 'skills'));
    for (let index = 0; index < transactionTokens.length; index += 1) {
      const token = assertAnchoredTransaction(transactionTokens[index]);
      const rowAttestation = attestations.get(token.targetName);
      if (!token.sourceAttestation || !rowAttestation
        || JSON.stringify(token.sourceAttestation) !== JSON.stringify(rowAttestation)
        || !token.sourceAttestation.sourceAvailable) {
        throw new Error(`copy transaction source attestation mismatch: ${token.targetName}`);
      }
      validateSkillSourceAttestation(token.sourceAttestation);
    }
    if (expectedRows) {
      requireSameInstalledRows(skillsAnchor, rows, attestations, expectedRows);
      return expectedRows;
    }
    return validateInstalledRows(skillsAnchor, rows, attestations);
  }

  try {
    assertAlternateDirectoryLookup(homeAnchor, publicHome);
    assertAlternateDirectoryLookup(skillsAnchor, path.join(publicHome, 'skills'));
    const content = requirePrivateFileToken(homeAnchor, manifestToken, sourceName);
    rows = parseInstalledManifest(content);

    const rowsByName = new Map(rows.map((row) => [row.name, row]));
    const transactionNames = new Set();
    for (let index = 0; index < transactionTokens.length; index += 1) {
      const token = tokens[index];
      if (!sameDirectoryAnchorIdentity(token.parentAnchor.chain[0], skillsAnchor.chain[0])) {
        throw new Error('copy transaction is outside the anchored Cursor skills directory');
      }
      if (transactionNames.has(token.targetName)) throw new Error('duplicate copy transaction target');
      transactionNames.add(token.targetName);
      const row = rowsByName.get(token.targetName);
      if (!row || !['cursor-copy', 'gstack-copy'].includes(row.mode)) {
        throw new Error(`copy transaction is absent from installed manifest: ${token.targetName}`);
      }
      if (!token.sourceAttestation) {
        throw new Error(`copy transaction lacks source attestation: ${token.targetName}`);
      }
    }
    const copyNames = new Set(rows.filter((row) => row.mode !== 'link').map((row) => row.name));
    if (copyNames.size !== attestations.size
      || [...copyNames].some((name) => !attestations.has(name))) {
      throw new Error('terminal copy source attestations do not exactly cover installed copy rows');
    }

    // Terminal pre-publish gate. This is the last operation before the
    // manifest state machine begins and covers source, target, marker, link
    // raw target/realpath, and every transaction's expectedPrevious.
    beforeRows = validateTerminalSkillState();

    withAnchoredDirectory(homeAnchor, () => {
      // Revalidate the private source token inside the same anchored action,
      // immediately before any manifest transition.
      const sourceContent = requirePrivateFileToken(homeAnchor, manifestToken, sourceName);
      if (!sourceContent.equals(content)) throw new Error('manifest source changed before publication');
      const target = fs.lstatSync(targetName, { throwIfNoEntry: false });
      if (target) {
        if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1
          || (target.mode & 0o022) !== 0) throw new Error('installed manifest target is unsafe');
        previousManifest = captureEntryRecord(targetName);
        previousName = `.jarvis-manifest-previous-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        safeBasename(previousName, 'previous manifest name');
        fs.renameSync(targetName, previousName);
        manifestState = 'old-moved';
        requireEntryRecord(previousName, previousManifest, 'previous manifest');
      }
      const sourceSnapshot = privateFileSnapshot(homeAnchor, sourceName);
      fs.renameSync(sourceName, targetName);
      publishedIdentity = sourceSnapshot.identity;
      manifestState = 'new-published';
      requireEntrySnapshot(targetName, publishedIdentity);
    });

    const installedManifest = privateFileSnapshot(homeAnchor, targetName);
    if (!sameIdentity(publishedIdentity, installedManifest.identity)
      || crypto.createHash('sha256').update(installedManifest.content).digest('hex')
        !== crypto.createHash('sha256').update(content).digest('hex')) {
      throw new Error('published manifest changed after rename');
    }
    // Terminal post-publish gate. Confirmation is impossible until the exact
    // source/target/marker/previous state observed pre-publish is revalidated.
    validateTerminalSkillState(beforeRows);
    manifestState = 'postverified';

    if (previousName !== null) {
      withAnchoredDirectory(homeAnchor, () => {
        requireEntryRecord(previousName, previousManifest, 'previous manifest');
        fs.unlinkSync(previousName);
      });
    }
    manifestState = 'committed';
  } catch (error) {
    const recoveryErrors = [];
    if (manifestState !== 'prepared' && manifestState !== 'committed') {
      try {
        withRecoveredAnchoredDirectory(homeAnchor, () => {
          let rejected = null;
          if (manifestState === 'new-published' || manifestState === 'postverified') {
            requireEntrySnapshot(targetName, publishedIdentity);
            rejected = `.jarvis-manifest-rejected-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            safeBasename(rejected, 'rejected manifest name');
            fs.renameSync(targetName, rejected);
          }
          if (previousName !== null) {
            requireEntryRecord(previousName, previousManifest, 'previous manifest');
            if (fs.lstatSync(targetName, { throwIfNoEntry: false })) {
              throw new Error('manifest target is occupied during old-manifest restoration');
            }
            fs.renameSync(previousName, targetName);
            requireEntryRecord(targetName, previousManifest, 'restored manifest');
          }
          if (rejected !== null) fs.unlinkSync(rejected);
          manifestState = 'recovered';
        });
      } catch (restoreError) {
        recoveryErrors.push(restoreError);
      }
    }
    recoveryErrors.push(...rollbackTransactions(transactionTokens));
    if (recoveryErrors.length) {
      throw new AggregateError([error, ...recoveryErrors], 'terminal manifest publication failed and recovery was incomplete');
    }
    throw error;
  }
}

export function encodeAnchor(anchor) {
  return encodeToken(anchor);
}

export function decodeAnchor(raw) {
  return decodeToken(raw, 'directory anchor');
}

function isInvokedAsMain(modulePath, argvPath) {
  if (!argvPath) return false;
  try {
    // macOS exposes temporary directories through both /var and /private/var.
    // Comparing only their lexical spellings silently turns this CLI into a
    // no-op when the checkout was reached through the alternate alias.
    return fs.realpathSync(argvPath) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(argvPath) === path.resolve(modulePath);
  }
}

const self = isInvokedAsMain(fileURLToPath(import.meta.url), process.argv[1]);
if (self) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'anchor' && args.length === 1) {
      process.stdout.write(`${encodeAnchor(captureDirectoryAnchor(args[0]))}\n`);
    } else if (command === 'assert-anchor' && args.length === 1) {
      assertDirectoryLookup(decodeAnchor(args[0]));
    } else if (command === 'assert-lookup' && args.length === 2) {
      assertAlternateDirectoryLookup(decodeAnchor(args[0]), args[1]);
    } else if (command === 'write-private' && args.length === 2) {
      writePrivateAnchoredFile(decodeAnchor(args[0]), args[1], fs.readFileSync(0));
    } else if (command === 'append-private' && args.length === 2) {
      appendPrivateAnchoredFile(decodeAnchor(args[0]), args[1], fs.readFileSync(0));
    } else if (command === 'snapshot-private' && args.length === 2) {
      process.stdout.write(`${capturePrivateFileToken(decodeAnchor(args[0]), args[1])}\n`);
    } else if (command === 'terminal-publish' && args.length >= 6) {
      const attestationTokens = [];
      const transactionTokens = [];
      for (let index = 6; index < args.length; index += 2) {
        const flag = args[index];
        const token = args[index + 1];
        if (!token || !['--attestation', '--transaction'].includes(flag)) {
          throw new Error('terminal publish token arguments are malformed');
        }
        if (flag === '--attestation') attestationTokens.push(token);
        else transactionTokens.push(token);
      }
      terminalVerifyAndPublish({
        homeAnchor: decodeAnchor(args[0]),
        skillsAnchor: decodeAnchor(args[1]),
        publicHome: args[2],
        manifestToken: args[3],
        sourceName: args[4],
        targetName: args[5],
        attestationTokens,
        transactionTokens,
      });
    } else if (command === 'remove' && args.length === 2) {
      removeAnchoredEntry(decodeAnchor(args[0]), args[1]);
    } else if (command === 'assert-transaction' && args.length === 1) {
      assertAnchoredTransaction(args[0]);
    } else if (command === 'rollback' && args.length === 1) {
      rollbackAnchoredTransaction(args[0]);
    } else if (command === 'finalize' && args.length === 1) {
      finalizeAnchoredTransaction(args[0]);
    } else {
      throw new Error('usage: cursor-anchored-fs.mjs <anchor|assert-anchor|assert-lookup|write-private|append-private|snapshot-private|terminal-publish|remove|assert-transaction|rollback|finalize> ...');
    }
  } catch (error) {
    console.error(`Cursor anchored filesystem operation failed: ${error.message}`);
    process.exit(1);
  }
}
