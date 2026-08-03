#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { rawLinkTargetIsExact } from './cursor-link-target.mjs';
import { parseSkillFrontmatterName } from './cursor-skill-frontmatter.mjs';
import { validateLinkSkillSource } from './cursor-skill-source-guard.mjs';
import { readStableRegularFile } from './cursor-tree-digest.mjs';

const [root, reconcileFlag, installedManifestPath, desiredManifestRaw, repoRootArg] = process.argv.slice(2);
const MANAGED_SKILL_MARKER = '.jarvis-cortex-skill.json';
const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
if (!root) {
  console.error('usage: cursor-skills-audit.mjs <skills-root> [--manifests <installed-path> <desired-raw> <repo-root>]');
  process.exit(2);
}
if (reconcileFlag !== undefined && (reconcileFlag !== '--manifests'
  || !installedManifestPath || desiredManifestRaw === undefined || !repoRootArg)) {
  console.error('invalid manifest reconciliation arguments');
  process.exit(2);
}

const skills = [];
const backups = [];
const cycles = [];
const dangling = [];
const escapes = [];
const errors = [];
const deferredExternalSkills = [];
let rootReal = null;

function isBackupSegment(segment) {
  return /^(?:\.?backups?|.+\.backup(?:\..+)?)$/i.test(segment);
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
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

function physicalPathHasBackupSegment(candidate) {
  if (!rootReal) return false;
  const resolved = path.resolve(candidate);
  const boundary = commonAncestor(rootReal, resolved);
  return path.relative(boundary, resolved).split(path.sep).filter(Boolean).some(isBackupSegment);
}

function walk(current, logicalRelative, ancestors, inheritedBackup = false) {
  const lstat = fs.lstatSync(current);

  let stat = lstat;
  let real = current;
  if (lstat.isSymbolicLink()) {
    try {
      real = fs.realpathSync(current);
      stat = fs.statSync(current);
    } catch (error) {
      if (error?.code === 'ELOOP') cycles.push(logicalRelative || '.');
      else dangling.push(logicalRelative || '.');
      return;
    }
    if (stat.isDirectory() && logicalRelative && !isWithin(real, rootReal)) {
      // Keep following for cycle/backup discovery, but expose the boundary
      // crossing even when the external tree contains no SKILL.md.
      escapes.push(logicalRelative);
    }
  }

  if (!stat.isDirectory()) {
    if (!lstat.isSymbolicLink() && stat.isFile()) {
      try {
        const fileReal = fs.realpathSync(current);
        if (isWithin(fileReal, rootReal)) {
          readStableRegularFile(current, {
            label: `Cursor skills asset ${logicalRelative || '.'}`,
            expectedStat: lstat,
          });
        }
      } catch (error) {
        errors.push({
          path: logicalRelative || '.',
          code: 'unsafe-regular-file',
          message: error.message,
        });
      }
    }
    return;
  }
  try {
    real = fs.realpathSync(current);
  } catch (error) {
    if (error?.code === 'ELOOP') cycles.push(logicalRelative || '.');
    else dangling.push(logicalRelative || '.');
    return;
  }
  if (ancestors.has(real)) {
    cycles.push(logicalRelative || '.');
    return;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(real);
  const logicalBackup = logicalRelative.split(path.sep).filter(Boolean).some(isBackupSegment);
  const backupContext = inheritedBackup || logicalBackup || physicalPathHasBackupSegment(real);
  for (const entry of fs.readdirSync(current).sort()) {
    const child = path.join(current, entry);
    const relative = logicalRelative ? path.join(logicalRelative, entry) : entry;
    if (entry === 'SKILL.md') {
      const skillLstat = fs.lstatSync(child);
      let skillReal;
      let skillStat = skillLstat;
      if (skillLstat.isSymbolicLink()) {
        try {
          skillReal = fs.realpathSync(child);
          skillStat = fs.statSync(child);
        } catch (error) {
          if (backupContext) backups.push(relative);
          if (error?.code === 'ELOOP') cycles.push(relative);
          else dangling.push(relative);
          continue;
        }
        const skillTargetBackup = physicalPathHasBackupSegment(skillReal);
        if (backupContext || skillTargetBackup) backups.push(relative);
      } else {
        skillReal = fs.realpathSync(child);
        if (backupContext || physicalPathHasBackupSegment(skillReal)) backups.push(relative);
      }
      // Recheck containment for every SKILL.md, not only SKILL.md symlinks.
      // A regular file reached through an external directory symlink is still
      // outside the native skills root and must not be parsed as trusted YAML.
      if (!isWithin(skillReal, rootReal)) {
        escapes.push(relative);
        if (skillStat.isFile()) deferredExternalSkills.push({ file: child, relative });
        continue;
      }
      if (!skillStat.isFile()) continue;
      const metadata = parseSkillFrontmatterName(child, relative);
      if (metadata.error) errors.push(metadata.error);
      else skills.push({ name: metadata.name, path: relative });
      continue;
    }
    walk(child, relative, nextAncestors, backupContext);
  }
}

if (fs.lstatSync(root, { throwIfNoEntry: false })) {
  rootReal = fs.realpathSync(root);
  walk(root, '', new Set());
}

for (const collection of [backups, cycles, dangling, escapes]) {
  collection.splice(0, collection.length, ...new Set(collection));
  collection.sort();
}
const allowedEscapes = [];
const unapprovedEscapes = [];
const reconciliationErrors = [];

function parseManifest(raw, label) {
  const rows = new Map();
  const allowedPairs = new Set([
    'link:cortex', 'link:hm', 'link:caveman', 'cursor-copy:cortex', 'gstack-copy:gstack',
  ]);
  for (const line of raw.split(/\n/).filter(Boolean)) {
    const fields = line.split('\t');
    if (fields.length !== 4) {
      reconciliationErrors.push({ code: 'invalid-manifest', message: `${label} manifest has malformed row` });
      continue;
    }
    const [name, source, mode, provenance] = fields;
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..'
      || !path.isAbsolute(source) || !allowedPairs.has(`${mode}:${provenance}`)) {
      reconciliationErrors.push({ code: 'invalid-manifest', message: `${label} manifest row is invalid: ${name || '<empty>'}` });
      continue;
    }
    if (rows.has(name)) {
      reconciliationErrors.push({ code: 'invalid-manifest', message: `${label} manifest duplicates ${name}` });
      continue;
    }
    rows.set(name, { name, source, mode, provenance, line });
  }
  return rows;
}

function reconcileEscapes() {
  if (reconcileFlag !== '--manifests') {
    unapprovedEscapes.push(...escapes);
    return;
  }
  let installedRaw = '';
  try {
    const stat = fs.lstatSync(installedManifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a real regular file');
    installedRaw = readStableRegularFile(installedManifestPath, {
      label: 'Cursor installed skill manifest',
      expectedStat: stat,
    }).toString('utf8');
  } catch (error) {
    reconciliationErrors.push({
      code: 'installed-manifest-unreadable',
      message: `installed manifest cannot be trusted: ${error.message}`,
    });
  }
  const installed = parseManifest(installedRaw, 'installed');
  const desired = parseManifest(desiredManifestRaw, 'desired');
  const sourceCache = new Map();

  function trustedSource(name) {
    if (sourceCache.has(name)) return sourceCache.get(name);
    let trusted = null;
    try {
      const wanted = desired.get(name);
      const actual = installed.get(name);
      if (!wanted || !actual || wanted.line !== actual.line || wanted.mode !== 'link') {
        throw new Error('entry is not an identical installed+desired link row');
      }
      const sourceReal = fs.realpathSync(wanted.source);
      if (sourceReal !== wanted.source) throw new Error('manifest source is not canonical');
      const guardedReal = validateLinkSkillSource(repoRootArg, wanted.source, `Cursor link skill ${name}`);
      if (guardedReal !== sourceReal) throw new Error('source guard returned different provenance');
      const topLevel = path.join(root, name);
      const topStat = fs.lstatSync(topLevel, { throwIfNoEntry: false });
      if (!topStat?.isSymbolicLink()) {
        throw new Error('installed top-level entry is not a symlink');
      }
      if (!rawLinkTargetIsExact(topLevel, wanted.source)
        || fs.realpathSync(topLevel) !== sourceReal) {
        throw new Error('installed top-level symlink does not target the manifest source exactly');
      }
      trusted = sourceReal;
    } catch {
      trusted = null;
    }
    sourceCache.set(name, trusted);
    return trusted;
  }

  for (const row of installed.values()) {
    const topLevel = path.join(root, row.name);
    try {
      const topStat = fs.lstatSync(topLevel, { throwIfNoEntry: false });
      if (!topStat) throw new Error('installed target is missing');
      if (row.mode === 'link') {
        if (!trustedSource(row.name)) {
          throw new Error('installed link is not an identical trusted desired tuple');
        }
      } else if (!topStat.isDirectory() || topStat.isSymbolicLink()) {
        throw new Error('installed copy target is not a real directory');
      }
      const immediateSkill = path.join(topLevel, 'SKILL.md');
      const skillStat = fs.lstatSync(immediateSkill, { throwIfNoEntry: false });
      if (!skillStat || !skillStat.isFile() || skillStat.isSymbolicLink()) {
        throw new Error('immediate installed SKILL.md is missing or unsafe');
      }
      const metadata = parseSkillFrontmatterName(
        immediateSkill,
        path.join(row.name, 'SKILL.md'),
      );
      if (metadata.error) throw new Error(`${metadata.error.code}: ${metadata.error.message}`);
      if (metadata.name !== row.name) {
        reconciliationErrors.push({
          code: 'installed-name-mismatch',
          message: `installed manifest target ${row.name} declares frontmatter name ${metadata.name}`,
        });
      }
    } catch (error) {
      reconciliationErrors.push({
        code: 'installed-name-unverifiable',
        message: `installed manifest target ${row.name} identity cannot be verified: ${error.message}`,
      });
    }
  }

  // A Jarvis marker is an ownership claim even when bootstrap preserved the
  // directory but dropped an unverifiable stale manifest row. Reconcile every
  // top-level claim independently so a missing source cannot become doctor-green.
  for (const name of fs.readdirSync(root).sort()) {
    const topLevel = path.join(root, name);
    const topStat = fs.lstatSync(topLevel, { throwIfNoEntry: false });
    if (!topStat) continue;
    const markerPath = path.join(topLevel, MANAGED_SKILL_MARKER);
    let markerStat;
    try {
      markerStat = fs.lstatSync(markerPath, { throwIfNoEntry: false });
    } catch (error) {
      if (error?.code === 'ENOTDIR') continue;
      reconciliationErrors.push({
        code: 'managed-marker-invalid',
        name,
        message: `Jarvis marker for ${name} cannot be inspected: ${error.message}`,
      });
      continue;
    }
    if (!markerStat) continue;
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1
      || (currentUid !== null && markerStat.uid !== currentUid)
      || (markerStat.mode & 0o777) !== 0o600) {
      reconciliationErrors.push({
        code: 'managed-marker-invalid',
        name,
        message: `Jarvis marker for ${name} is not a private owned regular file`,
      });
      continue;
    }
    let marker;
    try {
      marker = JSON.parse(readStableRegularFile(markerPath, {
        label: `Jarvis marker for ${name}`,
        expectedStat: markerStat,
      }).toString('utf8'));
    } catch (error) {
      reconciliationErrors.push({
        code: 'managed-marker-invalid',
        name,
        message: `Jarvis marker for ${name} is not valid JSON: ${error.message}`,
      });
      continue;
    }
    if (marker.owner !== 'jarvis-cortex') continue;

    const actual = installed.get(name);
    const wanted = desired.get(name);
    if (!actual || !wanted || actual.line !== wanted.line
      || !new Set(['cursor-copy:cortex', 'gstack-copy:gstack'])
        .has(`${actual.mode}:${actual.provenance}`)) {
      reconciliationErrors.push({
        code: 'managed-marker-orphan',
        name,
        message: `Jarvis marker for ${name} has no identical installed+desired copy tuple`,
      });
      continue;
    }

    let sourceReal = null;
    try {
      sourceReal = fs.realpathSync(actual.source);
    } catch {
      // The exact desired catalog cannot authorize an unreadable source.
    }
    if (!topStat.isDirectory() || topStat.isSymbolicLink()
      || marker.name !== name
      || marker.mode !== actual.mode
      || marker.provenance !== actual.provenance
      || marker.sourcePath !== actual.source
      || marker.sourceReal !== sourceReal) {
      reconciliationErrors.push({
        code: 'managed-marker-mismatch',
        name,
        message: `Jarvis marker for ${name} does not match its installed+desired tuple`,
      });
    }
  }

  for (const escaped of escapes) {
    const [name] = escaped.split(path.sep);
    const sourceReal = trustedSource(name);
    if (!sourceReal) {
      unapprovedEscapes.push(escaped);
      continue;
    }
    try {
      const escapedReal = fs.realpathSync(path.join(root, escaped));
      if (!isWithin(escapedReal, sourceReal)) throw new Error('escape leaves manifest source');
      allowedEscapes.push(escaped);
    } catch {
      unapprovedEscapes.push(escaped);
    }
  }
}

reconcileEscapes();
for (const collection of [allowedEscapes, unapprovedEscapes]) collection.sort();

// Metadata outside the skills root is parsed only after the exact top-level
// link has passed installed+desired manifest reconciliation and source guard.
// This preserves recursive duplicate detection for deliberate managed links
// without trusting arbitrary user-controlled escapes.
const allowedEscapeSet = new Set(allowedEscapes);
for (const deferred of deferredExternalSkills) {
  if (!allowedEscapeSet.has(deferred.relative)) continue;
  const metadata = parseSkillFrontmatterName(deferred.file, deferred.relative);
  if (metadata.error) errors.push(metadata.error);
  else skills.push({ name: metadata.name, path: deferred.relative });
}

const byName = new Map();
for (const skill of skills) {
  if (!byName.has(skill.name)) byName.set(skill.name, []);
  byName.get(skill.name).push(skill.path);
}
const duplicates = [...byName.entries()]
  .filter(([, paths]) => paths.length > 1)
  .map(([name, paths]) => ({ name, paths }))
  .sort((a, b) => a.name.localeCompare(b.name));
errors.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));

process.stdout.write(`${JSON.stringify({
  skills,
  backups,
  duplicates,
  cycles,
  dangling,
  escapes,
  allowedEscapes,
  unapprovedEscapes,
  reconciliationErrors,
  errors,
})}\n`);
