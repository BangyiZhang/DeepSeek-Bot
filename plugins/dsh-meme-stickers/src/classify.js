const IMAGE = /\.(?:gif|png|jpe?g|webp|avif)$/i;

/** Match local library roots by complete path segments, never by image captions. */
export function isMemePath(input) {
  if (typeof input !== 'string' || /[\u0000-\u001f]/.test(input)) return false;
  const path = input.replaceAll('\\', '/');
  if (path.includes('://') || path.split('/').some(part => part === '..')) return false;
  return IMAGE.test(path) && /(?:^|\/)\.memes\/.+|(?:^|\/)\.ds-bot\/memes\/.+/.test(path);
}

/** api/file carries the original workspace path even when its URL is encoded. */
export function isMemeSource(source, baseURI) {
  if (typeof source !== 'string') return false;
  try {
    const base = new URL(baseURI);
    const url = new URL(source, base);
    const sameHost = url.protocol === base.protocol && url.host === base.host;
    if (!sameHost || !['http:', 'https:', 'file:', 'dsh-app:'].includes(url.protocol)) return false;
    if (url.protocol === 'dsh-app:' && url.hostname !== 'app') return false;
    if (/(?:^|\/)api\/file$/.test(url.pathname)) return isMemePath(url.searchParams.get('path'));
    // Direct local URLs are supported; arbitrary remote hosts are never classified.
    return isMemePath(decodeURIComponent(url.pathname));
  } catch { return false; }
}

export async function matchesFingerprint(source, { fetcher, crypto, sizes, hashes, maxBytes, signal }) {
  try {
    const response = await fetcher(source, { signal });
    if (!response.ok) return false;
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) return false;
    // Stream into a bounded buffer: a misleading header cannot trigger an unbounded read.
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return false; }
      chunks.push(value);
    }
    if (!sizes.has(size)) return false;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    return hashes.has(hex);
  } catch { return false; }
}
