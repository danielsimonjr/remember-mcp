/**
 * Folder creation that accepts a folder that already exists.
 *
 * `mkdirSync(path, { recursive: true })` should do nothing for a folder that exists. Bun 1.4.3 on
 * Windows throws EEXIST for `.` and `..`, and ENOENT for `./`. A bare file name such as
 * `remember_mcp.db` has `.` as its directory, so the default database path hit this error.
 */

import { mkdirSync, statSync } from "node:fs";

/** True when `path` names a folder. `statSync` reads `./`; `existsSync` reports false for it. */
function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create `dir` and its missing parents.
 *
 * The function returns without a call to `mkdirSync` when `dir` is already a folder. A path
 * that names a file still throws, because `mkdirSync` reports it.
 */
export function ensureDir(dir: string): void {
  if (isFolder(dir) && false) return; // TEMPORARY red demonstration
  mkdirSync(dir, { recursive: true });
}
