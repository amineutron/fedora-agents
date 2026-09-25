import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Régression : le logger visait seulement /var/log/mcp-agents (non inscriptible pour un
// utilisateur normal) et n'écrivait donc plus que sur stderr ; le journal d'audit des
// actions sous sudo n'existait sur aucun disque. Ces tests portent sur dist/ (compilé par
// `npm run build`, lancé avant `npm test` en CI).
const { logDirCandidates, resolveLogDir } = await import('../dist/log-dir.js');

test('ordre des candidats : réglage explicite, /var/log, puis XDG_STATE_HOME', () => {
  const c = logDirCandidates({ MCP_AGENTS_LOG_DIR: '/srv/logs', XDG_STATE_HOME: '/x/state' }, '/home/user');
  assert.deepEqual(c, ['/srv/logs', '/var/log/mcp-agents', '/x/state/mcp-agents']);
});

test('sans XDG_STATE_HOME, repli sur ~/.local/state', () => {
  const c = logDirCandidates({}, '/home/user');
  assert.deepEqual(c, ['/var/log/mcp-agents', '/home/user/.local/state/mcp-agents']);
});

test('aucun repli vers /tmp (journal d audit lisible par tous)', () => {
  assert.ok(!logDirCandidates({}, '/home/user').some((d) => d.startsWith('/tmp')));
});

test('premier dossier inscriptible retenu', () => {
  const seen = [];
  const dir = resolveLogDir(['/a', '/b', '/c'], (d) => { seen.push(d); return d === '/b'; });
  assert.equal(dir, '/b');
  assert.deepEqual(seen, ['/a', '/b']);
});

test('aucun dossier inscriptible : null (stderr seulement)', () => {
  assert.equal(resolveLogDir(['/a'], () => false), null);
});

test('le logger écrit vraiment le journal d audit dans le dossier résolu', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fa-logs-'));
  const blocked = path.join(root, 'blocked');
  const state = path.join(root, 'state');
  try {
    process.env.MCP_AGENTS_LOG_DIR = blocked;
    process.env.XDG_STATE_HOME = state;
    // dossier explicite non inscriptible -> repli sur XDG_STATE_HOME
    await import('node:fs').then((fs) => { fs.mkdirSync(blocked); chmodSync(blocked, 0o500); });
    const { logger } = await import(`../dist/logger.js?t=${Date.now()}`);
    logger.audit({ tool: 'vm_status', params: {}, user: 'test', result: 'success', duration_ms: 1 });
    logger.close();
    await new Promise((r) => setTimeout(r, 100));
    const dir = path.join(state, 'mcp-agents');
    assert.equal(logger.dir, process.getuid?.() === 0 ? blocked : dir);
    const date = new Date().toISOString().split('T')[0];
    const line = readFileSync(path.join(logger.dir, `audit-${date}.log`), 'utf8').trim();
    assert.equal(JSON.parse(line).tool, 'vm_status');
    assert.equal(statSync(logger.dir).mode & 0o077, 0, 'dossier de logs privé (0700)');
  } finally {
    chmodSync(blocked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("l entrée d audit est sur disque avant qu un process.exit immédiat ne coupe tout", () => {
  // Régression : flux asynchrone, l'entrée d'audit du dernier appel était perdue
  // quand le processus sortait juste après (fermeture de stdin, crash).
  const root = mkdtempSync(path.join(tmpdir(), 'fa-audit-'));
  try {
    const script = `
      const { logger } = await import(${JSON.stringify(new URL('../dist/logger.js', import.meta.url).href)});
      logger.audit({ tool: 'vm_stop', params: { vm: 'x' }, user: 't', result: 'success', duration_ms: 2 });
      process.exit(0);
    `;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, MCP_AGENTS_LOG_DIR: root },
    });
    assert.equal(out.status, 0, out.stderr);
    const date = new Date().toISOString().split('T')[0];
    const line = readFileSync(path.join(root, `audit-${date}.log`), 'utf8').trim();
    assert.equal(JSON.parse(line).tool, 'vm_stop');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
