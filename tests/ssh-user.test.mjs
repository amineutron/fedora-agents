import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regression : le compte de l'hote etait utilise pour toutes les VMs, alors que les images cloud
// ont leur propre compte (fedora, ubuntu, arch) : SSH refusait la cle.
const common = new URL('../scripts/agents/vm-controller/common.sh', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'fa-home-'));  // pas de ~/.config/vm-controller/config reel

function userFor(vm, env) {
  return execFileSync('bash', ['-c', `source "${common}" >/dev/null 2>&1; vm_ssh_user "$1"`, 'bash', vm], {
    env: { PATH: process.env.PATH, HOME: home, USER: 'hote', ...env },
    encoding: 'utf8',
  }).trim();
}

const cases = [
  ['fedora-base', { VM_SSH_USERS: 'fedora-base=fedora ubuntu-base=ubuntu' }, 'fedora'],
  ['ubuntu-base', { VM_SSH_USERS: 'fedora-base=fedora ubuntu-base=ubuntu' }, 'ubuntu'],
  ['autre-vm', { VM_SSH_USERS: 'fedora-base=fedora', VM_SSH_USER: 'admin' }, 'admin'],
  ['autre-vm', {}, 'hote'],
  ['fedora', { VM_SSH_USERS: 'fedora-base=fedora' }, 'hote'],  // pas de correspondance partielle
];
for (const [vm, env, expected] of cases) {
  test(`vm_ssh_user ${vm} ${JSON.stringify(env)} -> ${expected}`, () => {
    assert.equal(userFor(vm, env), expected);
  });
}
