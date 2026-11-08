import test from 'node:test';
import assert from 'node:assert/strict';

// Regression : le convertisseur maison exposait un schema vide pour les outils dont le schema Zod est raffine,
// le client MCP ne voyait donc aucun parametre de vm_snapshot ni de backup_create. Necessite npm run build.
const { zodToJsonSchema } = await import('../dist/utils/json-schema.js');
const tools = [];
for (const f of ['vm-controller', 'backup-manager', 'vm-portability', 'vm-hub']) {
  const mod = await import(`../dist/tools/${f}.js`);
  for (const value of Object.values(mod)) if (Array.isArray(value)) tools.push(...value);
}
const byName = Object.fromEntries(tools.map((t) => [t.name, zodToJsonSchema(t.inputSchema)]));

test('chaque outil expose un schema objet avec des proprietes', () => {
  for (const [name, schema] of Object.entries(byName)) {
    assert.equal(schema.type, 'object', name);
    assert.ok(schema.properties && typeof schema.properties === 'object', `${name} sans properties`);
  }
});

test('les schemas raffines gardent leurs parametres', () => {
  assert.deepEqual(byName.vm_snapshot.required, ['vm_name', 'action']);
  assert.ok('snapshot_name' in byName.vm_snapshot.properties);
  assert.deepEqual(byName.backup_create.required, ['type']);
  assert.ok('dest' in byName.backup_create.properties);
});

test('le dialecte $schema n est pas repete dans inputSchema', () => {
  assert.ok(Object.values(byName).every((s) => !('$schema' in s)));
});

test('les outils hub exposent leurs parametres, requis et enums', () => {
  assert.deepEqual(byName.vm_pause.required, ['vm_name']);
  assert.deepEqual(byName.vm_reboot.required, ['vm_name']);
  assert.deepEqual(byName.vm_create_from_image.required, ['name', 'image_id']);
  assert.ok(byName.vm_create_from_image.properties.image_id.enum.includes('debian-cloud'));
  for (const field of ['vcpus', 'memory_mib', 'disk_gb', 'network', 'ssh_key', 'hostname', 'user', 'start', 'dry_run']) {
    assert.ok(field in byName.vm_create_from_image.properties, field);
  }
  assert.deepEqual(byName.vm_image_fetch.required, ['image_id']);
  assert.deepEqual(byName.vm_console.properties.type.enum, ['spice', 'vnc', 'auto']);
  assert.ok('lines' in byName.vm_console_log.properties);
  assert.deepEqual(byName.vm_hardware.required, ['vm_name']);
  assert.deepEqual(byName.vm_edit.required, ['vm_name'], 'tous les champs de vm_edit sont facultatifs (au moins un, verifie par le schema)');
  for (const field of ['vcpus', 'memory_mib', 'autostart', 'description', 'cpu_model', 'firmware', 'tpm', 'secure_boot', 'boot_order', 'usb_attach', 'usb_detach', 'display', 'network', 'disk_grow_gb']) {
    assert.ok(field in byName.vm_edit.properties, field);
  }
  assert.deepEqual(byName.vm_edit.properties.cpu_model.enum, ['host-passthrough', 'host-model', 'x86-64-v2', 'qemu64']);
  assert.deepEqual(byName.vm_edit.properties.firmware.enum, ['bios', 'uefi']);
});
