#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { rawLinkTargetIsExact } from './cursor-link-target.mjs';
import { validatePreviousLinkOwnership } from './cursor-link-ownership-guard.mjs';
import { validateLinkSkillSource } from './cursor-skill-source-guard.mjs';
import { validateStaleLink } from './cursor-stale-link-guard.mjs';
import { readStableRegularFile, validateStableTreeFiles } from './cursor-tree-digest.mjs';

const [command, cursorHomeArg, trustedHomeArg, repoRootArg, gstackRootArg] = process.argv.slice(2);
if (!['ensure', 'verify', 'verify-boundary'].includes(command) || !cursorHomeArg || !trustedHomeArg || !repoRootArg) {
  console.error('usage: cursor-root-guard.mjs <ensure|verify|verify-boundary> <cursor-home> <trusted-home> <repo-root>');
  process.exit(2);
}
const verifyMode = command !== 'ensure';

const cursorHome = path.resolve(cursorHomeArg);
const trustedHome = path.resolve(trustedHomeArg);
const repoRoot = path.resolve(repoRootArg);
const gstackRoot = path.resolve(gstackRootArg || path.join(trustedHome, '.gstack', 'repos', 'gstack'));
const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
const desiredManifestRaw = fs.readFileSync(0, 'utf8');

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function commonAncestor(left, right) {
  let current = left;
  while (!isWithin(right, current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function assertOwnedAndNotWritable(stat, label, candidate) {
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user: ${candidate}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} is group/world-writable: ${candidate}`);
  }
}

function assertRealDirectory(candidate, label, required = true) {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) {
    if (required) throw new Error(`${label} is missing: ${candidate}`);
    return false;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${candidate}`);
  }
  assertOwnedAndNotWritable(stat, label, candidate);
  return true;
}

const anchor = commonAncestor(trustedHome, cursorHome);
let anchorUserControlled = false;

function assertSystemAncestor(stat, label, candidate) {
  if (stat.uid !== 0) {
    throw new Error(`${label} has an ancestor owned by an unexpected user: ${candidate}`);
  }
  const writableByOthers = (stat.mode & 0o022) !== 0;
  const sticky = (stat.mode & 0o1000) !== 0;
  if (writableByOthers && !sticky) {
    throw new Error(`${label} has an unsafe system-owned writable ancestor: ${candidate}`);
  }
}

function inspectAnchor() {
  const stat = fs.lstatSync(anchor);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`validation anchor is not a real directory: ${anchor}`);
  }
  if (anchor === trustedHome
    || (currentUid !== null && currentUid !== 0 && stat.uid === currentUid)) {
    assertOwnedAndNotWritable(stat, 'validation anchor', anchor);
    anchorUserControlled = true;
  } else {
    assertSystemAncestor(stat, 'validation anchor', anchor);
  }
}

function validatePathDirectory(stat, candidate, label, userControlled) {
  if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symlink: ${candidate}`);
  if (!stat.isDirectory()) throw new Error(`${label} path contains a non-directory: ${candidate}`);
  if (userControlled
    || (currentUid !== null && currentUid !== 0 && stat.uid === currentUid)) {
    assertOwnedAndNotWritable(stat, `${label} path component`, candidate);
    return true;
  }
  assertSystemAncestor(stat, label, candidate);
  return false;
}

function beginsManagedSuffixAfter(stat, userControlled) {
  return !userControlled
    && currentUid === 0
    && stat.uid === 0
    && (stat.mode & 0o022) !== 0
    && (stat.mode & 0o1000) !== 0;
}

function inspectDirectoryPath(candidate, label) {
  if (!isWithin(candidate, anchor)) throw new Error(`${label} is outside the validation anchor`);
  let current = anchor;
  let missing = false;
  // HOME is the normal trust boundary. For an explicitly external CURSOR_HOME,
  // root-owned non-writable system prefixes (plus sticky /tmp) are accepted
  // until the first current-user-owned component. Under UID 0, the child of a
  // sticky system directory (for example /tmp/<managed>) starts the managed
  // suffix. Every managed component must be owned by us and not writable by
  // group/world.
  let userControlled = anchorUserControlled;
  let nextIsManagedSuffix = beginsManagedSuffixAfter(fs.lstatSync(anchor), userControlled);
  for (const segment of path.relative(anchor, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      missing = true;
      continue;
    }
    if (missing) throw new Error(`${label} has an existing child below a missing parent: ${current}`);
    if (nextIsManagedSuffix) userControlled = true;
    userControlled = validatePathDirectory(stat, current, label, userControlled);
    nextIsManagedSuffix = beginsManagedSuffixAfter(stat, userControlled);
  }
  return !missing;
}

const directoryPlan = [
  { candidate: cursorHome, label: 'Cursor home', create: true },
  { candidate: path.join(cursorHome, 'hooks'), label: 'Cursor hooks root', create: true },
  { candidate: path.join(cursorHome, 'rules'), label: 'Cursor rules root', create: true },
  { candidate: path.join(cursorHome, 'skills'), label: 'Cursor skills root', create: true },
  { candidate: path.join(cursorHome, 'jarvis-runtime'), label: 'Cursor Jarvis runtime root', create: true },
  { candidate: path.join(cursorHome, 'jarvis-runtime', 'gstack'), label: 'Cursor gstack runtime', create: false },
  { candidate: path.join(cursorHome, 'jarvis-runtime', 'gstack-state'), label: 'Cursor gstack state', create: false },
];

const linkPlan = [
  ['hooks/rtk-shell.js', 'cursor/hooks/rtk-shell.js'],
  ['hooks/enforce-cursor.js', 'cursor/hooks/enforce-cursor.js'],
  ['hooks/session-start.js', 'cursor/hooks/session-start.js'],
  ['permissions.json', 'cursor/permissions.json'],
  ['rules/jarvis-cortex.mdc', 'cursor/rules/jarvis-cortex.mdc'],
].map(([destination, source]) => ({
  candidate: path.join(cursorHome, destination),
  expectedSource: path.join(repoRoot, source),
  label: `Cursor managed link ${destination}`,
  executable: destination.startsWith('hooks/'),
}));

const regularFilePlan = [
  ['hooks.json', 'Cursor hooks config'],
  ['mcp.json', 'Cursor MCP config'],
  ['jarvis-cortex-skills.manifest.tsv', 'Cursor managed skill manifest'],
].map(([relative, label]) => ({ candidate: path.join(cursorHome, relative), label }));

function parseSkillManifest(raw, label) {
  const rows = new Map();
  for (const line of raw.split(/\n/).filter(Boolean)) {
    const fields = line.split('\t');
    if (fields.length !== 4) throw new Error(`${label} has a malformed row`);
    const [name, source, mode, provenance] = fields;
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      throw new Error(`${label} has an unsafe skill name: ${name || '<empty>'}`);
    }
    if (!path.isAbsolute(source)
      || !new Set(['link:cortex', 'link:hm', 'link:caveman', 'cursor-copy:cortex', 'gstack-copy:gstack'])
        .has(`${mode}:${provenance}`)) {
      throw new Error(`${label} has an unsafe skill row: ${name}`);
    }
    if (rows.has(name)) throw new Error(`${label} has a duplicate skill row: ${name}`);
    rows.set(name, { name, source, mode, provenance });
  }
  return rows;
}

const desiredSkills = parseSkillManifest(desiredManifestRaw, 'Cursor desired skill manifest');

function inspectExpectedSource(expectedSource, label, executable) {
  if (!isWithin(expectedSource, repoRoot)) {
    throw new Error(`${label} expected source is outside the cortex root: ${expectedSource}`);
  }
  const repoReal = fs.realpathSync(repoRoot);
  let current = repoRoot;
  const segments = path.relative(repoRoot, expectedSource).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new Error(`${label} expected source is missing: ${current}`);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} expected source path contains a symlink: ${current}`);
    }
    const isLeaf = index === segments.length - 1;
    if (isLeaf ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`${label} expected source path has an invalid type: ${current}`);
    }
    assertOwnedAndNotWritable(stat, `${label} expected source path component`, current);
    const real = fs.realpathSync(current);
    if (!isWithin(real, repoReal)) {
      throw new Error(`${label} expected source escapes the cortex root: ${current}`);
    }
    if (isLeaf && executable && (stat.mode & 0o100) === 0) {
      throw new Error(`${label} expected hook source is not executable: ${current}`);
    }
    if (isLeaf) {
      readStableRegularFile(current, {
        label: `${label} expected source`,
        expectedStat: stat,
      });
    }
  }
  return fs.realpathSync(expectedSource);
}

function inspectManagedLinkDestination({ candidate, expectedSource, label, executable }) {
  const expectedReal = inspectExpectedSource(expectedSource, label, executable);
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) {
    if (verifyMode) throw new Error(`${label} is missing: ${candidate}`);
    return;
  }
  if (stat.isSymbolicLink()) {
    const rawTargetExact = rawLinkTargetIsExact(candidate, expectedReal);
    let actual;
    try {
      actual = fs.realpathSync(candidate);
    } catch {
      throw new Error(`${label} is a dangling managed symlink: ${candidate}`);
    }
    const targetStat = fs.statSync(candidate);
    if (!targetStat.isFile() || actual !== expectedReal) {
      throw new Error(`${label} points outside its managed source: ${candidate}`);
    }
    // `ensure` may safely replace a lexical alias only after proving that it
    // resolves to this exact managed file. `verify`/doctor require the raw
    // absolute or path.relative spelling so aliases cannot impersonate it.
    if (verifyMode && !rawTargetExact) {
      throw new Error(`${label} does not use its exact managed source spelling: ${candidate}`);
    }
    return;
  }
  if (verifyMode) {
    throw new Error(`${label} is not the required managed symlink: ${candidate}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} is not a replaceable regular file or managed symlink: ${candidate}`);
  }
  assertOwnedAndNotWritable(stat, label, candidate);
}

function inspectRegularFileDestination({ candidate, label }) {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real regular file: ${candidate}`);
  }
  assertOwnedAndNotWritable(stat, label, candidate);
  readStableRegularFile(candidate, { label, expectedStat: stat });
}

function inspectTemporaryManifests() {
  const stat = fs.lstatSync(cursorHome, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  for (const entry of fs.readdirSync(cursorHome)) {
    if (!/^\.jarvis-cortex-skills\.(?:desired|installed)\.[0-9]+$/.test(entry)) continue;
    inspectRegularFileDestination({
      candidate: path.join(cursorHome, entry),
      label: 'Cursor temporary skill manifest',
    });
  }
}

function inspectSkillDestination(candidate, label) {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return;
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user: ${candidate}`);
  }
  if (!stat.isSymbolicLink()) assertOwnedAndNotWritable(stat, label, candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  validateStableTreeFiles(candidate, {
    label,
    allowSymlinks: true,
  });
  for (const marker of ['.jarvis-cortex-skill.json']) {
    const markerPath = path.join(candidate, marker);
    const markerStat = fs.lstatSync(markerPath, { throwIfNoEntry: false });
    if (!markerStat) continue;
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
      throw new Error(`${label} ownership marker is not a real regular file: ${markerPath}`);
    }
    assertOwnedAndNotWritable(markerStat, `${label} ownership marker`, markerPath);
    if ((markerStat.mode & 0o777) !== 0o600) {
      throw new Error(`${label} ownership marker is not private (0600): ${markerPath}`);
    }
  }
}

function inspectDynamicSkillDestinations() {
  const installedPath = path.join(cursorHome, 'jarvis-cortex-skills.manifest.tsv');
  let installedSkills = new Map();
  if (fs.lstatSync(installedPath, { throwIfNoEntry: false })) {
    const installedStat = fs.lstatSync(installedPath);
    installedSkills = parseSkillManifest(
      readStableRegularFile(installedPath, {
        label: 'Cursor installed skill manifest',
        expectedStat: installedStat,
      }).toString('utf8'),
      'Cursor installed skill manifest',
    );
  }
  const names = new Set([...desiredSkills.keys(), ...installedSkills.keys()]);
  for (const row of desiredSkills.values()) {
    if (row.mode !== 'link') continue;
    validateLinkSkillSource(repoRoot, row.source, `Cursor desired link skill source ${row.name}`);
  }
  for (const row of installedSkills.values()) {
    if (row.mode !== 'link') continue;
    // A name that remains desired must always have a fully valid old and new
    // source when its managed mode/provenance also remains canonical. A row
    // with the same name but a different mode is stale/injected and must pass
    // the exact catalog proof below instead of inheriting ownership by name.
    const desired = desiredSkills.get(row.name);
    if (desired && desired.mode === row.mode && desired.provenance === row.provenance) {
      if (row.source === desired.source) {
        validateLinkSkillSource(repoRoot, row.source, `Cursor installed link skill source ${row.name}`);
        continue;
      }
      try {
        validatePreviousLinkOwnership(
          repoRoot,
          gstackRoot,
          row.name,
          row.source,
          row.mode,
          row.provenance,
          path.join(cursorHome, 'skills', row.name),
          desired.source,
          desired.mode,
          desired.provenance,
        );
        continue;
      } catch (error) {
        // An unverifiable relocation record is a collision, not ownership.
        // Bootstrap proceeds so reconciliation can preserve and exclude it;
        // doctor/verify must still report the invalid installed state.
        if (verifyMode) throw error;
        continue;
      }
    }
    try {
      validateStaleLink(
        repoRoot,
        row.name,
        row.source,
        row.mode,
        row.provenance,
        path.join(cursorHome, 'skills', row.name),
        gstackRoot,
      );
    } catch (error) {
      // Doctor/verify reports invalid historical provenance. Bootstrap/ensure
      // must continue to reconciliation, where the same shared guard prevents
      // unlink and emits the user-facing preservation warning.
      // Corruption inside an otherwise valid managed source namespace remains
      // a hard preflight failure and must never be downgraded to a collision.
      if (verifyMode || error.staleSourceUnsafe) throw error;
    }
  }
  for (const name of names) {
    inspectSkillDestination(
      path.join(cursorHome, 'skills', name),
      `Cursor managed skill destination ${name}`,
    );
  }
}

function preflight() {
  for (const entry of directoryPlan) {
    const exists = inspectDirectoryPath(entry.candidate, entry.label);
    if (exists) assertRealDirectory(entry.candidate, entry.label);
    else if (verifyMode && entry.create) throw new Error(`${entry.label} is missing: ${entry.candidate}`);
  }
  for (const entry of linkPlan) inspectManagedLinkDestination(entry);
  for (const entry of regularFilePlan) inspectRegularFileDestination(entry);
  inspectTemporaryManifests();
  if (command !== 'verify-boundary') inspectDynamicSkillDestinations();
}

function createPlannedDirectories() {
  // Creation begins only after every existing destination has passed preflight.
  for (const entry of directoryPlan.filter(({ create }) => create)) {
    let current = anchor;
    let userControlled = anchorUserControlled;
    let nextIsManagedSuffix = beginsManagedSuffixAfter(fs.lstatSync(anchor), userControlled);
    for (const segment of path.relative(anchor, entry.candidate).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) {
        fs.mkdirSync(current, { recursive: false, mode: 0o700 });
        stat = fs.lstatSync(current);
      }
      // Revalidate while walking the creation path. A component appearing
      // between preflight and mkdir cannot be traversed without passing the
      // same ownership/mode/type policy first.
      if (nextIsManagedSuffix) userControlled = true;
      userControlled = validatePathDirectory(stat, current, entry.label, userControlled);
      nextIsManagedSuffix = beginsManagedSuffixAfter(stat, userControlled);
    }
  }
}

function verifyPhysicalContainment() {
  const homeReal = fs.realpathSync(cursorHome);
  for (const entry of directoryPlan) {
    if (!fs.lstatSync(entry.candidate, { throwIfNoEntry: false })) continue;
    const real = fs.realpathSync(entry.candidate);
    if (!isWithin(real, homeReal) || (entry.candidate !== cursorHome && real === homeReal)) {
      throw new Error(`${entry.label} escapes Cursor home: ${real}`);
    }
  }
  return fs.realpathSync(path.join(cursorHome, 'skills'));
}

try {
  assertRealDirectory(trustedHome, 'trusted home');
  assertRealDirectory(repoRoot, 'cortex root');
  inspectAnchor();
  preflight();
  if (command === 'ensure') {
    createPlannedDirectories();
    preflight();
  }
  process.stdout.write(`${verifyPhysicalContainment()}\n`);
} catch (error) {
  console.error(`Cursor root guard failed: ${error.message}`);
  process.exit(1);
}
