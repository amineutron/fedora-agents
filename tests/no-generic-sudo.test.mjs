import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Les outils lances sans sudo ne doivent pas reclamer une regle NOPASSWD generique sur virsh ou qemu-img,
// equivalente a root : libvirt passe par le groupe libvirt (polkit).
const dir = new URL('../scripts/agents/vm-controller/', import.meta.url).pathname;

test('aucun sudo sur virsh, qemu-img ou virt-clone dans vm-controller', () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
    const code = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l) && !/log_(warn|info|error)/.test(l)).join('\n');
    assert.doesNotMatch(code, /(sudo|\$SUDO)\s+(virsh|qemu-img|virt-clone)/, f);
  }
});

test('VIRSH se connecte a qemu:///system sans sudo', () => {
  const common = readFileSync(join(dir, 'common.sh'), 'utf8');
  assert.match(common, /^VIRSH="virsh -c qemu:\/\/\/system"$/m);
});

test('le README ne propose plus de NOPASSWD sur les binaires libvirt', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /NOPASSWD: \/usr\/bin\/(virsh|virt-clone|qemu-img)/);
});
