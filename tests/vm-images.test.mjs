import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const img = await import('../dist/utils/vm-images.js');

// Meme catalogue que lyra-control-api (lib/vm_library.py) : l'ecran et l'API designent les images par ces identifiants.
// Variable LYRA_API_DIR = dossier de lyra-control-api ; le test est saute quand elle n'est pas definie.
const PY = process.env.LYRA_API_DIR ? join(process.env.LYRA_API_DIR, 'lib/vm_library.py') : '';
test('ids, formats et sources recopient le catalogue de l API', { skip: !PY || !existsSync(PY) }, () => {
  const rows = [...readFileSync(PY, 'utf8').matchAll(/\{'id': '([^']+)'.*?'fmt': '([^']+)'.*?'src': '([^']+)'/g)]
    .map(([, id, fmt, src]) => ({ id, fmt, src }));
  assert.ok(rows.length >= 25);
  assert.deepEqual(img.IMAGE_CATALOGUE.map(({ id, fmt, src }) => ({ id, fmt, src })), rows);
});

test('les identifiants sont uniques', () => {
  assert.equal(new Set(img.IMAGE_IDS).size, img.IMAGE_IDS.length);
});

test('seules les images cloud portent une URL, toujours en https, sans identifiants dans l URL', () => {
  for (const e of img.IMAGE_CATALOGUE) {
    if (e.url === undefined) continue;
    assert.equal(e.fmt, 'cloud', `${e.id}: url sur une image non cloud`);
    const u = new URL(e.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.username + u.password + u.search, '');
    assert.ok(u.hostname.endsWith(e.src) || e.src.endsWith(u.hostname) || u.hostname.includes(e.src.split('.').slice(-2).join('.')), `${e.id}: hote ${u.hostname} loin de src ${e.src}`);
  }
});

test('les images virt-builder portent un modele, les cloud un compte par defaut', () => {
  for (const e of img.IMAGE_CATALOGUE) {
    if (e.fmt === 'vb') assert.match(e.vbTemplate ?? '', /^[a-z]+-\d+$/, e.id);
    if (e.fmt === 'cloud') assert.match(e.defaultUser ?? '', /^[a-z][a-z0-9_-]*$/, e.id);
  }
});

test('convention de nom : identifiant avant le premier point ou id_ en prefixe, le tiret n est pas un separateur', () => {
  const m = img.matchesImageName;
  assert.equal(m('debian-cloud.qcow2', 'debian-cloud', 'cloud'), true);
  assert.equal(m('Debian-Cloud.QCOW2', 'debian-cloud', 'cloud'), true);
  assert.equal(m('debian-cloud_12.5.img', 'debian-cloud', 'cloud'), true);
  assert.equal(m('alpine-std.iso', 'alpine', 'iso'), false);
  assert.equal(m('alpine_3.22.iso', 'alpine', 'iso'), true);
  assert.equal(m('debian-cloud.qcow2.part', 'debian-cloud', 'cloud'), false);
  assert.equal(m('.debian-cloud.qcow2', 'debian-cloud', 'cloud'), false);
  assert.equal(m('alpine.qcow2', 'alpine', 'iso'), false);   // extension qui ne va pas avec le format
  assert.equal(m('x.iso', 'x', 'vb'), false);
});

test('findCachedImage : fichier ordinaire du dossier, jamais un lien qui en sort', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-img-'));
  const dir = join(root, 'images');
  const outside = join(root, 'secret');
  mkdirSync(dir);
  mkdirSync(outside);
  writeFileSync(join(outside, 'cirros.qcow2'), 'x');
  const cirros = img.findImage('cirros');

  assert.equal(await img.findCachedImage(dir, cirros), null);
  assert.equal(await img.findCachedImage(join(root, 'absent'), cirros), null);

  symlinkSync(join(outside, 'cirros.qcow2'), join(dir, 'cirros.qcow2'));
  assert.equal(await img.findCachedImage(dir, cirros), null, 'un lien vers l exterieur est refuse');

  writeFileSync(join(dir, 'cirros_0.6.img'), 'x');
  const found = await img.findCachedImage(dir, cirros);
  assert.match(found, /cirros_0\.6\.img$/);
});

test('findCachedImage : un dossier au nom d image n est pas un fichier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-img-'));
  mkdirSync(join(dir, 'cirros.qcow2'));
  assert.equal(await img.findCachedImage(dir, img.findImage('cirros')), null);
});

test('imagesDir et poolName : surcharge par l environnement, valeur invalide ignoree', () => {
  assert.equal(img.imagesDir({ VM_IMAGES_DIR: '/data/img' }), '/data/img');
  assert.match(img.imagesDir({}), /\/vm-images$/);
  assert.equal(img.poolName({ VM_HUB_POOL: 'fast' }), 'fast');
  assert.equal(img.poolName({ VM_HUB_POOL: 'a b; rm' }), 'default');
  assert.equal(img.poolName({}), 'default');
});

test('extension de telechargement deduite de l URL du catalogue', () => {
  assert.equal(img.downloadExtension(img.findImage('cirros')), '.img');
  assert.equal(img.downloadExtension(img.findImage('debian-cloud')), '.qcow2');
  assert.equal(img.downloadExtension(img.findImage('ubuntu-cloud')), '.img');
});

test('tailles : arrondi au Go superieur', () => {
  assert.equal(img.gibCeil(1), 1);
  assert.equal(img.gibCeil(1024 ** 3), 1);
  assert.equal(img.gibCeil(1024 ** 3 + 1), 2);
  assert.equal(img.bytesFromGib(2), 2 * 1024 ** 3);
});
