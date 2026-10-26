import { build } from 'esbuild';
await build({
  entryPoints: ['src/client.js'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022',
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-meme-stickers",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' }
});
