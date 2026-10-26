#!/usr/bin/env node
import { readFile, mkdir, lstat, copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Copy into a new workspace-local directory only; never overwrite a library or symlink. */
export async function provision(workspace, { dryRun = false, library } = {}) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('Provide an absolute --workspace path.');
  const workspaceInfo = await lstat(workspace);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) throw new Error('Workspace must be an existing real directory.');
  const target = path.join(workspace, '.memes');
  try { await lstat(target); throw new Error(`Destination already exists; left untouched: ${target}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!library || !path.isAbsolute(library)) throw new Error('Provide an absolute --library path.');
  const root = pathToFileURL(path.resolve(library) + path.sep);
  const index = JSON.parse(await readFile(new URL('index.json', root), 'utf8'));
  for (const entry of index.entries) {
    if (!entry.path.startsWith('.memes/') || entry.path.split('/').includes('..')) throw new Error('Invalid catalog path.');
    await access(new URL(entry.path.slice(7), root));
  }
  if (dryRun) return { dryRun: true, target, images: index.entries.length };
  await mkdir(target); // Exclusive creation: a competing installer causes an error.
  for (const entry of index.entries) {
    const relative = entry.path.slice(7);
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(new URL(relative, root), destination, constants.COPYFILE_EXCL);
  }
  await copyFile(new URL('index.json', root), path.join(target, 'index.json'), constants.COPYFILE_EXCL);
  return { dryRun: false, target, images: index.entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const position = args.indexOf('--workspace');
    const source = args.indexOf('--library');
    if (args.some((arg, i) => arg !== '--workspace' && arg !== '--library' && arg !== '--dry-run' && i !== position + 1 && i !== source + 1)) throw new Error('Unknown argument.');
    console.log(JSON.stringify(await provision(position < 0 ? undefined : args[position + 1], { dryRun: args.includes('--dry-run'), library: source < 0 ? undefined : args[source + 1] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
