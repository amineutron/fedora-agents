import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vm_snapshot list : ligne `Current: <nom>` avant `Total:`. Le script de liste est un FAUX script bash
// (LYRA_SCRIPTS_DIR) qui imprime un exemple ; virsh est simule par la couture du runner. Necessite npm run build.
const scripts = mkdtempSync(join(tmpdir(), 'fa-scripts-'));
const vmDir = join(scripts, 'agents', 'vm-controller');
mkdirSync(vmDir, { recursive: true });
const LISTING = `
Snapshots pour VM: web
============================================
 Name   Creation Time   State
-------------------------------
 base   2026-01-01 10:00:00 +0100   shutoff
   |
   +- avant-maj   2026-02-01 10:00:00 +0100   shutoff

Total: 2 snapshot(s)

Détails: vm-snapshot info web <snapshot-name>`;
writeFileSync(join(vmDir, 'vm-snapshot.sh'), `#!/usr/bin/env bash\nif [ "$2" = "list" ]; then cat <<'EOF'\n${LISTING}\nEOF\nelse echo "action $2 ok"; fi\n`);
chmodSync(join(vmDir, 'vm-snapshot.sh'), 0o755);
process.env.LYRA_SCRIPTS_DIR = scripts;
process.env.MCP_AGENTS_LOG_DIR = mkdtempSync(join(tmpdir(), 'fa-logs-'));

const { installFakeSystem } = await import('./helpers/fake-system.mjs');
const { insertCurrentLine, currentSnapshotName, CURRENT_PREFIX } = await import('../dist/utils/snapshot-current.js');
const { vmSnapshot } = await import('../dist/tools/vm-controller.js');

test('insertCurrentLine place Current: juste avant Total:', () => {
  const out = insertCurrentLine('arbre\n\nTotal: 2 snapshot(s)\n', 'avant-maj');
  assert.equal(out, 'arbre\n\nCurrent: avant-maj\nTotal: 2 snapshot(s)\n');
});

test('insertCurrentLine : sans ligne Total, ajoute en fin ; idempotent ; noms douteux ignores', () => {
  assert.equal(insertCurrentLine('arbre', 'a'), 'arbre\nCurrent: a');
  assert.equal(insertCurrentLine('arbre\n', 'a'), 'arbre\nCurrent: a');
  const once = insertCurrentLine('x\nTotal: 1', 'a');
  assert.equal(insertCurrentLine(once, 'b'), once);
  for (const bad of ['', 'a b', 'a\nTotal: 9', '-x', 'a;b', '$(id)']) assert.equal(insertCurrentLine('x\nTotal: 1', bad), 'x\nTotal: 1', JSON.stringify(bad));
  assert.equal(CURRENT_PREFIX, 'Current: ');
});

test('currentSnapshotName : nom rendu par snapshot-current, null sans snapshot courant', async () => {
  const sys = installFakeSystem({ snapshotCurrent: 'avant-maj' });
  assert.equal(await currentSnapshotName('web'), 'avant-maj');
  assert.deepEqual(sys.calls[0].args, ['-c', 'qemu:///system', 'snapshot-current', '--name', 'web']);
  installFakeSystem({ snapshotCurrent: null });
  assert.equal(await currentSnapshotName('web'), null);
});

test('vm_snapshot list ajoute la ligne Current: avant Total:', async () => {
  installFakeSystem({ snapshotCurrent: 'avant-maj' });
  const r = await vmSnapshot.handler({ vm_name: 'web', action: 'list' });
  assert.equal(r.isError, false);
  const text = r.content[0].text;
  const lines = text.split('\n');
  const total = lines.findIndex((l) => l.startsWith('Total:'));
  assert.equal(lines[total - 1], 'Current: avant-maj');
  assert.equal(lines.filter((l) => l.startsWith('Current:')).length, 1);
  assert.ok(text.includes('+- avant-maj'), 'le format historique est conserve');
});

test('vm_snapshot list sans snapshot courant : sortie inchangee', async () => {
  installFakeSystem({ snapshotCurrent: null });
  const r = await vmSnapshot.handler({ vm_name: 'web', action: 'list' });
  assert.doesNotMatch(r.content[0].text, /Current:/);
  assert.match(r.content[0].text, /Total: 2 snapshot\(s\)/);
});

test('les autres actions de vm_snapshot ne lisent pas le snapshot courant', async () => {
  const sys = installFakeSystem({ snapshotCurrent: 'a' });
  const r = await vmSnapshot.handler({ vm_name: 'web', action: 'create', snapshot_name: 'neuf' });
  assert.match(r.content[0].text, /action create ok/);
  assert.equal(sys.calls.length, 0);
});

// L analyseur de lyra-control-api (parse_snapshots) doit rendre la meme liste avec ou sans la ligne.
// Dossier de lyra-control-api (variable LYRA_API_DIR) : le test est saute quand elle n'est pas definie.
const API = process.env.LYRA_API_DIR ?? '';
test('l analyseur Python de l API ignore la ligne Current:', { skip: !API || !existsSync(join(API, 'lib/vm_parse.py')) }, async () => {
  installFakeSystem({ snapshotCurrent: 'avant-maj' });
  const withLine = (await vmSnapshot.handler({ vm_name: 'web', action: 'list' })).content[0].text;
  const withoutLine = LISTING.trim();
  const parse = (text) => {
    const py = spawnSync('python3', ['-c', 'import sys, json; from lib.vm_parse import parse_snapshots; print(json.dumps(parse_snapshots(sys.stdin.read())))'],
      { cwd: API, input: text, encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    return JSON.parse(py.stdout);
  };
  assert.deepEqual(parse(withLine), parse(withoutLine));
  assert.ok(withLine.includes('Current: avant-maj'));
});
