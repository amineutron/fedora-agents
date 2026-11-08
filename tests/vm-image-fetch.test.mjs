import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeSystem, parse } from './helpers/fake-system.mjs';

// vm_image_fetch : le faux systeme remplace curl et qemu-img, rien n est telecharge. Necessite npm run build.
const { vmImageFetch, curlArgs } = await import('../dist/tools/vm-image-fetch.js');
const { findImage } = await import('../dist/utils/vm-images.js');

function setup(init = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fa-fetch-'));
  process.env.VM_IMAGES_DIR = dir;
  return { dir, sys: installFakeSystem(init) };
}
const fetchImage = (image_id) => vmImageFetch.handler({ image_id });

test('image cloud du catalogue : telechargee depuis son URL fixe, rangee sous son identifiant', async () => {
  const { dir, sys } = setup();
  const r = parse(await fetchImage('cirros'));
  assert.equal(r.ok, true);
  assert.equal(r.already_present, false);
  assert.equal(r.path, join(dir, 'cirros.img'));
  assert.equal(r.format, 'qcow2');
  const curl = sys.calls.find((c) => c.command === 'curl');
  assert.equal(curl.args.at(-1), findImage('cirros').url, 'l URL est celle du catalogue, jamais une entree');
  assert.deepEqual(readdirSync(dir), ['cirros.img'], 'aucun fichier .part ne reste');
  assert.deepEqual(sys.violations, []);
});

test('curl : https seulement (aussi apres redirection), taille bornee, echec sur erreur HTTP', () => {
  const args = curlArgs('https://example.org/x.qcow2', '/tmp/x.part');
  assert.deepEqual(args.slice(args.indexOf('--proto'), args.indexOf('--proto') + 4), ['--proto', '=https', '--proto-redir', '=https']);
  for (const flag of ['--fail', '--location', '--max-filesize', '--connect-timeout']) assert.ok(args.includes(flag), flag);
  assert.equal(args.at(-1), 'https://example.org/x.qcow2');
  assert.ok(!args.includes('-o') || args.includes('--output'));
});

test('image sans URL (ISO) : refus et consigne de la placer a la main, rien n est lance', async () => {
  const { dir, sys } = setup();
  const r = await fetchImage('alpine');
  assert.equal(r.isError, true);
  assert.match(parse(r).error, new RegExp(`image a placer a la main dans ${dir}`));
  assert.deepEqual(sys.calls, []);
});

test('image virt-builder : rien a telecharger', async () => {
  const { sys } = setup();
  const r = await fetchImage('vb-debian');
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /virt-builder/);
  assert.deepEqual(sys.calls, []);
});

test('image deja presente : aucun telechargement (idempotent)', async () => {
  const { dir, sys } = setup();
  writeFileSync(join(dir, 'debian-cloud.qcow2'), 'x');
  const r = parse(await fetchImage('debian-cloud'));
  assert.equal(r.already_present, true);
  assert.equal(sys.calls.filter((c) => c.command === 'curl').length, 0);
});

test('echec du telechargement : erreur, aucun fichier laisse', async () => {
  const { dir } = setup({ fail: { curl: { stderr: 'curl: (22) 404' } } });
  const r = await fetchImage('debian-cloud');
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /404/);
  assert.deepEqual(readdirSync(dir), []);
});

test('fichier telecharge qui n est pas une image valide : refuse et supprime', async () => {
  const { dir } = setup({ downloadInfo: { format: 'vmdk', 'virtual-size': 1024 } });
  const r = await fetchImage('debian-cloud');
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /refuse/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(existsSync(join(dir, 'debian-cloud.qcow2')), false);
});

test('identifiant hors catalogue : refuse par le schema avant tout appel', async () => {
  const { sys } = setup();
  await assert.rejects(fetchImage('https://evil.example/x.img'));
  await assert.rejects(fetchImage('../../x'));
  assert.deepEqual(sys.calls, []);
});
