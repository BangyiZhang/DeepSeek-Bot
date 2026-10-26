/** Normalize public options without allowing unbounded rendering. */
export function normalizeConfig(config = {}) {
  const count = Number.isFinite(config.maxChips) ? Math.trunc(config.maxChips) : 3;
  return { maxChips: Math.max(1, Math.min(3, count)), hideOnTyping: config.hideOnTyping !== false };
}

/** Only the latest turn may supply chips; never reuse an older reply. */
export function latestCompletedTurn(outline) {
  if (!Array.isArray(outline) || outline.length === 0) return null;
  const last = outline.at(-1);
  if (!last || !Number.isSafeInteger(last.turn) || !Number.isSafeInteger(last.seq) || typeof last.response !== "string" || !last.response.trim()) return null;
  return { key: `${last.turn}:${last.seq}`, response: last.response };
}

/** Lock synchronously, before React paints disabled buttons, and release on failure. */
export function createSendGate() {
  let busy = false;
  return {
    async run(send) {
      if (busy) return false;
      busy = true;
      try { await send(); return true; }
      finally { busy = false; }
    }
  };
}
