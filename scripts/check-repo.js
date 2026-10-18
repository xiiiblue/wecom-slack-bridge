import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
for (const dir of ['src', 'scripts']) for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', `${dir}/${file}`]);
}
const docs = ['README.md', ...readdirSync('docs').filter(f => f.endsWith('.md')).map(f => `docs/${f}`), 'deploy/README.md'];
let links = 0;
for (const file of docs) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^(?:https?:|mailto:|#)/.test(link)) continue;
    assert(existsSync(resolve(dirname(file), link.split('#')[0])), `Broken local link in ${file}: ${link}`);
    links++;
  }
}
console.log(`Syntax OK; ${docs.length} Markdown documents, ${links} local file links checked (offline).`);
