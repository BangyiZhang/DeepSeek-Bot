const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const position = process.argv.indexOf('--library');
if (position < 0 || !process.argv[position + 1]) throw new Error('Provide --library with an explicit destination.');
const root = path.resolve(process.argv[position + 1]);
const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'download-manifest.json'), 'utf8'));
(async () => {
  assert.equal(index.entries.length, manifest.files.length);
  assert.equal(new Set(index.entries.map(entry => entry.id)).size, index.entries.length);
  const ids = new Set(index.entries.map(entry => entry.id));
  const dimensions = [];
  let pages = 0;
  for (const entry of index.entries) {
    const filename = path.resolve(root, entry.path.slice(7));
    assert.ok(entry.path.startsWith('.memes/') && !entry.path.split('/').includes('..'));
    assert.ok(filename.startsWith(root + path.sep));
    const data = fs.readFileSync(filename);
    assert.equal(data.length, entry.bytes);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), entry.sha256);
    const git = crypto.createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex');
    assert.equal(git, entry.source.gitBlobSha1);
    const metadata = await sharp(data, { animated: true, limitInputPixels: false }).metadata();
    // Decode every animation frame to catch truncated or corrupt compressed payloads.
    await sharp(data, { animated: true, limitInputPixels: false }).stats();
    assert.ok(metadata.width > 0 && metadata.height > 0);
    assert.ok(entry.markdown.includes(`<${entry.path}>`));
    assert.ok(Array.isArray(entry.triggers) && entry.emotions.length > 0);
    dimensions.push({ id: entry.id, path: entry.path, format: metadata.format, width: metadata.width, height: metadata.pageHeight ?? metadata.height, frames: metadata.pages ?? 1 });
    pages += metadata.pages ?? 1;
  }
  for (const values of [...Object.values(index.byEmotion), ...Object.values(index.byTrigger)]) for (const id of values) assert.ok(ids.has(id));
  const report = { valid: true, images: dimensions.length, frames: pages, series: index.counts.bySeries, bytes: index.entries.reduce((sum, entry) => sum + entry.bytes, 0), semanticNeedsReview: index.counts.needsReview, dimensions };
  fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, dimensions: undefined }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
