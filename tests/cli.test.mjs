import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Régression : `npx fedora-agents-mcp --help` démarrait le serveur stdio au lieu d'afficher l'aide.
const { cliOutput, packageVersion } = await import('../dist/cli.js');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bin = new URL('../dist/index.js', import.meta.url).pathname;

test('--help et -h renvoient l aide, sans argument on démarre le serveur', () => {
  assert.match(cliOutput(['--help'], '1.0.0'), /MCP_AGENTS_LOG_DIR/);
  assert.match(cliOutput(['-h'], '1.0.0'), /^fedora-agents-mcp 1\.0\.0/);
  assert.equal(cliOutput([], '1.0.0'), null);
});

test('--version lit la version du package.json', () => {
  assert.equal(packageVersion(), pkg.version);
  assert.equal(cliOutput(['--version'], packageVersion()), `fedora-agents-mcp ${pkg.version}\n`);
});

test('le binaire compilé répond à --help sans ouvrir de journal', () => {
  const state = mkdtempSync(path.join(tmpdir(), 'fa-cli-'));
  try {
    const out = spawnSync(process.execPath, [bin, '--help'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, XDG_STATE_HOME: state, MCP_AGENTS_LOG_DIR: path.join(state, 'explicit') },
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Usage: fedora-agents-mcp/);
    assert.equal(out.stderr, '');
    assert.deepEqual(readdirSync(state), [], 'aucun dossier de logs créé pour --help');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
