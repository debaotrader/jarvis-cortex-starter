#!/usr/bin/env node

'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CURSOR_TREE_DIGEST_DOMAIN = 'jarvis-cursor-tree-digest';
export const CURSOR_TREE_DIGEST_VERSION = 1;

const TAG = Object.freeze({
  domain: 0x01,
  version: 0x02,
  recordCount: 0x03,
  record: 0x10,
  type: 0x11,
  path: 0x12,
  mode: 0x13,
  size: 0x14,
  content: 0x15,
});

function uint32(value) {
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32BE(value);
  return encoded;
}

function uint64(value) {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function frame(tag, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([Buffer.from([tag]), uint64(bytes.length), bytes]);
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sameFileSnapshot(expected, actual) {
  return expected.isFile() === actual.isFile()
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.nlink === actual.nlink
    && expected.mode === actual.mode
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs;
}

function assertStableRegularFile(expected, actual, label) {
  if (!actual.isFile() || actual.isSymbolicLink?.() || actual.nlink !== 1) {
    throw new Error(`${label} is not a private regular file with link count 1`);
  }
  if (!sameFileSnapshot(expected, actual)) {
    throw new Error(`${label} changed while it was being read`);
  }
}

function pathType(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

function snapshotAncestorPath(file) {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  const components = path.relative(parsed.root, path.dirname(absolute)).split(path.sep).filter(Boolean);
  const snapshots = [];
  let current = parsed.root;
  const capture = (candidate) => {
    const stat = fs.lstatSync(candidate);
    return {
      candidate,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      type: pathType(stat),
      target: stat.isSymbolicLink() ? fs.readlinkSync(candidate) : null,
    };
  };
  snapshots.push(capture(current));
  for (const component of components) {
    current = path.join(current, component);
    snapshots.push(capture(current));
  }
  return snapshots;
}

function sameAncestorSnapshot(expected, actual) {
  return expected.candidate === actual.candidate
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.type === actual.type
    && expected.target === actual.target;
}

function assertAncestorPathStable(expected, file, label) {
  const actual = snapshotAncestorPath(file);
  if (actual.length !== expected.length
    || actual.some((entry, index) => !sameAncestorSnapshot(expected[index], entry))) {
    throw new Error(`${label} ancestor path changed while it was being read`);
  }
}

export function readStableRegularFile(file, options = {}) {
  const label = options.label || 'Cursor file';
  const ancestorPath = snapshotAncestorPath(file);
  const initial = options.expectedStat || fs.lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
    throw new Error(`${label} is not a private regular file with link count 1`);
  }
  options.validateStat?.(initial);
  options.beforeOpen?.({ file, stat: initial });
  assertAncestorPathStable(ancestorPath, file, label);

  let descriptor;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    assertStableRegularFile(initial, fs.fstatSync(descriptor), label);
    assertStableRegularFile(initial, fs.lstatSync(file), label);
    assertAncestorPathStable(ancestorPath, file, label);

    options.beforeRead?.({ file, descriptor, stat: initial });
    assertStableRegularFile(initial, fs.fstatSync(descriptor), label);
    assertStableRegularFile(initial, fs.lstatSync(file), label);
    assertAncestorPathStable(ancestorPath, file, label);

    const content = fs.readFileSync(descriptor);
    assertStableRegularFile(initial, fs.fstatSync(descriptor), label);
    assertStableRegularFile(initial, fs.lstatSync(file), label);
    assertAncestorPathStable(ancestorPath, file, label);
    if (content.length !== initial.size) {
      throw new Error(`${label} size changed while it was being read`);
    }
    return content;
  } catch (error) {
    throw new Error(`${label} could not be read safely: ${error.message}`, { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function validateStableTreeFiles(rootArg, options = {}) {
  const root = path.resolve(rootArg);
  const label = options.label || 'Cursor tree';
  const rootReal = fs.realpathSync(root);

  function visit(current, relative) {
    const stat = fs.lstatSync(current);
    const display = relative || '.';
    if (stat.isSymbolicLink()) {
      if (options.allowSymlinks) return;
      throw new Error(`${label} contains a symlink: ${display}`);
    }
    if (!isWithin(fs.realpathSync(current), rootReal)) {
      throw new Error(`${label} resolves outside its root: ${display}`);
    }
    if (stat.isFile()) {
      options.validateEntry?.({ absolute: current, relative, stat, type: 'file' });
      readStableRegularFile(current, { label: `${label} file ${display}`, expectedStat: stat });
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} contains an unsupported filesystem type: ${display}`);
    }
    options.validateEntry?.({ absolute: current, relative, stat, type: 'directory' });
    const names = fs.readdirSync(current).sort(compareNames);
    for (const name of names) visit(path.join(current, name), relative ? `${relative}/${name}` : name);
    const after = fs.lstatSync(current);
    if (!after.isDirectory() || after.isSymbolicLink()
      || stat.dev !== after.dev || stat.ino !== after.ino || stat.mode !== after.mode
      || stat.nlink !== after.nlink || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} directory changed while it was being walked: ${display}`);
    }
  }

  visit(root, '');
}

function serializeRecord(record) {
  const fields = [
    frame(TAG.type, Buffer.from(record.type)),
    frame(TAG.path, Buffer.from(record.relative, 'utf8')),
    frame(TAG.mode, uint32(record.mode)),
  ];
  if (record.type === 'file') {
    fields.push(frame(TAG.size, uint64(record.content.length)));
    fields.push(frame(TAG.content, record.content));
  }
  return frame(TAG.record, Buffer.concat(fields));
}

export function digestCanonicalTree(rootArg, options = {}) {
  const root = path.resolve(rootArg);
  const label = options.label || 'Cursor tree';
  const excludedRootEntries = new Set(options.excludedRootEntries || []);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} root is not a real directory`);
  }
  const rootReal = fs.realpathSync(root);
  const records = [];

  function visit(current, relative, excluded = false) {
    const stat = fs.lstatSync(current);
    const display = relative || '.';
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink: ${display}`);
    }
    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
    if (!type) {
      throw new Error(`${label} contains an unsupported filesystem type: ${display}`);
    }
    if (!isWithin(fs.realpathSync(current), rootReal)) {
      throw new Error(`${label} resolves outside its root: ${display}`);
    }
    options.validateEntry?.({ absolute: current, relative, stat, type });

    if (excluded) {
      if (type !== 'file') {
        throw new Error(`${label} excluded entry is not a regular file: ${display}`);
      }
      readStableRegularFile(current, {
        label: `${label} excluded file ${display}`,
        expectedStat: stat,
      });
      return;
    }

    if (type === 'directory') {
      records.push({ type, relative, mode: stat.mode & 0o7777 });
      for (const name of fs.readdirSync(current).sort(compareNames)) {
        const childRelative = relative ? `${relative}/${name}` : name;
        visit(
          path.join(current, name),
          childRelative,
          !relative && excludedRootEntries.has(name),
        );
      }
      const after = fs.lstatSync(current);
      if (!after.isDirectory() || after.isSymbolicLink()
        || stat.dev !== after.dev || stat.ino !== after.ino
        || stat.mode !== after.mode || stat.nlink !== after.nlink
        || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
        throw new Error(`${label} directory changed while it was being walked: ${display}`);
      }
      return;
    }

    let content = readStableRegularFile(current, {
      label: `${label} file ${display}`,
      expectedStat: stat,
      beforeOpen: () => options.beforeOpenFile?.({
        absolute: current,
        relative,
        stat,
      }),
      beforeRead: ({ descriptor }) => options.beforeReadFile?.({
        absolute: current,
        relative,
        stat,
        descriptor,
      }),
    });
    if (options.transformFile) {
      const transformed = options.transformFile({
        absolute: current,
        relative,
        content,
        stat,
      });
      if (transformed !== undefined) content = Buffer.from(transformed);
    }
    records.push({
      type,
      relative,
      mode: stat.mode & 0o7777,
      content,
    });
  }

  // Walk and validate the complete tree before any bytes reach the hash.
  visit(root, '');

  const hash = crypto.createHash('sha256');
  hash.update(frame(TAG.domain, Buffer.from(CURSOR_TREE_DIGEST_DOMAIN)));
  hash.update(frame(TAG.version, uint32(CURSOR_TREE_DIGEST_VERSION)));
  hash.update(frame(TAG.recordCount, uint64(records.length)));
  for (const record of records) hash.update(serializeRecord(record));
  return hash.digest('hex');
}
