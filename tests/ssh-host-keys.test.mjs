import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Les scripts ne doivent jamais accepter une cle d'hote sans la verifier ni l'oublier aussitot.
function shellScripts(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? shellScripts(p) : p.endsWith('.sh') ? [p] : [];
  });
}
const scripts = shellScripts(new URL('../scripts', import.meta.url).pathname);

test('aucun script ne desactive la verification des cles d hote SSH', () => {
  const offenders = scripts.filter((p) => /StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('les appels ssh et scp de vm-controller passent par vm_ssh_host_opts', () => {
  const dir = new URL('../scripts/agents/vm-controller/', import.meta.url).pathname;
  for (const f of ['vm-exec.sh', 'vm-copy.sh', 'common.sh']) {
    const src = readFileSync(join(dir, f), 'utf8');
    const calls = src.split('\n').filter((l) => /^\s*(if )?(ssh|scp) /.test(l)).length;
    const opts = (src.match(/VM_SSH_HOST_OPTS\[@\]/g) || []).length;
    assert.ok(opts >= 1 && calls >= 1, `${f} : ${calls} appel(s), ${opts} usage(s) des options`);
  }
});

test('vm_ssh_host_opts est defini dans common.sh avec accept-new et un known_hosts dedie', () => {
  const src = readFileSync(new URL('../scripts/agents/vm-controller/common.sh', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('vm_ssh_host_opts() {'), src.indexOf('\n}', src.indexOf('vm_ssh_host_opts() {')));
  assert.ok(body.length > 0, 'fonction absente');
  assert.match(body, /StrictHostKeyChecking=accept-new/);
  assert.match(body, /UserKnownHostsFile=\$VM_KNOWN_HOSTS/);
  assert.match(body, /HostKeyAlias=/);
});
