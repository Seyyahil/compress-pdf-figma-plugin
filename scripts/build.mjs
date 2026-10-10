import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
await mkdir('dist', { recursive:true });
const worker = await build({ entryPoints:['src/worker.js'], bundle:true, write:false, format:'iife', platform:'browser', target:'chrome110', minify:true, legalComments:'inline' });
const ui = await build({ entryPoints:['src/ui.js'], bundle:true, write:false, format:'iife', platform:'browser', target:'chrome110', minify:true, legalComments:'inline', define:{ __WORKER_SOURCE__:JSON.stringify(worker.outputFiles[0].text) } });
new vm.Script(ui.outputFiles[0].text);
new vm.Script(worker.outputFiles[0].text);
await build({ entryPoints:['src/code.ts'], bundle:true, outfile:'dist/code.js', format:'iife', platform:'browser', target:'es2017', minify:false });
// A callback prevents literal $&, $` and $' in bundled libraries from being
// interpreted as String.replace substitution patterns and corrupting the source.
const html = (await readFile('src/ui.html','utf8')).replace('/*__BUNDLE__*/', () => ui.outputFiles[0].text.replace(/<\/script/gi,'<\\/script'));
new vm.Script(html.slice(html.indexOf('<script>')+8, html.lastIndexOf('</script>')));
await writeFile('dist/ui.html',html);
// Figma imports the root manifest, which points to these compiled files.
await rm('dist/manifest.json', { force:true });
await copyFile('THIRD_PARTY_NOTICES.md','dist/THIRD_PARTY_NOTICES.md');
await rm('dist/licenses', {recursive:true,force:true});
await mkdir('dist/licenses', {recursive:true});
for(const [from,to] of [['node_modules/pdf-lib/LICENSE.md','pdf-lib.txt'],['node_modules/pako/LICENSE','pako.txt']]) await copyFile(from,'dist/licenses/'+to);
console.log(`Built Compress PDF: ${(Buffer.byteLength(html)/1e6).toFixed(2)} MB, fully bundled with no network dependencies.`);
