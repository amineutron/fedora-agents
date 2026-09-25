/**
 * Dossier des journaux (serveur, erreurs, audit).
 *
 * Ordre : MCP_AGENTS_LOG_DIR s'il est défini, /var/log/mcp-agents (service
 * système), puis $XDG_STATE_HOME/mcp-agents (~/.local/state par défaut) pour
 * un utilisateur normal. Pas de repli vers /tmp : le journal d'audit liste les
 * actions sous sudo et ne doit pas être lisible par tous.
 */

import { accessSync, constants, mkdirSync } from 'node:fs';
import path from 'node:path';

export function logDirCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const state = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const list = [env.MCP_AGENTS_LOG_DIR, '/var/log/mcp-agents', path.join(state, 'mcp-agents')];
  return [...new Set(list.filter((d): d is string => Boolean(d)))];
}

export function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveLogDir(candidates: string[], canWrite: (dir: string) => boolean = isWritableDir): string | null {
  for (const dir of candidates) {
    if (canWrite(dir)) return dir;
  }
  return null;
}
