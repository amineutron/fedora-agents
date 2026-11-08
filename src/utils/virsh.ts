/**
 * Aides virsh communes aux outils "hub" : connexion fixe, etat d'un domaine, resultats JSON.
 */

import { ErrorCode } from '../config.js';
import type { ToolResult } from '../tools/vm-controller.js';
import { run, type RunResult } from './runner.js';

/** libvirt se pilote sans sudo (groupe libvirt, polkit) sur la session systeme. */
export const LIBVIRT_URI = 'qemu:///system';

const DEFAULT_TIMEOUT_MS = 30_000;

export function virsh(tool: string, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  return run('virsh', ['-c', LIBVIRT_URI, ...args], { tool, timeoutMs });
}

export type DomainState = 'running' | 'paused' | 'shut off' | 'in shutdown' | 'crashed' | 'pmsuspended' | 'unknown';

export type StateLookup =
  | { ok: true; state: DomainState }
  | { ok: false; code: ErrorCode; message: string };

const NOT_FOUND = /failed to get domain|domain not found|no domain with matching name/i;

export function normalizeState(raw: string): DomainState {
  const s = raw.trim().toLowerCase();
  // "idle" : domaine en marche sans activite
  if (s === 'running' || s === 'idle') return 'running';
  if (s === 'paused' || s === 'shut off' || s === 'in shutdown' || s === 'crashed' || s === 'pmsuspended') return s;
  return 'unknown';
}

export async function getDomainState(tool: string, vm: string): Promise<StateLookup> {
  const r = await virsh(tool, ['domstate', vm]);
  if (r.code === 0) return { ok: true, state: normalizeState(r.stdout) };
  if (NOT_FOUND.test(r.stderr)) {
    return { ok: false, code: ErrorCode.VM_NOT_FOUND, message: `VM '${vm}' introuvable` };
  }
  return { ok: false, code: ErrorCode.SCRIPT_ERROR, message: r.stderr || `virsh domstate a echoue (code ${r.code})` };
}

/** Lignes non vides d'une sortie `virsh ... --name`. */
export function nameLines(stdout: string): string[] {
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

export function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }, null, 2) }] };
}

export function fail(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code, error: message, ...extra }, null, 2) }],
    isError: true
  };
}

/**
 * Attente active : verifie d'abord, dort ensuite. Reglages reserves aux tests :
 * `VM_HUB_POLL_MS` (intervalle) et `VM_HUB_TIME_SCALE` (facteur applique au delai).
 */
export async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const interval = Number(process.env.VM_HUB_POLL_MS) > 0 ? Number(process.env.VM_HUB_POLL_MS) : 1000;
  const scale = Number(process.env.VM_HUB_TIME_SCALE) > 0 ? Number(process.env.VM_HUB_TIME_SCALE) : 1;
  const deadline = Date.now() + timeoutMs * scale;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
