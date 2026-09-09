import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Tests de caractérisation sur les sources (pas besoin de build) : chaque outil défini dans
// src/tools/*.ts doit avoir une entrée dans TOOL_PERMISSIONS, et les destructifs sont marqués.
const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const block = config.slice(config.indexOf('TOOL_PERMISSIONS'), config.indexOf('};', config.indexOf('TOOL_PERMISSIONS')));
const declared = [...block.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);

const toolFiles = ['vm-controller.ts', 'backup-manager.ts', 'vm-portability.ts'];
const exposed = [];
for (const f of toolFiles) {
  try {
    const src = readFileSync(new URL(`../src/tools/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/name:\s*'([a-z_]+)'/g)) exposed.push(m[1]);
  } catch { /* fichier absent */ }
}

test('chaque outil exposé a une entrée dans TOOL_PERMISSIONS', () => {
  const missing = exposed.filter((n) => !declared.includes(n));
  assert.deepEqual(missing, []);
});

test('les outils destructifs sont marqués dangerous', () => {
  for (const name of ['vm_destroy', 'vm_stop', 'vm_clone_system', 'backup_restore', 'backup_clean']) {
    const entry = block.slice(block.indexOf(`  ${name}:`));
    const body = entry.slice(0, entry.indexOf('}'));
    assert.match(body, /dangerous:\s*true/, `${name} doit être dangerous`);
  }
});

test('vm_destroy exige sudo', () => {
  const entry = block.slice(block.indexOf('  vm_destroy:'));
  assert.match(entry.slice(0, entry.indexOf('}')), /requiresSudo:\s*true/);
});
