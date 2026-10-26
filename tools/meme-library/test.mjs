import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

test('index generation writes a portable catalog into an explicit isolated library', async () => {
  const library = await mkdtemp(path.join(tmpdir(), 'meme-index-'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./index.mjs', import.meta.url)), '--library', library], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const raw = await readFile(path.join(library, 'index.json'), 'utf8');
  const index = JSON.parse(raw);
  assert.equal(index.entries.length, 98);
  assert.equal(index.entries.filter(entry => entry.semanticSource === 'unlabeled').length, 3);
  assert.equal(raw.includes(library), false);
  assert.ok(index.entries.every(entry => !entry.absolutePath && entry.path.startsWith('.memes/')));
});

test('validator rejects corrupt fixture bytes without consulting an installed application', async () => {
  const library = await mkdtemp(path.join(tmpdir(), 'meme-validate-'));
  const manifest = JSON.parse(await readFile(new URL('./download-manifest.json', import.meta.url)));
  const files = manifest.files;
  const entries = files.map(file => ({ ...file, path: '.memes/' + file.path, id: file.path }));
  await writeFile(path.join(library, 'index.json'), JSON.stringify({ entries }));
  const first = path.join(library, files[0].path);
  await mkdir(path.dirname(first), { recursive: true });
  await writeFile(first, 'corrupt fixture');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./validate.cjs', import.meta.url)), '--library', library], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AssertionError/);
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } }).png().toBuffer();
  assert.equal((await sharp(png).metadata()).width, 2);
});
