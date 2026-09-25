#!/usr/bin/env node
// Génère le tableau outil → sudo → danger → description de SECURITY.md depuis src/config.ts (TOOL_PERMISSIONS).
// Usage : node scripts/gen-security-table.mjs [--check]   (--check : échoue si SECURITY.md n'est pas à jour)
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('TOOL_PERMISSIONS'), src.indexOf('};', src.indexOf('TOOL_PERMISSIONS')));
const rows = [];
for (const m of block.matchAll(/^\s{2}([a-z_]+):\s*\{([\s\S]*?)\n\s{2}\}/gm)) {
  const body = m[2];
  const sudo = /requiresSudo:\s*true/.test(body);
  const dangerous = /dangerous:\s*true/.test(body);
  const desc = (body.match(/description:\s*'((?:\\'|[^'])*)'/) || [])[1]?.replace(/\\'/g, "'") ?? '';
  rows.push({ name: m[1], sudo, dangerous, desc });
}
const table = ['| Outil | sudo | Dangereux | Rôle |', '|---|---|---|---|',
  ...rows.map((r) => `| \`${r.name}\` | ${r.sudo ? 'oui' : 'non'} | ${r.dangerous ? '**oui**' : 'non'} | ${r.desc} |`)].join('\n');
const START = '<!-- table:start -->', END = '<!-- table:end -->';
const path = new URL('../SECURITY.md', import.meta.url);
const doc = readFileSync(path, 'utf8');
const next = `${doc.slice(0, doc.indexOf(START) + START.length)}\n${table}\n${doc.slice(doc.indexOf(END))}`;
if (process.argv.includes('--check')) {
  if (next !== doc) { console.error('SECURITY.md est périmé : lancez npm run security:table'); process.exit(1); }
  console.log(`SECURITY.md à jour (${rows.length} outils)`);
} else {
  writeFileSync(path, next);
  console.log(`SECURITY.md régénéré (${rows.length} outils)`);
}
