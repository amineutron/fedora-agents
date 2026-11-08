import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// L executeur reel de la couture (celui de la production), essaye avec des commandes inoffensives (sh, echo) :
// jamais virsh. Necessite npm run build.
process.env.MCP_AGENTS_LOG_DIR = mkdtempSync(join(tmpdir(), 'fa-runner-logs-'));
const { executorRunner, run, setRunner } = await import('../dist/utils/runner.js');

test('executorRunner : sortie, code de retour, arguments sans interpretation par un shell', async () => {
  const r = await executorRunner('echo', ['a;b', '$(id)', '`id`'], { tool: 'vm_pause' });
  assert.deepEqual(r, { code: 0, stdout: 'a;b $(id) `id`', stderr: '' });
});

test('executorRunner : locale C imposee (etats libvirt non traduits)', async () => {
  const r = await executorRunner('sh', ['-c', 'echo "$LC_ALL/$LANG"'], { tool: 'vm_pause' });
  assert.equal(r.stdout, 'C/C');
});

test('executorRunner : un code de sortie non nul et stderr sont rendus', async () => {
  const r = await executorRunner('sh', ['-c', 'echo erreur >&2; exit 3'], { tool: 'vm_pause' });
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'erreur');
});

test('executorRunner : commande introuvable -> echec propre', async () => {
  const r = await executorRunner('commande-inexistante-fa', [], { tool: 'vm_pause' });
  assert.notEqual(r.code, 0);
});

test('executorRunner : delai depasse -> arret du processus', async () => {
  const r = await executorRunner('sleep', ['30'], { tool: 'vm_pause', timeoutMs: 100 });
  assert.notEqual(r.code, 0);
});

test('setRunner remplace puis restaure l executeur', async () => {
  setRunner(async () => ({ code: 0, stdout: 'faux', stderr: '' }));
  assert.equal((await run('echo', ['x'], { tool: 'vm_pause' })).stdout, 'faux');
  setRunner(null);
  assert.equal((await run('echo', ['x'], { tool: 'vm_pause' })).stdout, 'x');
});
