import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Tests de caractérisation sur les sources (pas besoin de build) : chaque outil défini dans
// src/tools/*.ts doit avoir une entrée dans TOOL_PERMISSIONS, et les destructifs sont marqués.
const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const block = config.slice(config.indexOf('TOOL_PERMISSIONS'), config.indexOf('};', config.indexOf('TOOL_PERMISSIONS')));
const declared = [...block.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);

const toolFiles = ['vm-controller.ts', 'backup-manager.ts', 'vm-portability.ts', 'vm-lifecycle.ts', 'vm-create.ts', 'vm-image-fetch.ts', 'vm-console.ts'];
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

// Outils "hub" : pilotage libvirt direct (groupe libvirt), jamais de sudo ; seul le reset force est dangereux.
const entryOf = (name) => {
  const entry = block.slice(block.indexOf(`  ${name}:`));
  return entry.slice(0, entry.indexOf('}'));
};
const HUB = ['vm_pause', 'vm_resume', 'vm_reboot', 'vm_create_from_image', 'vm_image_fetch', 'vm_console', 'vm_console_log'];

test('les sept outils hub sont exposes et declares', () => {
  for (const name of HUB) {
    assert.ok(exposed.includes(name), `${name} non expose`);
    assert.ok(declared.includes(name), `${name} sans entree TOOL_PERMISSIONS`);
  }
});

test('aucun outil hub ne demande sudo', () => {
  for (const name of HUB) assert.match(entryOf(name), /requiresSudo:\s*false/, name);
});

test('vm_reboot (reset force) est dangereux, les autres outils hub ne detruisent rien', () => {
  assert.match(entryOf('vm_reboot'), /dangerous:\s*true/);
  for (const name of HUB.filter((n) => n !== 'vm_reboot')) assert.match(entryOf(name), /dangerous:\s*false/, name);
});

test('annotations : la console est en lecture seule, pause/reprise/telechargement rejouables', () => {
  const readOnly = config.slice(config.indexOf('READ_ONLY_TOOLS'), config.indexOf(']);', config.indexOf('READ_ONLY_TOOLS')));
  const idempotent = config.slice(config.indexOf('IDEMPOTENT_TOOLS'), config.indexOf(']);', config.indexOf('IDEMPOTENT_TOOLS')));
  for (const name of ['vm_console', 'vm_console_log']) assert.match(readOnly, new RegExp(`'${name}'`), name);
  for (const name of ['vm_pause', 'vm_resume', 'vm_image_fetch']) assert.match(idempotent, new RegExp(`'${name}'`), name);
  for (const name of ['vm_reboot', 'vm_create_from_image']) assert.doesNotMatch(idempotent, new RegExp(`'${name}'`), name);
});
