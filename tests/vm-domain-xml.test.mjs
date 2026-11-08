import test from 'node:test';
import assert from 'node:assert/strict';

// Fonctions pures : XML de domaine et graine cloud-init. Necessite npm run build.
const xml = await import('../dist/utils/vm-domain-xml.js');
const ci = await import('../dist/utils/cloud-init.js');

test('xmlEscape neutralise les cinq caracteres speciaux', () => {
  assert.equal(xml.xmlEscape(`<a b="c" d='e'>&`), '&lt;a b=&quot;c&quot; d=&apos;e&apos;&gt;&amp;');
});

test('isSafeVolumePath : chemin absolu a caracteres surs', () => {
  for (const ok of ['/var/lib/libvirt/images/x.qcow2', '/a/b-c_d.e/f']) assert.equal(xml.isSafeVolumePath(ok), true, ok);
  for (const bad of ['x.qcow2', '/a b', "/a'b", '/a/../b', '/a;b', '/a\nb', '', '/a$b']) assert.equal(xml.isSafeVolumePath(bad), false, JSON.stringify(bad));
});

test('le domaine construit : q35, virtio, ecran en local, agent invite, journal serie', () => {
  const out = xml.buildDomainXml({
    name: 'lab', memoryMib: 1024, vcpus: 2, network: 'default', serialLogPath: '/var/log/libvirt/qemu/lab-serial0.log',
    disks: [{ path: '/p/lab.qcow2', format: 'qcow2', device: 'disk', target: 'vda', bootOrder: 1 }]
  });
  assert.match(out, /machine='q35'/);
  assert.match(out, /<target dev='vda' bus='virtio'\/>/);
  assert.match(out, /<listen type='address' address='127\.0\.0\.1'\/>/);
  assert.doesNotMatch(out, /0\.0\.0\.0/);
  assert.match(out, /org\.qemu\.guest_agent\.0/);
  assert.match(out, /<log file='\/var\/log\/libvirt\/qemu\/lab-serial0\.log' append='off'\/>/);
  assert.match(out, /<boot order='1'\/>/);
});

test('un nom ou un reseau ne peut pas sortir de son attribut XML', () => {
  const out = xml.buildDomainXml({
    name: 'a</name><x/>', memoryMib: 1, vcpus: 1, network: `n'><evil/>`, serialLogPath: '/l.log', disks: []
  });
  assert.doesNotMatch(out, /<x\/>|<evil\/>/);
});

test('graine cloud-init : valeurs entre guillemets JSON, une cle ne peut pas ajouter de directive', () => {
  const hostile = 'ssh-ed25519 AAAA\nruncmd:\n  - rm -rf /';
  const out = ci.buildUserData({ hostname: 'h', user: 'u', sshKey: hostile });
  assert.ok(out.includes(JSON.stringify(hostile)));
  assert.equal(out.split('\n').filter((l) => l.startsWith('runcmd')).length, 0, 'aucune ligne runcmd au niveau racine');
  assert.match(out, /^#cloud-config\n/);
  assert.match(out, /lock_passwd: true/);
});

test('graine sans cle : pas de bloc ssh_authorized_keys', () => {
  assert.doesNotMatch(ci.buildUserData({ hostname: 'h', user: 'u' }), /ssh_authorized_keys/);
});

test('meta-data : instance-id neuf a chaque appel', () => {
  assert.notEqual(ci.buildMetaData('h'), ci.buildMetaData('h'));
  assert.equal(ci.buildMetaData('h', 'i-1'), 'instance-id: "i-1"\nlocal-hostname: "h"\n');
});

test('defaultHostname : nom de VM converti en etiquette RFC 1123', () => {
  assert.equal(ci.defaultHostname('Web_01'), 'web-01');
  assert.equal(ci.defaultHostname('a'.repeat(64)), 'a'.repeat(63));
  assert.equal(ci.defaultHostname('__'), 'vm');
  assert.equal(ci.defaultHostname('x-'), 'x');
  assert.match(ci.defaultHostname('lab_test_1'), /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
});
