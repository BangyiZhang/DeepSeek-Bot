window.__ModuleLoader__.load({id:"dsh-meme-stickers",factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.js
var client_exports = {};
__export(client_exports, {
  STYLES: () => STYLES,
  apply: () => apply,
  install: () => install
});
module.exports = __toCommonJS(client_exports);

// src/classify.js
var IMAGE = /\.(?:gif|png|jpe?g|webp|avif)$/i;
function isMemePath(input) {
  if (typeof input !== "string" || /[\u0000-\u001f]/.test(input)) return false;
  const path = input.replaceAll("\\", "/");
  if (path.includes("://") || path.split("/").some((part) => part === "..")) return false;
  return IMAGE.test(path) && /(?:^|\/)\.memes\/.+|(?:^|\/)\.ds-bot\/memes\/.+/.test(path);
}
function isMemeSource(source, baseURI) {
  if (typeof source !== "string") return false;
  try {
    const base = new URL(baseURI);
    const url = new URL(source, base);
    const sameHost = url.protocol === base.protocol && url.host === base.host;
    if (!sameHost || !["http:", "https:", "file:", "dsh-app:"].includes(url.protocol)) return false;
    if (url.protocol === "dsh-app:" && url.hostname !== "app") return false;
    if (/(?:^|\/)api\/file$/.test(url.pathname)) return isMemePath(url.searchParams.get("path"));
    return isMemePath(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}
async function matchesFingerprint(source, { fetcher, crypto, sizes, hashes, maxBytes, signal }) {
  try {
    const response = await fetcher(source, { signal });
    if (!response.ok) return false;
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) return false;
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
    if (!sizes.has(size)) return false;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    return hashes.has(hex);
  } catch {
    return false;
  }
}

// src/client.js
var STYLES = `
img[data-dsh-meme-sized="image"],button[data-dsh-meme-sized="wrapper"] {
  width:auto!important;height:auto!important;max-width:140px!important;max-height:140px!important;
  object-fit:contain!important;border-radius:8px!important;display:inline-block!important;
}
.bt-bubble[data-dsh-meme-bubble="true"] {
  background:transparent!important;box-shadow:none!important;border:none!important;padding:0!important;
}
`;
function install(document2, { fingerprintBlobs = false, fingerprints = [] } = {}) {
  const window = document2.defaultView;
  const style = document2.createElement("style");
  style.dataset.plugin = "dsh-meme-stickers";
  style.textContent = STYLES;
  document2.head.append(style);
  const owned = /* @__PURE__ */ new Set();
  const bubbles = /* @__PURE__ */ new Set();
  const pendingBubbles = /* @__PURE__ */ new Set();
  const stickerOnly = (bubble) => {
    let stickers = 0;
    const walk = (node) => {
      if (node.nodeType === 3) return node.textContent.trim() === "";
      if (node.nodeType !== 1) return node.nodeType === 8;
      if (node.tagName === "IMG") {
        if (node.dataset.dshMemeSized !== "image") return false;
        stickers++;
        return true;
      }
      if (!["DIV", "SPAN", "P", "BR", "A", "BUTTON"].includes(node.tagName)) return false;
      if (node.tagName === "BUTTON" && node.dataset.dshMemeSized !== "wrapper") return false;
      if (node.matches('[role="dialog"],dialog,[hidden],[aria-hidden="true"]')) return false;
      return [...node.childNodes].every(walk);
    };
    return [...bubble.childNodes].every(walk) && stickers > 0;
  };
  const updateBubbles = () => {
    for (const bubble of pendingBubbles) {
      if (bubble.isConnected && bubble.matches(".bt-bubble") && !bubble.closest('[role="dialog"],dialog') && stickerOnly(bubble)) {
        bubble.setAttribute("data-dsh-meme-bubble", "true");
        bubbles.add(bubble);
      } else if (bubbles.delete(bubble)) bubble.removeAttribute("data-dsh-meme-bubble");
    }
    pendingBubbles.clear();
    for (const bubble of bubbles) if (!bubble.isConnected) {
      bubble.removeAttribute("data-dsh-meme-bubble");
      bubbles.delete(bubble);
    }
  };
  const queueBubble = (node) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    const bubble = element?.closest(".bt-bubble");
    if (bubble) pendingBubbles.add(bubble);
    if (bubbles.has(element)) pendingBubbles.add(element);
  };
  const pending = [];
  const cache = /* @__PURE__ */ new Map();
  const controllers = /* @__PURE__ */ new Set();
  let active = 0;
  let disposed = false;
  const sizes = new Set(fingerprints.map((file) => file.bytes));
  const hashes = new Set(fingerprints.map((file) => file.sha256));
  const maxBytes = Math.max(0, ...sizes);
  const excluded = (image) => Boolean(image.closest('[role="dialog"],dialog'));
  const mark = (element, kind) => {
    if (element.hasAttribute("data-dsh-meme-sized") && !owned.has(element)) return;
    element.dataset.dshMemeSized = kind;
    owned.add(element);
  };
  const unmark = (element) => {
    if (!owned.delete(element)) return;
    element.removeAttribute("data-dsh-meme-sized");
  };
  const updateWrapper = (wrapper) => {
    if (!wrapper || wrapper.tagName !== "BUTTON") return;
    const children = [...wrapper.children];
    if (children.length === 1 && children[0].tagName === "IMG" && owned.has(children[0])) mark(wrapper, "wrapper");
    else unmark(wrapper);
  };
  const apply2 = (image, yes) => {
    if (disposed || !image.isConnected) return;
    if (yes && !excluded(image)) mark(image, "image");
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
      const timer = window.setTimeout(() => controller.abort(), 3e3);
      matchesFingerprint(source, { fetcher: window.fetch.bind(window), crypto: window.crypto, sizes, hashes, maxBytes, signal: controller.signal }).then(settle).finally(() => {
        window.clearTimeout(timer);
        controllers.delete(controller);
        active--;
        pump();
      });
    }
  };
  const fingerprint = (source) => {
    if (cache.has(source)) return cache.get(source);
    if (cache.size >= 256) return Promise.resolve(false);
    const result = new Promise((settle) => pending.push({ source, settle }));
    cache.set(source, result);
    pump();
    return result;
  };
  const visit = (image) => {
    const source = image.getAttribute("src") ?? "";
    const explicit = image.getAttribute("data-dsh-meme-sticker") === "true";
    const known = explicit || isMemeSource(source, document2.baseURI);
    apply2(image, known);
    if (!known && !excluded(image) && fingerprintBlobs && source.startsWith(`blob:${window.location.origin}/`) && window.fetch && window.crypto?.subtle) {
      void fingerprint(source).then((yes) => {
        if (image.getAttribute("src") === source) apply2(image, yes);
      });
    }
  };
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches("img")) visit(node);
    node.querySelectorAll("img").forEach(visit);
  };
  const observer = new window.MutationObserver((records) => {
    for (const record of records) {
      queueBubble(record.target);
      if (record.type === "attributes") scan(record.target);
      else if (record.type === "childList") {
        record.addedNodes.forEach(scan);
        updateWrapper(record.target);
      }
    }
    for (const element of owned) if (!element.isConnected) unmark(element);
    updateBubbles();
  });
  observer.observe(document2.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "data-dsh-meme-sticker", "role", "open", "hidden", "aria-hidden", "class"] });
  scan(document2.documentElement);
  return () => {
    disposed = true;
    observer.disconnect();
    controllers.forEach((controller) => controller.abort());
    pending.splice(0).forEach(({ settle }) => settle(false));
    [...owned].forEach(unmark);
    for (const bubble of bubbles) bubble.removeAttribute("data-dsh-meme-bubble");
    bubbles.clear();
    pendingBubbles.clear();
    cache.clear();
    style.remove();
  };
}
function apply(ctx, config = {}) {
  ctx.effect(() => install(document, config));
}
return module.exports;}});
