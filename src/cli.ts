/**
 * Ligne de commande : `--help` et `--version` répondent sans démarrer le
 * serveur ni ouvrir de journal (avant, `npx fedora-agents-mcp --help`
 * lançait le serveur stdio).
 */

import { readFileSync } from 'node:fs';

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version);
  } catch {
    return 'dev';
  }
}

export function helpText(version: string): string {
  return [
    `fedora-agents-mcp ${version}`,
    '',
    'MCP server (stdio) for KVM/libvirt VMs and backups (Timeshift, Borg) on Fedora.',
    'Each tool runs a dedicated script through a per-script sudoers rule; destructive',
    'tools require confirm=true and every call is written to a JSON audit log.',
    '',
    'Usage: fedora-agents-mcp            start the server on stdio (for an MCP client)',
    '       fedora-agents-mcp --help     show this help',
    '       fedora-agents-mcp --version  show the version',
    '',
    'Environment:',
    '  MCP_AGENTS_LOG_DIR   log directory (default /var/log/mcp-agents, then',
    '                       $XDG_STATE_HOME/mcp-agents, i.e. ~/.local/state/mcp-agents)',
    '',
    'Docs: https://github.com/amineutron/fedora-agents#readme',
    '',
  ].join('\n');
}

/** Texte à afficher pour ces arguments, ou null pour démarrer le serveur. */
export function cliOutput(argv: string[], version: string): string | null {
  if (argv.includes('--help') || argv.includes('-h')) return helpText(version);
  if (argv.includes('--version') || argv.includes('-v')) return `fedora-agents-mcp ${version}\n`;
  return null;
}
