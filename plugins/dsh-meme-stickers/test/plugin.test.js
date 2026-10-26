import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { isMemePath, isMemeSource, matchesFingerprint } from '../src/classify.js';
// Load the actual built factory so tests also check the real ModuleLoader registration envelope.
const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
let plugin;
vm.runInNewContext(code, { window: { __ModuleLoader__: { load(row) {
  assert.equal(row.id, 'dsh-meme-stickers');
  plugin = row.factory(() => { throw new Error('Unexpected external dependency'); });
} } }, AbortController, Set, Map, Uint8Array, URL });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('bubble removal is limited to sticker-only messages and follows streamed text changes', async () => {
  const sticker = '<button><img src="/api/file?path=%2Fw%2F.memes%2Fa.gif"></button>';
  const dom = new JSDOM(`<div id="only" class="bt-bubble"><div><p>${sticker}</p><p>${sticker}</p></div></div><div id="mixed" class="bt-bubble"><p>Hello ${sticker}</p></div><div id="photo" class="bt-bubble"><img src="/api/file?path=%2Fw%2Fscreenshot.png"></div><div id="text" class="bt-bubble">Hello</div><div id="controls" class="bt-bubble">${sticker}<button>Retry</button></div>`, { url: 'http://localhost/' });
  const doc = dom.window.document;
  const stop = plugin.install(doc);
  const only = doc.querySelector('#only');
  assert.equal(only.dataset.dshMemeBubble, 'true');
  for (const id of ['mixed', 'photo', 'text', 'controls']) assert.equal(doc.querySelector('#' + id).hasAttribute('data-dsh-meme-bubble'), false);
  const text = doc.createTextNode('streamed caption');
  only.append(text);
  await settle();
  assert.equal(only.hasAttribute('data-dsh-meme-bubble'), false);
  text.data = '   ';
  await settle();
  assert.equal(only.dataset.dshMemeBubble, 'true');
  only.querySelector('img').src = '/api/file?path=%2Fw%2Fscreenshot.png';
  await settle();
  assert.equal(only.hasAttribute('data-dsh-meme-bubble'), false);
  only.querySelector('img').src = '/api/file?path=%2Fw%2F.memes%2Fa.gif';
  await settle();
  assert.equal(only.dataset.dshMemeBubble, 'true');
  stop();
  assert.equal(doc.querySelector('[data-dsh-meme-bubble]'), null);
  dom.window.close();
});

test('classifies complete local roots and encoded api/file path only', () => {
  const base = 'http://127.0.0.1:55060/';
  for (const value of ['.memes/a.gif', '/w/.memes/a.png', '/example/.ds-bot/memes/a.jpg']) assert.equal(isMemePath(value), true);
  for (const value of ['.memes-other/a.gif', '/w/photos/a.jpg', '/w/.memes/../photo.jpg', 'https://outside/.memes/a.gif']) assert.equal(isMemePath(value), false);
  assert.equal(isMemeSource('/api/file?path=%2Fw%2F.memes%2Fa.gif', base), true);
  assert.equal(isMemeSource('/api/file?path=%2Fexample%2F.ds-bot%2Fmemes%2Fa.gif', base), true);
  assert.equal(isMemeSource('https://example.com/.memes/a.gif', base), false);
  assert.equal(isMemeSource('blob:http://127.0.0.1:55060/random', base), false);
  assert.equal(isMemeSource('/api/file?path=%2Fw%2F.memes-other%2Fa.gif', base), false);
  assert.equal(isMemeSource('/api/file?path=%ZZ', base), false);
  assert.equal(isMemeSource('dsh-app://app/api/file?path=%2Fw%2F.memes%2Fa.gif', 'dsh-app://app/'), true);
  assert.equal(isMemeSource('dsh-app://other/api/file?path=%2Fw%2F.memes%2Fa.gif', 'dsh-app://app/'), false);
});

test('sizes only classified images and wrappers; restores reused images and disposal', async () => {
  const dom = new JSDOM('<button><img src="/api/file?path=%2Fw%2F.memes%2Fa.gif"></button><img id="photo" src="/api/file?path=%2Fw%2Fphoto.png"><div role="dialog"><img src="/api/file?path=%2Fw%2F.memes%2Fa.gif"></div>', { url: 'http://localhost/' });
  const doc = dom.window.document;
  const stop = plugin.install(doc);
  const img = doc.querySelector('img');
  assert.equal(img.dataset.dshMemeSized, 'image');
  assert.equal(img.parentElement.dataset.dshMemeSized, 'wrapper');
  assert.equal(doc.querySelector('#photo').hasAttribute('data-dsh-meme-sized'), false);
  assert.equal(doc.querySelector('[role=dialog] img').hasAttribute('data-dsh-meme-sized'), false);
  const css = doc.querySelector('style').textContent;
  for (const text of ['max-width:140px', 'max-height:140px', 'object-fit:contain', 'border-radius:8px', 'display:inline-block']) assert.ok(css.includes(text));
  img.src = '/api/file?path=%2Fw%2Fphoto.jpg';
  await settle();
  assert.equal(img.hasAttribute('data-dsh-meme-sized'), false);
  assert.equal(img.parentElement.hasAttribute('data-dsh-meme-sized'), false);
  const explicit = doc.createElement('img');
  explicit.src = 'blob:http://localhost/explicit';
  explicit.dataset.dshMemeSticker = 'true';
  doc.body.append(explicit);
  await settle();
  assert.equal(explicit.dataset.dshMemeSized, 'image');
  stop();
  assert.equal(doc.querySelector('[data-dsh-meme-sized]'), null);
  assert.equal(doc.querySelector('style'), null);
  assert.equal(explicit.dataset.dshMemeSticker, 'true');
  dom.window.close();
});

test('fingerprint helper matches exact bytes and enforces the byte cap', async () => {
  const data = new Uint8Array([1, 2, 3]);
  const options = { fetcher: async () => new Response(data), crypto: webcrypto, sizes: new Set([3]), hashes: new Set([createHash('sha256').update(data).digest('hex')]), maxBytes: 3 };
  assert.equal(await matchesFingerprint('blob:test', options), true);
  assert.equal(await matchesFingerprint('blob:test', { ...options, maxBytes: 2 }), false);
  assert.equal(await matchesFingerprint('blob:test', { ...options, hashes: new Set() }), false);
});
