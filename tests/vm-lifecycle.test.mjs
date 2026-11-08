import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeSystem, parse } from './helpers/fake-system.mjs';

// vm_pause / vm_resume / vm_reboot contre un faux virsh (aucune VM reelle). Necessite npm run build.
process.env.VM_HUB_POLL_MS = '2';
const { vmPause, vmResume, vmReboot } = await import('../dist/tools/vm-lifecycle.js');

const call = (tool, params) => tool.handler(params);

test('vm_pause suspend une VM en marche', async () => {
  const sys = installFakeSystem({ domains: { web: 'running' } });
  const r = await call(vmPause, { vm_name: 'web' });
  assert.equal(r.isError, undefined);
  assert.deepEqual(parse(r), { ok: true, vm: 'web', state: 'paused', changed: true, message: "VM 'web' suspendue" });
  assert.deepEqual(sys.mutations(), ['suspend']);
  assert.deepEqual(sys.violations, []);
});

test('vm_pause est idempotent : deja en pause, aucun appel de modification', async () => {
  const sys = installFakeSystem({ domains: { web: 'paused' } });
  const r = await call(vmPause, { vm_name: 'web' });
  assert.equal(r.isError, undefined);
  assert.equal(parse(r).changed, false);
  assert.deepEqual(sys.mutations(), []);
});

test('vm_pause refuse une VM qui n est pas en marche', async () => {
  for (const state of ['shut off', 'crashed', 'in shutdown', 'pmsuspended']) {
    const sys = installFakeSystem({ domains: { web: state } });
    const r = await call(vmPause, { vm_name: 'web' });
    assert.equal(r.isError, true, state);
    assert.equal(parse(r).code, 'VALIDATION_ERROR');
    assert.equal(parse(r).state, state);
    assert.deepEqual(sys.mutations(), []);
  }
});

test('vm_pause : VM inconnue -> VM_NOT_FOUND', async () => {
  installFakeSystem({ domains: {} });
  const r = await call(vmPause, { vm_name: 'fantome' });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, 'VM_NOT_FOUND');
});

test('vm_pause : un echec de virsh suspend est rendu en erreur', async () => {
  installFakeSystem({ domains: { web: 'running' }, fail: { suspend: { stderr: 'error: operation failed' } } });
  const r = await call(vmPause, { vm_name: 'web' });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /operation failed/);
});

test('vm_pause : etat idle compte comme en marche', async () => {
  const sys = installFakeSystem({ domains: { web: 'idle' } });
  assert.equal((await call(vmPause, { vm_name: 'web' })).isError, undefined);
  assert.deepEqual(sys.mutations(), ['suspend']);
});

test('vm_resume reprend une VM en pause', async () => {
  const sys = installFakeSystem({ domains: { web: 'paused' } });
  const r = await call(vmResume, { vm_name: 'web' });
  assert.equal(parse(r).changed, true);
  assert.deepEqual(sys.mutations(), ['resume']);
});

test('vm_resume est idempotent sur une VM deja en marche', async () => {
  const sys = installFakeSystem({ domains: { web: 'running' } });
  const r = await call(vmResume, { vm_name: 'web' });
  assert.equal(parse(r).changed, false);
  assert.deepEqual(sys.mutations(), []);
});

test('vm_resume refuse une VM arretee et propose vm_start', async () => {
  const sys = installFakeSystem({ domains: { web: 'shut off' } });
  const r = await call(vmResume, { vm_name: 'web' });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /vm_start/);
  assert.deepEqual(sys.mutations(), []);
});

test('vm_reboot sans attente : une seule demande ACPI, reponse immediate', async () => {
  const sys = installFakeSystem({ domains: { web: 'running' } });
  const r = await call(vmReboot, { vm_name: 'web' });
  assert.equal(r.isError, undefined);
  assert.equal(parse(r).mode, 'acpi');
  assert.equal(parse(r).waited, false);
  assert.deepEqual(sys.calls.filter((c) => ['reboot', 'shutdown', 'start', 'reset'].includes(c.args[2])).map((c) => c.args.slice(2)), [['reboot', 'web', '--mode', 'acpi']]);
  assert.equal(sys.virshCalls('domstate').length, 1, 'pas d attente : un seul releve d etat');
});

test('vm_reboot force : reset materiel, pas d arret ACPI', async () => {
  const sys = installFakeSystem({ domains: { web: 'running' } });
  const r = await call(vmReboot, { vm_name: 'web', force: true });
  assert.equal(parse(r).mode, 'reset');
  assert.deepEqual(sys.mutations(), ['reset']);
});

test('vm_reboot wait : arret ACPI, attente de l extinction, puis demarrage', async () => {
  const sys = installFakeSystem({ domains: { web: 'running' } });
  const r = await call(vmReboot, { vm_name: 'web', wait: true });
  assert.equal(r.isError, undefined);
  assert.equal(parse(r).waited, true);
  assert.deepEqual(sys.mutations(), ['shutdown', 'start']);
  assert.deepEqual(sys.virshCalls('shutdown')[0].args.slice(3), ['web', '--mode', 'acpi']);
  assert.equal(sys.domains.web, 'running');
});

test('vm_reboot wait : invite qui ignore l ACPI -> TIMEOUT, jamais de start, suggere force', async () => {
  const sys = installFakeSystem({ domains: { web: 'running' }, shutdownStays: true });
  process.env.VM_HUB_TIME_SCALE = '0.002';   // le delai minimal (10 s) devient 20 ms
  const r = await call(vmReboot, { vm_name: 'web', wait: true, timeout: 10 }).finally(() => { delete process.env.VM_HUB_TIME_SCALE; });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, 'TIMEOUT');
  assert.match(parse(r).error, /force=true/);
  assert.ok(!sys.mutations().includes('start'));
});

test('vm_reboot refuse une VM arretee ou en pause', async () => {
  for (const [state, hint] of [['shut off', /vm_start/], ['paused', /vm_resume/]]) {
    const sys = installFakeSystem({ domains: { web: state } });
    const r = await call(vmReboot, { vm_name: 'web' });
    assert.equal(r.isError, true, state);
    assert.match(parse(r).error, hint);
    assert.deepEqual(sys.mutations(), []);
  }
});

test('vm_reboot : un echec du demarrage apres l arret est signale', async () => {
  installFakeSystem({ domains: { web: 'running' }, fail: { start: { stderr: 'error: cannot start' } } });
  const r = await call(vmReboot, { vm_name: 'web', wait: true });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /demarrage a echoue/);
});

test('les outils refusent une entree invalide avant tout appel', async () => {
  const sys = installFakeSystem({ domains: { web: 'running' } });
  for (const tool of [vmPause, vmResume, vmReboot]) {
    await assert.rejects(call(tool, { vm_name: '--connect=evil' }));
  }
  assert.deepEqual(sys.calls, []);
});
