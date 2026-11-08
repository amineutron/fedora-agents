import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeSystem, parse } from './helpers/fake-system.mjs';

// vm_hardware et son parseur XML : dumpxml reel (bios, spice, reseau default) et XML UEFI + secure boot
// + TPM + USB. Lecture seule. Necessite npm run build.
const hw = await import('../dist/utils/vm-hardware-xml.js');
const { vmHardware } = await import('../dist/tools/vm-hardware.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ARCH = fixture('arch-base.xml');
const UEFI = fixture('uefi-tpm.xml');

test('parseHardwareXml : dumpxml reel, bios + spice + reseau default', () => {
  const h = hw.parseHardwareXml(ARCH);
  assert.deepEqual(h, {
    cpu_model: 'host-passthrough',
    firmware: 'bios',
    secure_boot: false,
    tpm: false,
    boot_order: ['hd'],
    boot_order_source: 'os',
    display: 'spice',
    network: 'default',
    disks: [{ target: 'vda', path: '/var/lib/libvirt/images/arch-base.qcow2', capacity_gb: null }],
    usb: [],
    vcpus: 2,
    memory_mib: 4096,
    description: null
  });
});

test('parseHardwareXml : uefi + secure boot + tpm + usb, attributs dans un ordre quelconque et guillemets doubles', () => {
  const h = hw.parseHardwareXml(UEFI);
  assert.equal(h.cpu_model, 'x86-64-v2');
  assert.equal(h.firmware, 'uefi');
  assert.equal(h.secure_boot, true);
  assert.equal(h.tpm, true);
  assert.deepEqual(h.boot_order, ['cdrom', 'hd']);
  assert.equal(h.display, 'vnc');
  assert.equal(h.network, 'br0');
  assert.deepEqual(h.disks, [{ target: 'sda', path: '/var/lib/libvirt/images/win-lab.qcow2', capacity_gb: null }]);
  assert.deepEqual(h.usb, ['046d:c52b', '1b1c:1b7f'], 'le hostdev PCI est ignore, les identifiants sont normalises en minuscules');
  assert.deepEqual([h.vcpus, h.memory_mib, h.description], [4, 6144, 'Poste Windows de test']);
});

test('parseHardwareXml : uefi detecte par le seul <loader type=pflash>, secure boot par <loader secure=yes>', () => {
  const xml = `<domain><os><type arch='x86_64'>hvm</type><loader readonly='yes' secure='yes' type='pflash'>/usr/share/OVMF/OVMF_CODE.fd</loader></os><devices/></domain>`;
  const h = hw.parseHardwareXml(xml);
  assert.equal(h.firmware, 'uefi');
  assert.equal(h.secure_boot, true);
  assert.equal(h.display, 'none');
  assert.equal(h.network, null);
  assert.deepEqual(h.boot_order, []);
  assert.equal(h.boot_order_source, 'none');
});

test('parseHardwareXml : ordre de demarrage par peripherique (VM creee par vm_create_from_image)', () => {
  const xml = `<domain><os><type>hvm</type></os><devices>
    <interface type='network'><source network='default'/><boot order='3'/></interface>
    <disk type='file' device='cdrom'><source file='/var/lib/libvirt/images/x.iso'/><target dev='sda' bus='sata'/><boot order='1'/></disk>
    <disk type='file' device='disk'><source file='/var/lib/libvirt/images/x.qcow2'/><target dev='vda' bus='virtio'/><boot order='2'/></disk>
  </devices></domain>`;
  const h = hw.parseHardwareXml(xml);
  assert.deepEqual(h.boot_order, ['cdrom', 'hd', 'network']);
  assert.equal(h.boot_order_source, 'devices');
  assert.equal(h.cpu_model, null);
});

test('parseHardwareXml : plusieurs disques (tous, dans l ordre, cdrom exclu) et plusieurs interfaces (la premiere)', () => {
  const xml = `<domain><os><type>hvm</type></os><devices>
    <disk type='file' device='disk'><source file='/var/lib/libvirt/images/sys.qcow2'/><target dev='vda' bus='virtio'/></disk>
    <disk type='file' device='cdrom'><source file='/var/lib/libvirt/images/x.iso'/><target dev='sda' bus='sata'/></disk>
    <disk type='block' device='disk'><source dev='/dev/vg0/data'/><target dev='vdb' bus='virtio'/></disk>
    <disk type='file' device='disk'><target dev='vdc' bus='virtio'/></disk>
    <interface type='bridge'><source bridge='br-lan'/></interface>
    <interface type='network'><source network='default'/></interface>
  </devices></domain>`;
  const h = hw.parseHardwareXml(xml);
  assert.deepEqual(h.disks, [
    { target: 'vda', path: '/var/lib/libvirt/images/sys.qcow2', capacity_gb: null },
    { target: 'vdb', path: '/dev/vg0/data', capacity_gb: null }
  ], 'le cdrom et le disque sans source sont ecartes');
  assert.equal(h.network, 'br-lan');
});

test('parseHardwareXml : les entites XML sont decodees (description, chemins, noms)', () => {
  const xml = `<domain><description>R&amp;D &lt;test&gt; &quot;a&quot; &apos;b&apos;</description><os><type>hvm</type></os>
    <cpu mode='custom'><model>x86-64-v2</model></cpu>
    <devices>
      <disk type='file' device='disk'><source file='/var/lib/libvirt/images/R&amp;D &apos;1&apos;.qcow2'/><target dev='vda' bus='virtio'/></disk>
      <interface type='network'><source network="lan&amp;wifi"/></interface>
    </devices></domain>`;
  const h = hw.parseHardwareXml(xml);
  assert.equal(h.description, `R&D <test> "a" 'b'`);
  assert.equal(h.disks[0].path, `/var/lib/libvirt/images/R&D '1'.qcow2`);
  assert.equal(h.network, 'lan&wifi');
  assert.equal(h.cpu_model, 'x86-64-v2');
});

test('usbHostdevIndex : rang parmi TOUS les hostdev (le PCI compte), insensible a la casse', () => {
  assert.equal(hw.usbHostdevIndex(UEFI, '046d:c52b'), 2);
  assert.equal(hw.usbHostdevIndex(UEFI, '1B1C:1B7F'), 3);
  assert.equal(hw.usbHostdevIndex(UEFI, 'dead:beef'), null);
  assert.equal(hw.usbHostdevIndex(ARCH, '046d:c52b'), null);
});

test('parseBlkList / parseCapacityBytes / parseAutostart : sorties texte de virsh en locale C', () => {
  const out = ' Type   Device   Target   Source\n------------------------------------------------\n file   disk     vda      /var/lib/libvirt/images/a.qcow2\n file   cdrom    sda      -\n\n';
  assert.deepEqual(hw.parseBlkList(out), [
    { type: 'file', device: 'disk', target: 'vda', source: '/var/lib/libvirt/images/a.qcow2' },
    { type: 'file', device: 'cdrom', target: 'sda', source: '-' }
  ]);
  assert.equal(hw.parseCapacityBytes('Capacity:       21474836480\nAllocation:     1\nPhysical:       2\n'), 21474836480);
  assert.equal(hw.parseCapacityBytes('garbage'), null);
  assert.equal(hw.parseAutostart('Name:  a\nAutostart:      enable\n'), true);
  assert.equal(hw.parseAutostart('Autostart:      disable\n'), false);
  assert.equal(hw.parseAutostart(''), null);
  assert.equal(hw.bytesToGb(21474836480), 20);
});

test('vm_hardware : lecture seule, capacite des disques et autostart ajoutes', async () => {
  const sys = installFakeSystem({ domains: { 'arch-base': 'shut off' }, xml: { 'arch-base': ARCH }, capacities: { vda: 21474836480 }, autostart: { 'arch-base': true } });
  const r = await vmHardware.handler({ vm_name: 'arch-base' });
  assert.equal(r.isError, undefined);
  const p = parse(r);
  assert.equal(p.ok, true);
  assert.equal(p.state, 'shut off');
  assert.equal(p.hardware.firmware, 'bios');
  assert.deepEqual(p.hardware.disks, [{ target: 'vda', path: '/var/lib/libvirt/images/arch-base.qcow2', capacity_gb: 20 }]);
  assert.equal(p.hardware.autostart, true);
  assert.deepEqual(sys.mutations(), []);
  assert.deepEqual(sys.writes(), []);
  assert.deepEqual(sys.calls.map((c) => c.args[2]), ['domstate', 'dumpxml', 'dominfo', 'domblkinfo']);
  assert.deepEqual(sys.violations, []);
});

test('vm_hardware : VM inconnue -> VM_NOT_FOUND ; capacite illisible -> null', async () => {
  installFakeSystem({ domains: { 'win-lab': 'running' }, xml: { 'win-lab': UEFI } });
  const p = parse(await vmHardware.handler({ vm_name: 'win-lab' }));
  assert.equal(p.hardware.disks[0].capacity_gb, null);
  assert.equal(p.hardware.autostart, false);
  const unknown = parse(await vmHardware.handler({ vm_name: 'autre' }));
  assert.equal(unknown.code, 'VM_NOT_FOUND');
});
