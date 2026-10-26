import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--library') || !option('--library') || option('--library').startsWith('--')) throw new Error('Provide --library with an explicit destination.');
const destination = path.resolve(option('--library'));
const workspace = args.includes('--workspace') ? path.resolve(option('--workspace')) : null;
const manifest = JSON.parse(await fs.readFile(new URL('./download-manifest.json', import.meta.url), 'utf8'));
const repository = manifest.repository;
const files = manifest.files.map(item => ({ path: item.path, sha: item.gitBlobSha1 }));
for (const item of files) if (path.isAbsolute(item.path) || item.path.split('/').includes('..')) throw new Error('Invalid manifest path');
const gitHash = data => crypto.createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex');
await fs.mkdir(destination, { recursive: true });
const previousIndex = path.join(destination, 'index.json');
try { await fs.copyFile(previousIndex, previousIndex + `.backup-${Date.now()}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
let cursor = 0;
const results = [];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < files.length) {
    const item = files[cursor++];
    const file = path.join(destination, item.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    let data;
    try { data = await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!data || gitHash(data) !== item.sha) {
      const encoded = item.path.split('/').map(encodeURIComponent).join('/');
      const url = `https://raw.githubusercontent.com/${repository}/${manifest.commit}/${encoded}`;
      let error;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${item.path}`);
          data = Buffer.from(await response.arrayBuffer());
          if (gitHash(data) !== item.sha) throw new Error(`Git blob mismatch: ${item.path}`);
           const resolvedTarget = path.resolve(file);
           if (!resolvedTarget.startsWith(destination + path.sep)) throw new Error('Invalid destination');
          await fs.writeFile(file + '.partial', data);
          await fs.rename(file + '.partial', file);
          error = null; break;
        } catch (failure) { error = failure; }
      }
      if (error) throw error;
    }
    results.push({ path: item.path, bytes: data.length, gitBlobSha1: item.sha, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    if (results.length % 10 === 0) console.log(`Verified ${results.length}/${files.length}`);
  }
}));
results.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
await fs.writeFile(path.join(destination, 'download-manifest.json'), JSON.stringify({ repository, commit: manifest.commit, files: results }, null, 2));
if (workspace) {
const link = path.join(workspace, '.memes');
try { if (await fs.realpath(link) !== await fs.realpath(destination)) throw new Error('Existing .memes points elsewhere'); }
catch (error) { if (error.code !== 'ENOENT') throw error; await fs.symlink(destination, link, 'dir'); }
console.log(JSON.stringify({ commit: manifest.commit, files: results.length, bytes: results.reduce((sum, item) => sum + item.bytes, 0), destination, symlink: await fs.realpath(link) }, null, 2));

}
