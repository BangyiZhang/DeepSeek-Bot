import { isMemeSource, matchesFingerprint } from './classify.js';

export const STYLES = `
img[data-dsh-meme-sized="image"],button[data-dsh-meme-sized="wrapper"] {
  width:auto!important;height:auto!important;max-width:140px!important;max-height:140px!important;
  object-fit:contain!important;border-radius:8px!important;display:inline-block!important;
}
.bt-bubble[data-dsh-meme-bubble="true"] {
  background:transparent!important;box-shadow:none!important;border:none!important;padding:0!important;
}
`;

/** Observe only image provenance changes; never replace the host's image/loading handlers. */
export function install(document, { fingerprintBlobs = false, fingerprints = [] } = {}) {
  const window = document.defaultView;
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-meme-stickers';
  style.textContent = STYLES;
  document.head.append(style);
  const owned = new Set();
  const bubbles = new Set();
  const pendingBubbles = new Set();
  // Only transparent structural wrappers and classified sticker buttons are allowed.
  const stickerOnly = bubble => {
    let stickers = 0;
    const walk = node => {
      if (node.nodeType === 3) return node.textContent.trim() === '';
      if (node.nodeType !== 1) return node.nodeType === 8;
      if (node.tagName === 'IMG') {
        if (node.dataset.dshMemeSized !== 'image') return false;
        stickers++;
        return true;
      }
      if (!['DIV', 'SPAN', 'P', 'BR', 'A', 'BUTTON'].includes(node.tagName)) return false;
      if (node.tagName === 'BUTTON' && node.dataset.dshMemeSized !== 'wrapper') return false;
      if (node.matches('[role="dialog"],dialog,[hidden],[aria-hidden="true"]')) return false;
      return [...node.childNodes].every(walk);
    };
    return [...bubble.childNodes].every(walk) && stickers > 0;
  };
  const updateBubbles = () => {
    for (const bubble of pendingBubbles) {
      if (bubble.isConnected && bubble.matches('.bt-bubble') && !bubble.closest('[role="dialog"],dialog') && stickerOnly(bubble)) {
        bubble.setAttribute('data-dsh-meme-bubble', 'true');
        bubbles.add(bubble);
      } else if (bubbles.delete(bubble)) bubble.removeAttribute('data-dsh-meme-bubble');
    }
    pendingBubbles.clear();
    for (const bubble of bubbles) if (!bubble.isConnected) {
      bubble.removeAttribute('data-dsh-meme-bubble');
      bubbles.delete(bubble);
    }
  };
  const queueBubble = node => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    const bubble = element?.closest('.bt-bubble');
    if (bubble) pendingBubbles.add(bubble);
    if (bubbles.has(element)) pendingBubbles.add(element);
  };
  const pending = [];
  const cache = new Map();
  const controllers = new Set();
  let active = 0;
  let disposed = false;
  const sizes = new Set(fingerprints.map(file => file.bytes));
  const hashes = new Set(fingerprints.map(file => file.sha256));
  const maxBytes = Math.max(0, ...sizes);
  const excluded = image => Boolean(image.closest('[role="dialog"],dialog'));
  const mark = (element, kind) => {
    if (element.hasAttribute('data-dsh-meme-sized') && !owned.has(element)) return;
    element.dataset.dshMemeSized = kind;
    owned.add(element);
  };
  const unmark = element => {
    if (!owned.delete(element)) return;
    element.removeAttribute('data-dsh-meme-sized');
  };
  const updateWrapper = wrapper => {
    if (!wrapper || wrapper.tagName !== 'BUTTON') return;
    const children = [...wrapper.children];
    if (children.length === 1 && children[0].tagName === 'IMG' && owned.has(children[0])) mark(wrapper, 'wrapper');
    else unmark(wrapper);
  };
  const apply = (image, yes) => {
    if (disposed || !image.isConnected) return;
    if (yes && !excluded(image)) mark(image, 'image');
    else unmark(image);
    updateWrapper(image.parentElement);
    queueBubble(image);
    updateBubbles();
  };
  const pump = () => {
    while (!disposed && active < 2 && pending.length) {
      const { source, settle } = pending.shift();
      active++;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = window.setTimeout(() => controller.abort(), 3000);
      matchesFingerprint(source, { fetcher: window.fetch.bind(window), crypto: window.crypto, sizes, hashes, maxBytes, signal: controller.signal })
        .then(settle).finally(() => {
          window.clearTimeout(timer);
          controllers.delete(controller);
          active--;
          pump();
        });
    }
  };
  const fingerprint = source => {
    if (cache.has(source)) return cache.get(source);
    // A hard per-install budget prevents repeated virtualized rows from filling memory.
    if (cache.size >= 256) return Promise.resolve(false);
    const result = new Promise(settle => pending.push({ source, settle }));
    cache.set(source, result);
    pump();
    return result;
  };
  const visit = image => {
    const source = image.getAttribute('src') ?? '';
    const explicit = image.getAttribute('data-dsh-meme-sticker') === 'true';
    const known = explicit || isMemeSource(source, document.baseURI);
    apply(image, known);
    if (!known && !excluded(image) && fingerprintBlobs && source.startsWith(`blob:${window.location.origin}/`) && window.fetch && window.crypto?.subtle) {
      void fingerprint(source).then(yes => {
        if (image.getAttribute('src') === source) apply(image, yes);
      });
    }
  };
  const scan = node => {
    if (node.nodeType !== 1) return;
    if (node.matches('img')) visit(node);
    node.querySelectorAll('img').forEach(visit);
  };
  const observer = new window.MutationObserver(records => {
    for (const record of records) {
      queueBubble(record.target);
      if (record.type === 'attributes') scan(record.target);
      else if (record.type === 'childList') {
        record.addedNodes.forEach(scan);
        updateWrapper(record.target);
      }
    }
    // Release detached rows, including buttons whose image was moved elsewhere.
    for (const element of owned) if (!element.isConnected) unmark(element);
    updateBubbles();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'data-dsh-meme-sticker', 'role', 'open', 'hidden', 'aria-hidden', 'class'] });
  scan(document.documentElement);
  return () => {
    disposed = true;
    observer.disconnect();
    controllers.forEach(controller => controller.abort());
    pending.splice(0).forEach(({ settle }) => settle(false));
    [...owned].forEach(unmark);
    for (const bubble of bubbles) bubble.removeAttribute('data-dsh-meme-bubble');
    bubbles.clear();
    pendingBubbles.clear();
    cache.clear();
    style.remove();
  };
}

export function apply(ctx, config = {}) {
  ctx.effect(() => install(document, config));
}
