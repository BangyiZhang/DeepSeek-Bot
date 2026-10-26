import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const dshRemoteInfo = process.env.DSH_REMOTE_INFO;
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
await build({
  entryPoints: ["src/client.js"], outfile: "lib/client.js", bundle: true,
  format: "cjs", platform: "browser", external: ["react"], target: "es2022",
  ...(dshRemoteInfo ? { alias: { '@deepseek-ai/dsh-typert-protocol/remote-info': dshRemoteInfo } } : {}),
  banner: { js: `window.__ModuleLoader__.load({id:"dsh-ambient-suggestions",factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: `let tag=document.querySelector('style[data-plugin-css="dsh-ambient-suggestions"]');if(!tag){tag=document.createElement("style");tag.dataset.pluginCss="dsh-ambient-suggestions";document.head.appendChild(tag);}tag.textContent=${JSON.stringify(css)};return module.exports;}});` }
});
