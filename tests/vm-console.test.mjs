import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeSystem, parse } from './helpers/fake-system.mjs';

// vm_console et vm_console_log : XML de domaine simule, lecture seule. Necessite npm run build.
const { vmConsole, vmConsoleLog, tailLines, serialLogRoots } = await import('../dist/tools/vm-console.js');
const xmlLib = await import('../dist/utils/vm-domain-xml.js');

const dom = (graphics, serial = '') => `<domain type='kvm'><name>vm</name><devices>${serial}${graphics}</devices></domain>`;
const SPICE_TCP = `<graphics type='spice' port='5901' autoport='yes' listen='127.0.0.1'><listen type='address' address='127.0.0.1'/></graphics>`;
const SPICE_UNIX = `<graphics type='spice' autoport='no'><listen type='socket' socket='/var/lib/libvirt/qemu/domain-1-vm/spice.sock'/></graphics>`;
const VNC_PUBLIC = `<graphics type='vnc' port='5902' autoport='yes' listen='0.0.0.0'><listen type='address' address='0.0.0.0'/></graphics>`;
const VNC_PENDING = `<graphics type='vnc' port='-1' autoport='yes'><listen type='address' address='127.0.0.1'/></graphics>`;

test('parseGraphics : port TCP, socket Unix, ecoute publique, port non attribue', () => {
  assert.deepEqual(xmlLib.parseGraphics(dom(SPICE_TCP)), [{ type: 'spice', port: 5901, address: '127.0.0.1', socket: null }]);
  assert.deepEqual(xmlLib.parseGraphics(dom(SPICE_UNIX)), [{ type: 'spice', port: null, address: null, socket: '/var/lib/libvirt/qemu/domain-1-vm/spice.sock' }]);
  assert.equal(xmlLib.parseGraphics(dom(VNC_PUBLIC))[0].address, '0.0.0.0');
  assert.equal(xmlLib.parseGraphics(dom(VNC_PENDING))[0].port, null);
  assert.deepEqual(xmlLib.parseGraphics(dom('')), []);
  assert.deepEqual(xmlLib.parseGraphics(dom(`<graphics type="vnc" port="5900" listen="::1"/>`)), [{ type: 'vnc', port: 5900, address: '::1', socket: null }]);
});

test('isLoopback', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', null]) assert.equal(xmlLib.isLoopback(a), true, String(a));
  for (const a of ['0.0.0.0', '::', '172.16.0.9', '10.0.0.2']) assert.equal(xmlLib.isLoopback(a), false, a);
});

test('vm_console : adresse TCP locale, rien d ouvert ni de modifie', async () => {
  const sys = installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom(SPICE_TCP) } });
  const r = parse(await vmConsole.handler({ vm_name: 'vm' }));
  assert.deepEqual(r, { ok: true, vm: 'vm', state: 'running', type: 'spice', transport: 'tcp', host: '127.0.0.1', port: 5901, uri: 'spice://127.0.0.1:5901', public: false });
  assert.deepEqual(sys.mutations(), []);
  assert.deepEqual(sys.calls.map((c) => c.args[2]), ['domstate', 'dumpxml']);
});

test('vm_console : socket Unix', async () => {
  installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom(SPICE_UNIX) } });
  const r = parse(await vmConsole.handler({ vm_name: 'vm' }));
  assert.equal(r.transport, 'unix');
  assert.equal(r.socket, '/var/lib/libvirt/qemu/domain-1-vm/spice.sock');
  assert.equal(r.uri, 'spice+unix:///var/lib/libvirt/qemu/domain-1-vm/spice.sock');
  assert.equal(r.public, false);
});

test('vm_console : une ecoute hors de la machine est signalee', async () => {
  installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom(VNC_PUBLIC) } });
  const r = parse(await vmConsole.handler({ vm_name: 'vm', type: 'vnc' }));
  assert.equal(r.public, true);
  assert.match(r.warning, /interface non locale/);
});

test('vm_console : filtre par type et refus si le type n existe pas', async () => {
  installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom(SPICE_TCP + VNC_PENDING) } });
  assert.equal(parse(await vmConsole.handler({ vm_name: 'vm', type: 'spice' })).type, 'spice');
  const r = await vmConsole.handler({ vm_name: 'vm', type: 'vnc' });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /Port graphique vnc non attribue/);
  installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom(SPICE_TCP) } });
  const none = await vmConsole.handler({ vm_name: 'vm', type: 'vnc' });
  assert.match(parse(none).error, /Aucun affichage vnc.*spice/);
});

test('vm_console : VM arretee -> refus, VM inconnue -> VM_NOT_FOUND', async () => {
  installFakeSystem({ domains: { vm: 'shut off' }, xml: { vm: dom(SPICE_TCP) } });
  const stopped = await vmConsole.handler({ vm_name: 'vm' });
  assert.equal(stopped.isError, true);
  assert.match(parse(stopped).error, /n'est pas allumee/);
  const unknown = await vmConsole.handler({ vm_name: 'autre' });
  assert.equal(parse(unknown).code, 'VM_NOT_FOUND');
});

test('parseSerialLogs : journal virtlogd d abord, serie de type fichier ensuite', () => {
  const serial = `<serial type='pty'><source path='/dev/pts/3'/><target port='0'/><log file='/var/log/libvirt/qemu/vm-serial0.log' append='off'/></serial>`
    + `<serial type='file'><source path='/var/lib/libvirt/qemu/vm.log'/></serial><console type='pty'><source path='/dev/pts/3'/></console>`;
  assert.deepEqual(xmlLib.parseSerialLogs(dom('', serial)), [
    { kind: 'log', path: '/var/log/libvirt/qemu/vm-serial0.log' },
    { kind: 'file', path: '/var/lib/libvirt/qemu/vm.log' }
  ]);
  assert.deepEqual(xmlLib.parseSerialLogs(dom('', `<serial type='pty'><source path='/dev/pts/3'/></serial>`)), []);
});

test('tailLines : dernieres lignes, sans sequences ANSI ni controle', () => {
  assert.deepEqual(tailLines('a\nb\nc\n', 2), ['b', 'c']);
  assert.deepEqual(tailLines('a\r\nb\r\n', 5), ['a', 'b']);
  assert.deepEqual(tailLines('\u001b[31mrouge\u001b[0m\u0007 ok\n', 5), ['rouge ok']);
  assert.deepEqual(tailLines('', 5), []);
});

function logSetup(logContent, { init = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fa-log-'));
  const allowed = join(root, 'allowed');
  mkdirSync(allowed);
  process.env.VM_CONSOLE_LOG_DIRS = allowed;
  const logPath = join(allowed, 'vm-serial0.log');
  if (logContent !== null) writeFileSync(logPath, logContent);
  const xml = dom('', `<serial type='pty'><log file='${logPath}' append='off'/></serial>`);
  const sys = installFakeSystem({ domains: { vm: 'running' }, xml: { vm: xml }, ...init });
  return { root, allowed, logPath, sys };
}

test('vm_console_log : dernieres lignes du journal declare dans le XML', async () => {
  logSetup(`${Array.from({ length: 50 }, (_, i) => `ligne ${i + 1}`).join('\n')}\n`);
  const r = parse(await vmConsoleLog.handler({ vm_name: 'vm', lines: 3 }));
  assert.deepEqual(r.lines, ['ligne 48', 'ligne 49', 'ligne 50']);
  assert.equal(r.count, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.kind, 'log');
});

test('vm_console_log : 512 Ko au plus lus, le debut est abandonne', async () => {
  logSetup(`${'x'.repeat(600 * 1024)}\nfin\n`);
  const r = parse(await vmConsoleLog.handler({ vm_name: 'vm', lines: 2 }));
  assert.equal(r.truncated, true);
  assert.equal(r.lines.at(-1), 'fin');
});

test('vm_console_log : un journal hors des dossiers autorises n est jamais lu', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'fa-secret-'));
  const secret = join(outside, 'shadow');
  writeFileSync(secret, 'root:x:0:0\n');
  const allowed = mkdtempSync(join(tmpdir(), 'fa-allowed-'));
  process.env.VM_CONSOLE_LOG_DIRS = allowed;
  // 1) chemin declare hors des dossiers autorises
  installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom('', `<serial type='file'><source path='${secret}'/></serial>`) } });
  let r = await vmConsoleLog.handler({ vm_name: 'vm' });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.content[0].text, /root:x/);
  assert.equal(parse(r).code, 'PERMISSION_DENIED');
  // 2) lien symbolique qui sort du dossier autorise
  const link = join(allowed, 'vm.log');
  symlinkSync(secret, link);
  installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom('', `<serial type='file'><source path='${link}'/></serial>`) } });
  r = await vmConsoleLog.handler({ vm_name: 'vm' });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.content[0].text, /root:x/);
  // 3) chemins relatifs ou avec ..
  for (const path of ['relatif.log', `${allowed}/../${secret}`]) {
    installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom('', `<serial type='file'><source path='${path}'/></serial>`) } });
    assert.equal((await vmConsoleLog.handler({ vm_name: 'vm' })).isError, true, path);
  }
});

test('vm_console_log : journal absent ou illisible -> erreur claire avec les dossiers autorises', async () => {
  logSetup(null);
  const r = await vmConsoleLog.handler({ vm_name: 'vm' });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, 'PERMISSION_DENIED');
  assert.ok(parse(r).allowed_roots.includes('/var/log/libvirt'));
});

test('vm_console_log : serie sans journal (pty) -> explication', async () => {
  installFakeSystem({ domains: { vm: 'running' }, xml: { vm: dom('', `<serial type='pty'><source path='/dev/pts/3'/></serial>`) } });
  const r = await vmConsoleLog.handler({ vm_name: 'vm' });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /Aucun journal du port serie/);
});

test('vm_console_log : lecture seule, aucun appel de modification', async () => {
  const { sys } = logSetup('a\n');
  await vmConsoleLog.handler({ vm_name: 'vm' });
  assert.deepEqual(sys.mutations(), []);
  assert.deepEqual(sys.calls.map((c) => c.args[2]), ['domstate', 'dumpxml']);
});

test('serialLogRoots : libvirt, dossier d images et dossiers ajoutes (chemins absolus seulement)', () => {
  const roots = serialLogRoots({ VM_IMAGES_DIR: '/data/img', VM_CONSOLE_LOG_DIRS: '/srv/logs: relatif :/opt/x' });
  assert.deepEqual(roots, ['/var/log/libvirt', '/var/lib/libvirt', '/data/img', '/srv/logs', '/opt/x']);
});
