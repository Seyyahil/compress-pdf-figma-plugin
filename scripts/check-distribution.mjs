import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
const tracked = new Set(execFileSync(process.platform === 'win32' ? 'git' : '/usr/bin/git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0'));
const required = [manifest.main,manifest.ui,'dist/THIRD_PARTY_NOTICES.md','dist/licenses/pdf-lib.txt','dist/licenses/pako.txt'];
for (const file of required) {
  assert.equal(typeof file,'string','The manifest must name its runtime files');
  const path = resolve(root,file);
  assert.ok(path.startsWith(root.endsWith(sep) ? root : root+sep),'Runtime files must be inside the repository');
  assert.ok(tracked.has(file),`Missing from GitHub downloads: ${file}. Track the built distribution in Git.`);
  const info = await stat(path);
  assert.ok(info.isFile() && info.size > 0,`Missing or empty runtime file: ${file}`);
}
new vm.Script(await readFile(resolve(root,manifest.main),'utf8'));
const html = await readFile(resolve(root,manifest.ui),'utf8');
assert.ok(html.includes('<script>') && html.includes('</script>'),'The plugin UI must contain its bundled script');
new vm.Script(html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>')));
console.log('GitHub distribution is complete: manifest runtime files, bundled scripts and licenses are tracked.');
