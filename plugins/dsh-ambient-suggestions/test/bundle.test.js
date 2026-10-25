import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import React from "react";

// This test skips on a clean source checkout until npm run build creates the artifact.
test("generated bundle registers lazily and exposes DSH's named plugin face", async (t) => {
  let source;
  try { source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return t.skip("Run npm run build first"); throw error; }
  let registered; const styles = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { registered = entry; } } },
    document: { querySelector: () => styles[0] ?? null, createElement: () => ({ dataset: {} }), head: { appendChild: (style) => styles.push(style) } }
  };
  vm.runInNewContext(source, sandbox);
  assert.equal(registered.id, "dsh-ambient-suggestions");
  assert.equal(styles.length, 0);
  const exports = registered.factory((id) => { assert.equal(id, "react"); return React; });
  assert.equal(typeof exports.apply, "function");
  assert.equal(typeof exports.PredictivePlaceholderManager, "function");
  assert.equal(styles.length, 1);
  registered.factory(() => React);
  assert.equal(styles.length, 1);
});
