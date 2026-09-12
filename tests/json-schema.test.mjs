import test from 'node:test';
import assert from 'node:assert/strict';

// Regression : le convertisseur maison exposait un schema vide pour les outils dont le schema Zod est raffine,
// le client MCP ne voyait donc aucun parametre de vm_snapshot ni de backup_create. Necessite npm run build.
const { zodToJsonSchema } = await import('../dist/utils/json-schema.js');
const tools = [];
for (const f of ['vm-controller', 'backup-manager', 'vm-portability']) {
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
