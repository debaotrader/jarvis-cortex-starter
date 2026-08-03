#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Compare a symlink's stored target without resolving or normalizing it.
 *
 * The only accepted spellings are the canonical absolute source path and the
 * exact path.relative() spelling from the destination directory. Callers must
 * separately validate the source and resolved target types/containment.
 */
export function rawLinkTargetIsExact(candidate, expectedCanonical) {
  if (!path.isAbsolute(expectedCanonical) || path.normalize(expectedCanonical) !== expectedCanonical) {
    return false;
  }
  let rawTarget;
  try {
    rawTarget = fs.readlinkSync(candidate);
  } catch {
    return false;
  }
  let destinationDirectory;
  try {
    destinationDirectory = fs.realpathSync(path.dirname(candidate));
  } catch {
    return false;
  }
  const expectedRelative = path.relative(destinationDirectory, expectedCanonical);
  return rawTarget === expectedCanonical || rawTarget === expectedRelative;
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
  const [command, candidate, expectedCanonical] = process.argv.slice(2);
  if (command !== 'verify' || !candidate || !expectedCanonical) {
    console.error('usage: cursor-link-target.mjs verify <link> <canonical-absolute-source>');
    process.exit(2);
  }
  process.exit(rawLinkTargetIsExact(candidate, expectedCanonical) ? 0 : 1);
}
