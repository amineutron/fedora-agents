import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeSystem, parse } from './helpers/fake-system.mjs';

// vm_create_from_image contre un faux systeme (aucune VM, aucun volume, aucun disque reels). Necessite npm run build.
const { vmCreateFromImage } = await import('../dist/tools/vm-create.js');
const GIB = 1024 ** 3;
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host';

/** Dossier d'images temporaire + faux systeme ; `files` = noms deja presents -> sortie de qemu-img info */
function setup(files = {}, init = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fa-create-'));
  process.env.VM_IMAGES_DIR = dir;
  const images = {};
  for (const [name, info] of Object.entries(files)) {
    writeFileSync(join(dir, name), Buffer.alloc(4096));
    images[realpathSync(join(dir, name))] = info;
  }
  const sys = installFakeSystem({ ...init, images: { ...images, ...(init.images ?? {}) } });
  return { dir, sys };
}
const create = (params) => vmCreateFromImage.handler({ name: 'lab', image_id: 'debian-cloud', ssh_key: KEY, ...params });
const debian = { 'debian-cloud.qcow2': { format: 'qcow2', 'virtual-size': 3 * GIB } };

test('dry_run : decrit les etapes et ne modifie rien', async () => {
  const { sys } = setup(debian);
  const r = parse(await create({ dry_run: true, disk_gb: 20, vcpus: 4, memory_mib: 2048 }));
  assert.equal(r.dry_run, true);
  assert.ok(r.steps.length >= 4);
  assert.match(r.steps.join('\n'), /vol-upload/);
  assert.match(r.steps.join('\n'), /vol-resize/);
  assert.deepEqual(sys.mutations(), []);
  assert.equal(sys.calls.filter((c) => c.command === 'xorriso').length, 0);
  assert.deepEqual(sys.violations, []);
});

test('dry_run applique les memes refus que la creation', async () => {
  const { sys } = setup(debian, { domains: { lab: 'running' } });
  const r = await create({ dry_run: true });
  assert.equal(r.isError, true);
  assert.deepEqual(sys.mutations(), []);
});

test('refuse un nom deja pris par une VM', async () => {
  const { sys } = setup(debian, { domains: { lab: 'shut off' } });
  const r = await create({});
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /deja pris/);
  assert.deepEqual(sys.mutations(), []);
});

test('refuse un volume deja present dans le pool', async () => {
  const { sys } = setup(debian, { volumes: ['lab.qcow2'] });
  const r = await create({});
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /lab\.qcow2.*existe deja/);
  assert.deepEqual(sys.mutations(), []);
});

test('refuse un reseau inconnu', async () => {
  const { sys } = setup(debian);
  const r = await create({ network: 'inconnu' });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /inconnu.*introuvable/);
  assert.deepEqual(sys.mutations(), []);
});

test('image cloud avec URL absente du dossier : propose vm_image_fetch', async () => {
  const { dir, sys } = setup({});
  const r = parse(await create({}));
  assert.equal(r.ok, false);
  assert.match(r.error, /vm_image_fetch image_id=debian-cloud/);
  assert.equal(r.images_dir, dir);
  assert.deepEqual(sys.mutations(), []);
});

test('ISO absente : image a placer a la main dans le dossier d images', async () => {
  const { dir } = setup({});
  const r = parse(await create({ image_id: 'alpine' }));
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(`image a placer a la main dans ${dir}`));
});

test('refuse un disque plus petit que l image', async () => {
  const { sys } = setup(debian);
  const r = await create({ disk_gb: 2 });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /plus petit que l'image \(3 Go\)/);
  assert.deepEqual(sys.mutations(), []);
});

test('accepte un disque egal a la taille de l image (aucun agrandissement)', async () => {
  const { sys } = setup(debian);
  const r = await create({ disk_gb: 3 });
  assert.equal(r.isError, undefined);
  assert.equal(sys.virshCalls('vol-resize').length, 0);
});

test('refuse une image qcow2 avec fichier de base ou un format inconnu', async () => {
  for (const info of [{ format: 'qcow2', 'virtual-size': GIB, 'backing-filename': '/etc/shadow' }, { format: 'vmdk', 'virtual-size': GIB }]) {
    const { sys } = setup({ 'debian-cloud.qcow2': info });
    const r = await create({});
    assert.equal(r.isError, true);
    assert.match(parse(r).error, /refusee/);
    assert.deepEqual(sys.mutations(), []);
  }
});

test('un lien vers un fichier hors du dossier d images n est pas une image', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'fa-out-'));
  writeFileSync(join(outside, 'x.qcow2'), 'x');
  const { dir, sys } = setup({});
  symlinkSync(join(outside, 'x.qcow2'), join(dir, 'debian-cloud.qcow2'));
  const r = await create({});
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /absente/);
  assert.deepEqual(sys.mutations(), []);
});

test('virt-builder exige une cle ssh', async () => {
  const { sys } = setup({});
  const r = await create({ image_id: 'vb-debian', ssh_key: undefined });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /ssh_key requis/);
  assert.deepEqual(sys.mutations(), []);
});

test('cloud : copie, agrandissement, graine cloud-init, definition, rien d autre', async () => {
  const { dir, sys } = setup(debian);
  const r = parse(await create({ disk_gb: 20, vcpus: 4, memory_mib: 4096, hostname: 'labo', user: 'ops' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.vm, r.vcpus, r.memory_mib, r.disk_gb, r.started, r.user], ['lab', 4, 4096, 20, false, 'ops']);
  assert.deepEqual(r.volumes, ['lab.qcow2', 'lab-seed.iso']);
  assert.deepEqual(sys.mutations(), ['vol-create-as', 'vol-upload', 'vol-resize', 'vol-create-as', 'vol-upload', 'define']);
  assert.deepEqual(sys.virshCalls('vol-resize')[0].args.slice(3), ['--pool', 'default', 'lab.qcow2', String(20 * GIB)]);
  assert.deepEqual(sys.virshCalls('vol-create-as')[0].args.slice(3), ['default', 'lab.qcow2', String(3 * GIB), '--format', 'qcow2']);
  assert.deepEqual(sys.uploads.map((u) => u.name), ['lab.qcow2', 'lab-seed.iso']);
  assert.match(sys.uploads[0].file, /debian-cloud\.qcow2$/);
  assert.equal(sys.virshCalls('start').length, 0);
  assert.deepEqual(sys.violations, []);
  // les fichiers de travail sont supprimes
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.work-')), []);
  // la VM est definie sur le reseau demande, ecran en local seulement, disques aux chemins rendus par libvirt
  const xml = sys.defined[0].xml;
  assert.match(xml, /<name>lab<\/name>/);
  assert.match(xml, /<memory unit='MiB'>4096<\/memory>/);
  assert.match(xml, /<vcpu placement='static'>4<\/vcpu>/);
  assert.match(xml, /<source network='default'\/>/);
  assert.match(xml, /<listen type='address' address='127\.0\.0\.1'\/>/);
  assert.match(xml, /<source file='\/var\/lib\/libvirt\/images\/lab\.qcow2'\/>/);
  assert.match(xml, /<source file='\/var\/lib\/libvirt\/images\/lab-seed\.iso'\/>/);
  assert.doesNotMatch(xml, new RegExp(dir));
});

test('cloud : la graine cloud-init porte la cle, le compte et le nom d hote entre guillemets', async () => {
  const { sys } = setup(debian);
  await create({ hostname: 'labo', user: 'ops' });
  const xorriso = sys.calls.find((c) => c.command === 'xorriso');
  assert.deepEqual(xorriso.args.slice(0, 6), ['-as', 'mkisofs', '-quiet', '-V', 'cidata', '-J']);
  const [seed] = sys.seeds;
  assert.equal(seed.label, 'cidata');
  assert.match(seed.userData, /^#cloud-config\n/);
  assert.match(seed.userData, /hostname: "labo"/);
  assert.match(seed.userData, /- name: "ops"/);
  assert.ok(seed.userData.includes(`- "${KEY}"`));
  assert.match(seed.userData, /ssh_pwauth: false/);
  assert.match(seed.metaData, /instance-id: ".+"\nlocal-hostname: "labo"\n/);
});

test('cloud : compte par defaut de l image quand user est absent, avertissement sans cle ssh', async () => {
  setup(debian);
  const r = parse(await create({ ssh_key: undefined }));
  assert.equal(r.ok, true);
  assert.equal(r.user, 'debian');
  assert.equal(r.ssh_key, false);
  assert.match(r.warnings.join(' '), /aucune cle ssh/);
});

test('cloud : start=true demarre la VM', async () => {
  const { sys } = setup(debian);
  const r = parse(await create({ start: true }));
  assert.equal(r.started, true);
  assert.deepEqual(sys.mutations().slice(-2), ['define', 'start']);
});

test('cloud : un demarrage en echec ne defait pas la creation, il est signale', async () => {
  const { sys } = setup(debian, { fail: { start: { stderr: 'error: no space' } } });
  const r = parse(await create({ start: true }));
  assert.equal(r.ok, true);
  assert.equal(r.started, false);
  assert.match(r.warnings.join(' '), /demarrage a echoue/);
  assert.equal(sys.defined.length, 1);
  assert.equal(sys.virshCalls('undefine').length, 0);
});

test('echec de la copie : les volumes crees sont supprimes, la VM n est pas definie', async () => {
  const { dir, sys } = setup(debian, { fail: { 'vol-upload': { stderr: 'error: upload failed' } } });
  const r = await create({});
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /copie vers le volume lab\.qcow2/);
  assert.deepEqual(parse(r).rolled_back, ['volume lab.qcow2']);
  assert.equal(sys.volumes.has('lab.qcow2'), false);
  assert.equal(sys.defined.length, 0);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.work-')), []);
});

test('echec de la definition : volumes supprimes, aucune VM laissee', async () => {
  const { sys } = setup(debian, { fail: { define: { stderr: 'error: invalid XML' } } });
  const r = await create({});
  assert.equal(r.isError, true);
  assert.deepEqual(parse(r).rolled_back.sort(), ['volume lab-seed.iso', 'volume lab.qcow2']);
  assert.equal(sys.volumes.size, 0);
});

test('virt-builder : image assemblee avec cle ssh, nom d hote et compte demande', async () => {
  const { sys } = setup({});
  const r = parse(await create({ image_id: 'vb-debian', disk_gb: 12, hostname: 'vb1', user: 'ops' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.user, 'ops');
  const vb = sys.calls.find((c) => c.command === 'virt-builder');
  assert.deepEqual(vb.args.slice(0, 1), ['debian-12']);
  for (const piece of ['--format', 'qcow2', '--size', '12G', '--hostname', 'vb1', '--root-password', 'disabled']) assert.ok(vb.args.includes(piece), piece);
  assert.ok(vb.args.includes(`root:string:${KEY}`));
  assert.ok(vb.args.includes(`ops:string:${KEY}`));
  assert.ok(vb.args.includes('useradd -m -s /bin/bash ops'));
  assert.deepEqual(sys.mutations(), ['vol-create-as', 'vol-upload', 'define']);
  assert.equal(sys.calls.filter((c) => c.command === 'xorriso').length, 0);
});

test('virt-builder : echec de l assemblage, rien n est cree', async () => {
  const { sys } = setup({}, { fail: { 'virt-builder': {} } });
  const r = await create({ image_id: 'vb-fedora' });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /virt-builder/);
  assert.deepEqual(sys.mutations(), []);
});

test('ISO : disque vide, ISO copiee, demarrage sur le lecteur', async () => {
  const { sys } = setup({ 'alpine.iso': {} });
  const r = parse(await create({ image_id: 'alpine', ssh_key: KEY, user: 'x', disk_gb: 8 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.volumes, ['lab.qcow2', 'lab-install.iso']);
  assert.equal(r.user, null);
  assert.match(r.warnings.join(' '), /ignores/);
  assert.deepEqual(sys.virshCalls('vol-create-as')[0].args.slice(3), ['default', 'lab.qcow2', String(8 * GIB), '--format', 'qcow2']);
  assert.deepEqual(sys.virshCalls('vol-create-as')[1].args.slice(3), ['default', 'lab-install.iso', '4096', '--format', 'raw']);
  assert.equal(sys.calls.filter((c) => c.command === 'xorriso' || c.command === 'virt-builder').length, 0);
  const xml = sys.defined[0].xml;
  assert.match(xml, /device='cdrom'[\s\S]*?<boot order='1'\/>[\s\S]*device='disk'[\s\S]*?<boot order='2'\/>/);
});

test('le pool vient de VM_HUB_POOL et n est jamais pris dans les parametres', async () => {
  const { sys } = setup(debian);
  process.env.VM_HUB_POOL = 'fast';
  try {
    await create({});
  } finally {
    delete process.env.VM_HUB_POOL;
  }
  assert.ok(sys.virshCalls('vol-create-as').every((c) => c.args[3] === 'fast'));
});

test('arguments invalides refuses avant tout appel (nom, image, cle)', async () => {
  const { sys } = setup(debian);
  for (const bad of [{ name: 'a;b' }, { name: '--x' }, { image_id: 'https://evil/x.img' }, { ssh_key: 'echo pwned' }, { network: 'a b' }]) {
    await assert.rejects(create(bad));
  }
  assert.deepEqual(sys.calls, []);
});

test('le dossier d images n est jamais cree sans besoin ni laisse avec des fichiers de travail', async () => {
  const { dir } = setup(debian);
  await create({});
  assert.ok(existsSync(dir));
  assert.deepEqual(readdirSync(dir), ['debian-cloud.qcow2']);
});

test('le XML rejette un chemin de volume non sur', async () => {
  const { buildDomainXml } = await import('../dist/utils/vm-domain-xml.js');
  const spec = { name: 'x', memoryMib: 512, vcpus: 1, network: 'default', serialLogPath: '/var/log/libvirt/qemu/x.log' };
  const disk = (path) => ({ path, format: 'qcow2', device: 'disk', target: 'vda' });
  assert.throws(() => buildDomainXml({ ...spec, disks: [disk("/a'/><x")] }), /refuse/);
  assert.throws(() => buildDomainXml({ ...spec, disks: [disk('/a/../b')] }), /refuse/);
  assert.throws(() => buildDomainXml({ ...spec, disks: [disk('relatif.qcow2')] }), /refuse/);
  assert.match(buildDomainXml({ ...spec, disks: [disk('/var/lib/libvirt/images/x.qcow2')] }), /x\.qcow2/);
  assert.equal(readFileSync(new URL('../dist/utils/vm-domain-xml.js', import.meta.url), 'utf8').includes('sudo'), false);
});
