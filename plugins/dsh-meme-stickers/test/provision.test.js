import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, readFile, lstat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { provision } from '../scripts/provision.mjs';

test('dry run writes nothing; fresh copy preserves every original; existing target refuses', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-meme-provision-'));
  const library = await mkdtemp(path.join(os.tmpdir(), 'sticker-source-'));
  const bytes = Buffer.from('original synthetic fixture');
  await writeFile(path.join(library, 'example.png'), bytes);
  await writeFile(path.join(library, 'index.json'), JSON.stringify({ entries: [{ path: '.memes/example.png', sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  const result = await provision(workspace, { dryRun: true, library });
  assert.equal(result.images, 1);
  await assert.rejects(lstat(path.join(workspace, '.memes')), { code: 'ENOENT' });
  await provision(workspace, { library });
  const index = JSON.parse(await readFile(path.join(workspace, '.memes/index.json')));
  for (const entry of index.entries) {
    const bytes = await readFile(path.join(workspace, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  await assert.rejects(provision(workspace), /already exists/);
});

test('existing symlink and directory remain untouched', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-meme-link-'));
  const library = path.join(workspace, 'existing');
  await mkdir(library);
  await symlink(library, path.join(workspace, '.memes'));
  await assert.rejects(provision(workspace), /already exists/);
  assert.equal((await lstat(path.join(workspace, '.memes'))).isSymbolicLink(), true);
  await assert.rejects(provision('relative/workspace'), /absolute/);
});
