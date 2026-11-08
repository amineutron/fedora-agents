import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeSystem, parse } from './helpers/fake-system.mjs';

// vm_edit contre un faux virsh / virt-xml / qemu-img (aucune VM reelle). Necessite npm run build.
const { vmEdit, VM_EDIT_NEEDS_STOP, VM_EDIT_HOT, vmEditNeedsStop } = await import('../dist/tools/vm-edit.js');
const { vmEditSchema } = await import('../dist/utils/vm-hub-schemas.js');
const plan = await import('../dist/utils/vm-edit-plan.js');

const ARCH = readFileSync(new URL('./fixtures/arch-base.xml', import.meta.url), 'utf8');
const UEFI = readFileSync(new URL('./fixtures/uefi-tpm.xml', import.meta.url), 'utf8');
const DISK = { type: 'file', device: 'disk', target: 'vda', source: '/var/lib/libvirt/images/arch-base.qcow2' };
const call = (params) => vmEdit.handler(params);
const system = (state, extra = {}) => installFakeSystem({ domains: { vm: state }, xml: { vm: ARCH }, blocks: { vm: [DISK] }, ...extra });

test('constantes exportees et vmEditNeedsStop', () => {
  assert.deepEqual([...VM_EDIT_NEEDS_STOP], ['vcpus', 'memory_mib', 'cpu_model', 'firmware', 'tpm', 'secure_boot', 'disk_grow_gb']);
  assert.deepEqual([...VM_EDIT_HOT], ['usb_attach', 'usb_detach', 'network']);
  assert.equal(vmEditNeedsStop({ vcpus: 2 }), true);
  assert.equal(vmEditNeedsStop({ autostart: true, network: 'default' }), false);
});

test('schema : au moins un champ, secure_boot exige uefi, boot_order sans doublon, usb distincts, strict', () => {
  const bad = (input) => assert.equal(vmEditSchema.safeParse({ vm_name: 'vm', ...input }).success, false, JSON.stringify(input));
  bad({});
  bad({ secure_boot: true });
  bad({ secure_boot: false, firmware: 'bios' });
  bad({ boot_order: ['hd', 'hd'] });
  bad({ boot_order: [] });
  bad({ usb_attach: '046d:c52b', usb_detach: '046D:C52B' });
  bad({ usb_attach: '46d:c52b' });
  bad({ cpu_model: 'Skylake' });
  bad({ disk_grow_gb: 0 });
  bad({ disk_grow_gb: -5 });
  bad({ description: 'a\u0007b' });
  bad({ vcpus: 2, xml: '<x/>' });
  assert.equal(vmEditSchema.safeParse({ vm_name: 'vm', secure_boot: true, firmware: 'uefi' }).success, true);
  assert.equal(vmEditSchema.safeParse({ vm_name: 'vm', tpm: 'true', description: '' }).success, true);
});

test('refus VM en marche pour un champ NEEDS_STOP : aucune commande hormis la lecture d etat', async () => {
  for (const field of [{ vcpus: 4 }, { memory_mib: 2048 }, { cpu_model: 'host-model' }, { firmware: 'uefi' }, { tpm: true }, { disk_grow_gb: 5 }]) {
    const sys = system('running');
    const r = await call({ vm_name: 'vm', autostart: true, ...field });
    assert.equal(r.isError, true, JSON.stringify(field));
    assert.equal(parse(r).code, 'VALIDATION_ERROR');
    assert.equal(parse(r).state, 'running');
    assert.match(parse(r).error, /exige.*une VM arretee/);
    assert.match(parse(r).error, new RegExp(Object.keys(field)[0]));
    assert.deepEqual(sys.calls.map((c) => c.args[2]), ['domstate'], 'autostart n est pas applique non plus');
  }
});

test('vcpus + memoire sur VM arretee : sequence setvcpus --maximum, setvcpus, setmaxmem, setmem (--config, KiB)', async () => {
  const sys = system('shut off');
  const r = await call({ vm_name: 'vm', vcpus: 4, memory_mib: 4096 });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(sys.writes(), [
    'virsh setvcpus vm 4 --maximum --config',
    'virsh setvcpus vm 4 --config',
    'virsh setmaxmem vm 4194304 --config',
    'virsh setmem vm 4194304 --config'
  ]);
  const p = parse(r);
  assert.deepEqual(p.changes, ['vcpus=4', 'memoire=4096MiB']);
  assert.deepEqual(p.applied, ['vcpus', 'memory_mib']);
  assert.equal(p.needs_restart, true);
  assert.deepEqual(p.hot, []);
  assert.match(p.message, /effectif au prochain demarrage/);
  assert.deepEqual(sys.violations, []);
});

test('vcpus : si libvirt refuse --maximum en premier, l ordre inverse est essaye', async () => {
  let maxCalls = 0;
  const sys = system('shut off', { fail: { setvcpus: { stderr: 'error: invalid argument', when: (args) => args.includes('--maximum') && ++maxCalls === 1 } } });
  const r = await call({ vm_name: 'vm', vcpus: 1 });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(sys.writes(), [
    'virsh setvcpus vm 1 --maximum --config',
    'virsh setvcpus vm 1 --config',
    'virsh setvcpus vm 1 --maximum --config'
  ]);
});

test('network a chaud : --update ajoute quand la VM tourne, pas quand elle est arretee', async () => {
  let sys = system('running');
  let r = parse(await call({ vm_name: 'vm', network: 'lab' }));
  assert.deepEqual(sys.writes(), ['virt-xml vm --edit --network network=lab --update']);
  assert.deepEqual(r.hot, ['network']);
  assert.equal(r.needs_restart, false);
  sys = system('shut off');
  r = parse(await call({ vm_name: 'vm', network: 'lab' }));
  assert.deepEqual(sys.writes(), ['virt-xml vm --edit --network network=lab']);
  assert.deepEqual(r.hot, []);
  // reseau deja en place : rien n'est lance
  sys = system('running');
  r = parse(await call({ vm_name: 'vm', network: 'default' }));
  assert.deepEqual(sys.writes(), []);
  assert.deepEqual(r.skipped, ['reseau deja default']);
});

test('secure_boot sans uefi est refuse par le schema avant tout appel', async () => {
  const sys = system('shut off');
  await assert.rejects(call({ vm_name: 'vm', secure_boot: true }));
  await assert.rejects(call({ vm_name: 'vm', secure_boot: true, firmware: 'bios' }));
  assert.deepEqual(sys.calls, []);
});

test('firmware et secure boot : syntaxes virt-xml (uefi seul, uefi + secure boot, retour au bios)', async () => {
  let sys = system('shut off');
  await call({ vm_name: 'vm', firmware: 'uefi' });
  assert.deepEqual(sys.writes(), ['virt-xml vm --edit --boot uefi']);
  sys = system('shut off');
  const r = parse(await call({ vm_name: 'vm', firmware: 'uefi', secure_boot: true }));
  assert.deepEqual(sys.writes(), [
    'virt-xml vm --edit --boot xpath1.delete=./firmware,xpath2.delete=./loader,xpath3.delete=./nvram',
    'virt-xml vm --edit --boot uefi,loader.secure=yes,firmware.feature0.name=secure-boot,firmware.feature0.enabled=yes'
  ]);
  assert.deepEqual(r.applied, ['firmware', 'secure_boot']);
  sys = installFakeSystem({ domains: { vm: 'shut off' }, xml: { vm: UEFI } });
  await call({ vm_name: 'vm', firmware: 'bios' });
  assert.deepEqual(sys.writes(), ['virt-xml vm --edit --boot firmware=bios,xpath1.delete=./loader,xpath2.delete=./nvram,xpath3.delete=./firmware']);
});

test('tpm, cpu_model, display, boot_order : virt-xml --edit / --add-device, sans effet si deja conforme', async () => {
  let sys = system('shut off');
  let r = parse(await call({ vm_name: 'vm', tpm: true, cpu_model: 'host-model', display: 'vnc', boot_order: ['cdrom', 'hd'] }));
  assert.deepEqual(sys.writes(), [
    'virt-xml vm --edit --cpu host-model',
    'virt-xml vm --add-device --tpm default',
    'virt-xml vm --edit --boot cdrom,hd',
    'virt-xml vm --edit --graphics vnc'
  ]);
  assert.deepEqual(r.changes, ['modele cpu=host-model', 'tpm=oui', 'ordre de demarrage=cdrom,hd', 'affichage=vnc']);
  // VM UEFI avec TPM et vnc : tpm=false le retire, display=vnc et tpm=true seraient sans effet
  sys = installFakeSystem({ domains: { vm: 'shut off' }, xml: { vm: UEFI } });
  r = parse(await call({ vm_name: 'vm', tpm: false, display: 'vnc' }));
  assert.deepEqual(sys.writes(), ['virt-xml vm --remove-device --tpm all']);
  assert.deepEqual(r.skipped, ['affichage deja vnc']);
  // sans affichage : --add-device en ecoute locale
  sys = installFakeSystem({ domains: { vm: 'running' }, xml: { vm: ARCH.replace(/<graphics[\s\S]*?<\/graphics>/, '') } });
  r = parse(await call({ vm_name: 'vm', display: 'spice' }));
  assert.deepEqual(sys.writes(), ['virt-xml vm --add-device --graphics spice,listen=127.0.0.1']);
  assert.equal(r.needs_restart, true, 'VM en marche : effectif au prochain demarrage');
});

test('boot_order sur une VM a ordre par peripherique : les <boot order> sont effaces d abord', async () => {
  const xml = ARCH.replace("<boot dev='hd'/>", '').replace("<target dev='vda' bus='virtio'/>", "<target dev='vda' bus='virtio'/><boot order='1'/>");
  const sys = installFakeSystem({ domains: { vm: 'shut off' }, xml: { vm: xml } });
  await call({ vm_name: 'vm', boot_order: ['hd', 'cdrom', 'network'] });
  assert.deepEqual(sys.writes(), [
    'virt-xml vm --edit all --disk xpath1.delete=./boot',
    'virt-xml vm --edit all --network xpath1.delete=./boot',
    'virt-xml vm --edit --boot hd,cdrom,network'
  ]);
});

test('usb : attache par xpath (sans recherche sur l hote), detache par rang du hostdev, --update a chaud', async () => {
  let sys = installFakeSystem({ domains: { vm: 'running' }, xml: { vm: UEFI } });
  let r = parse(await call({ vm_name: 'vm', usb_detach: '046D:C52B', usb_attach: 'dead:beef' }));
  assert.deepEqual(sys.writes(), [
    'virt-xml vm --remove-device --hostdev 2 --update',
    'virt-xml vm --add-device --hostdev type=usb,xpath1.set=./source/vendor/@id,xpath1.value=0xdead,xpath2.set=./source/product/@id,xpath2.value=0xbeef --update'
  ]);
  assert.deepEqual(r.hot, ['usb_detach', 'usb_attach']);
  assert.deepEqual(r.changes, ['usb detache=046d:c52b', 'usb attache=dead:beef']);
  // deja attache / deja absent : rien a faire
  sys = installFakeSystem({ domains: { vm: 'shut off' }, xml: { vm: UEFI } });
  r = parse(await call({ vm_name: 'vm', usb_attach: '046d:c52b', usb_detach: 'dead:beef' }));
  assert.deepEqual(sys.writes(), []);
  assert.deepEqual(r.skipped, ['peripherique dead:beef non attache', 'peripherique 046d:c52b deja attache']);
  assert.match(r.message, /rien a modifier/);
});

test('disk_grow_gb : qemu-img resize +NG sur le premier disque fichier ; hors /var/lib/libvirt refuse', async () => {
  let sys = system('shut off', { capacities: { vda: 1 } });
  const r = parse(await call({ vm_name: 'vm', disk_grow_gb: 10 }));
  assert.deepEqual(sys.writes(), ['qemu-img resize /var/lib/libvirt/images/arch-base.qcow2 +10G']);
  assert.deepEqual(r.changes, ['disque vda +10G']);
  assert.equal(r.needs_restart, true);

  sys = installFakeSystem({ domains: { vm: 'shut off' }, xml: { vm: ARCH }, blocks: { vm: [{ ...DISK, source: '/mnt/backup_cold/libvirt-images/x.qcow2' }] } });
  let bad = await call({ vm_name: 'vm', disk_grow_gb: 10, autostart: true });
  assert.equal(bad.isError, true);
  assert.equal(parse(bad).code, 'VALIDATION_ERROR');
  assert.match(parse(bad).error, /n'est pas sous \/var\/lib\/libvirt/);
  assert.deepEqual(sys.writes(), [], 'refus AVANT toute modification, autostart compris');

  sys = installFakeSystem({ domains: { vm: 'shut off' }, xml: { vm: ARCH }, blocks: { vm: [{ ...DISK, device: 'cdrom', source: '-' }] } });
  bad = await call({ vm_name: 'vm', disk_grow_gb: 1 });
  assert.match(parse(bad).error, /aucun disque/);
});

test('erreur a mi-chemin : arret immediat, applied partiel, champ en echec nomme', async () => {
  const sys = system('shut off', { fail: { setmaxmem: { stderr: 'error: cannot set memory' } } });
  const r = await call({ vm_name: 'vm', vcpus: 2, memory_mib: 8192, autostart: true });
  assert.equal(r.isError, true);
  const p = parse(r);
  assert.equal(p.code, 'SCRIPT_ERROR');
  assert.match(p.error, /memoire=8192MiB : error: cannot set memory/);
  assert.deepEqual(p.applied, ['vcpus']);
  assert.deepEqual(p.changes, ['vcpus=2']);
  assert.deepEqual(p.failed, ['memory_mib']);
  assert.ok(!sys.writes().some((w) => w.startsWith('virsh autostart')), 'les champs suivants ne sont pas appliques');
  // les deux ordres de setmaxmem/setmem ont ete essayes
  assert.equal(sys.writes().filter((w) => w.startsWith('virsh setmaxmem')).length, 2);
});

test('autostart et description : virsh autostart [--disable], virsh desc --config --new-desc (chaine vide = effacer)', async () => {
  let sys = system('running');
  let r = parse(await call({ vm_name: 'vm', autostart: true, description: 'serveur web' }));
  assert.deepEqual(sys.writes(), ['virsh autostart vm', 'virsh desc vm --config --new-desc serveur web']);
  assert.deepEqual(r.changes, ['autostart=true', 'description']);
  assert.equal(r.needs_restart, false);
  sys = system('paused');
  r = parse(await call({ vm_name: 'vm', autostart: 'false', description: '' }));
  assert.deepEqual(sys.writes(), ['virsh autostart --disable vm', 'virsh desc vm --config --new-desc ']);
  assert.deepEqual(r.changes, ['autostart=false', 'description effacee']);
});

test('VM inconnue -> VM_NOT_FOUND ; dumpxml en echec -> SCRIPT_ERROR sans modification', async () => {
  installFakeSystem({ domains: {} });
  assert.equal(parse(await call({ vm_name: 'fantome', autostart: true })).code, 'VM_NOT_FOUND');
  const sys = installFakeSystem({ domains: { vm: 'shut off' } });
  const r = await call({ vm_name: 'vm', autostart: true });
  assert.equal(parse(r).code, 'SCRIPT_ERROR');
  assert.deepEqual(sys.writes(), []);
});

test('plan pur : needsRestart et hotFields', () => {
  assert.equal(plan.needsRestart(['vcpus'], 'shut off'), true);
  assert.equal(plan.needsRestart(['autostart', 'description'], 'running'), false);
  assert.equal(plan.needsRestart(['network'], 'running'), false);
  assert.equal(plan.needsRestart(['network'], 'paused'), true, 'VM en pause : pas de --update, effectif au prochain demarrage');
  assert.equal(plan.needsRestart(['boot_order'], 'running'), true);
  assert.equal(plan.needsRestart(['boot_order'], 'shut off'), false);
  assert.deepEqual(plan.hotFields(['network', 'autostart', 'usb_attach'], 'running'), ['network', 'usb_attach']);
  assert.deepEqual(plan.hotFields(['network'], 'paused'), []);
  assert.deepEqual(plan.growableDisk(null), { ok: false, message: 'disk_grow_gb : aucun disque de type fichier sur cette VM' });
});
