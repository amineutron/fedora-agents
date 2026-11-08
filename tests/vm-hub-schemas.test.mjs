import test from 'node:test';
import assert from 'node:assert/strict';

// Chaque regle de validation des outils hub = un test. Necessite npm run build.
const s = await import('../dist/utils/vm-hub-schemas.js');

const ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host';
const bad = (schema, input) => assert.equal(schema.safeParse(input).success, false, JSON.stringify(input));
const good = (schema, input) => {
  const r = schema.safeParse(input);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  return r.data;
};

test('vm_name : caracteres surs, alphanumerique en premier (pas d option virsh)', () => {
  for (const schema of [s.vmPauseSchema, s.vmResumeSchema, s.vmRebootSchema, s.vmConsoleSchema, s.vmConsoleLogSchema]) {
    good(schema, { vm_name: 'web-01_a' });
    for (const name of ['', '-rf', '--help', 'a b', 'a;b', 'a$(id)', 'a`id`', 'a/b', '../x', 'a\nb', 'é', 'a'.repeat(65)]) {
      bad(schema, { vm_name: name });
    }
  }
});

test('vm_reboot : defauts force=false wait=false timeout=90, bornes du timeout', () => {
  const v = good(s.vmRebootSchema, { vm_name: 'web' });
  assert.deepEqual([v.force, v.wait, v.timeout], [false, false, 90]);
  assert.equal(good(s.vmRebootSchema, { vm_name: 'web', force: 'true', wait: 'true' }).force, true);
  bad(s.vmRebootSchema, { vm_name: 'web', timeout: 9 });
  bad(s.vmRebootSchema, { vm_name: 'web', timeout: 301 });
  bad(s.vmRebootSchema, { vm_name: 'web', timeout: 12.5 });
  bad(s.vmRebootSchema, { vm_name: 'web', force: 'peut-etre' });
});

test('vm_create_from_image : name et image_id requis, defauts', () => {
  bad(s.vmCreateFromImageSchema, { name: 'x' });
  bad(s.vmCreateFromImageSchema, { image_id: 'cirros' });
  const v = good(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros' });
  assert.deepEqual([v.network, v.start, v.dry_run], ['default', false, false]);
});

test('image_id : uniquement un identifiant du catalogue (pas d URL, pas de chemin)', () => {
  for (const id of ['https://evil.example/x.qcow2', '../../etc/passwd', '/etc/passwd', 'inconnue', 'Debian-Cloud', '', 'cirros;id']) {
    bad(s.vmCreateFromImageSchema, { name: 'x', image_id: id });
    bad(s.vmImageFetchSchema, { image_id: id });
  }
  good(s.vmImageFetchSchema, { image_id: 'debian-cloud' });
});

test('vcpus : entier de 1 a 32', () => {
  for (const vcpus of [1, 32]) good(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', vcpus });
  for (const vcpus of [0, 33, -1, 1.5, '2']) bad(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', vcpus });
});

test('memory_mib : entier de 256 a 65536', () => {
  for (const memory_mib of [256, 65536]) good(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', memory_mib });
  for (const memory_mib of [255, 65537, 0, 512.5]) bad(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', memory_mib });
});

test('disk_gb : entier de 1 a 1024', () => {
  for (const disk_gb of [1, 1024]) good(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', disk_gb });
  for (const disk_gb of [0, 1025, -5, 1.5]) bad(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', disk_gb });
});

test('network : nom libvirt sur, 32 caracteres au plus', () => {
  good(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', network: 'lab-net.1' });
  for (const network of ['', '-x', 'a b', 'a;b', 'a/b', '$(id)', "a'b", 'a'.repeat(33)]) {
    bad(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', network });
  }
});

test('ssh_key : une cle publique OpenSSH sur une ligne, rien d autre', () => {
  good(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', ssh_key: ED25519 });
  const hostile = [
    `${ED25519}\nruncmd: [rm, -rf, /]`,          // injection YAML par retour a la ligne
    `${ED25519}\r`,
    'ssh-ed25519',                                // pas de corps
    'ssh-dss AAAAB3NzaC1kc3MAAACBAP1',            // type refuse
    ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '),   // cle privee (assemblee : le garde-fou de commit lit les sources)
    `ssh-ed25519 AAAA\u0007BBBBBBBBBBBBBBBBBBBBBBB`,
    `echo ${ED25519}`,
    '',
    `ssh-rsa ${'A'.repeat(4700)}`
  ];
  for (const ssh_key of hostile) bad(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', ssh_key });
});

test('hostname : etiquette RFC 1123 en minuscules', () => {
  good(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', hostname: 'web-01' });
  for (const hostname of ['', 'Web', '-web', 'web-', 'web_01', 'a.b', 'a b', 'a'.repeat(64)]) {
    bad(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', hostname });
  }
});

test('user : compte Unix en minuscules', () => {
  good(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', user: 'ops_1' });
  for (const user of ['', 'Root', '1abc', 'a b', 'a;b', 'a$b', 'a'.repeat(33)]) {
    bad(s.vmCreateFromImageSchema, { name: 'x', image_id: 'cirros', user });
  }
});

test('vm_console : type spice, vnc ou auto (defaut)', () => {
  assert.equal(good(s.vmConsoleSchema, { vm_name: 'x' }).type, 'auto');
  good(s.vmConsoleSchema, { vm_name: 'x', type: 'vnc' });
  bad(s.vmConsoleSchema, { vm_name: 'x', type: 'rdp' });
  bad(s.vmConsoleSchema, { vm_name: 'x', type: 'ws' });
});

test('vm_console_log : lines de 1 a 2000, defaut 100', () => {
  assert.equal(good(s.vmConsoleLogSchema, { vm_name: 'x' }).lines, 100);
  good(s.vmConsoleLogSchema, { vm_name: 'x', lines: 2000 });
  for (const lines of [0, 2001, -1, 1.5, '10']) bad(s.vmConsoleLogSchema, { vm_name: 'x', lines });
});
