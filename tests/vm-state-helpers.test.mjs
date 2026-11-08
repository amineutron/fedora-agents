// is_vm_stopped / is_vm_running (common.sh) avec un faux virsh : une VM en pause n'est pas arretee.
// Regression : vm-stop et vm-destroy prenaient une VM en pause pour « deja arretee » (vm_destroy
// echouait ensuite : « suppression des volumes ... seulement sur les domaines arretes »).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const common = join(here, '..', 'scripts', 'agents', 'vm-controller', 'common.sh');

// Faux virsh place en tete du PATH (common.sh appelle `virsh -c qemu:///system ...` sans chemin) :
// `domstate <vm>` rend l'etat passe par FAKE_STATE ; tout le reste reussit en silence.
function fakeVirsh(state) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-virsh-'));
  const bin = join(dir, 'virsh');
  writeFileSync(bin, `#!/usr/bin/env bash\nfor a in "$@"; do if [[ "$a" == "domstate" ]]; then printf '%s\\n' "$FAKE_STATE"; fi; done\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { bin, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_STATE: state } };
}

function call(fn, state) {
  const { env } = fakeVirsh(state);
  try {
    execFileSync('bash', ['-c', `source "${common}" >/dev/null 2>&1; ${fn} vm-test`], { env, stdio: 'pipe' });
    return true;
  } catch (e) {
    if (typeof e.status === 'number' && e.status === 1) return false;
    throw e;
  }
}

const CASES = [
  // etat virsh (en, fr)            running  stopped
  ['running', true, false],
  ['en cours d’exécution', true, false],
  ['paused', false, false],
  ['mis en pause', false, false],
  ['in shutdown', false, false],
  ['crashed', false, false],
  ['shut off', false, true],
  ['fermé', false, true],
  ['arrêté', false, true],
  ['éteint', false, true],
];

for (const [state, running, stopped] of CASES) {
  test(`etat « ${state} » : running=${running} stopped=${stopped}`, () => {
    assert.equal(call('is_vm_running', state), running, 'is_vm_running');
    assert.equal(call('is_vm_stopped', state), stopped, 'is_vm_stopped');
  });
}

test('vm-stop.sh et vm-destroy.sh decident avec is_vm_stopped, plus avec is_vm_running', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = join(here, '..', 'scripts', 'agents', 'vm-controller');
  const stop = readFileSync(join(dir, 'vm-stop.sh'), 'utf8');
  const destroy = readFileSync(join(dir, 'vm-destroy.sh'), 'utf8');
  assert.match(stop, /if is_vm_stopped "\$vm"; then/);
  assert.doesNotMatch(stop, /if ! is_vm_running "\$vm"/);
  assert.match(destroy, /if ! is_vm_stopped "\$vm"; then/);
  assert.doesNotMatch(destroy, /if is_vm_running "\$vm"/);
});
