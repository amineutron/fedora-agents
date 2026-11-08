/**
 * Couture d'execution des commandes systeme (virsh, qemu-img, xorriso, virt-builder, curl).
 *
 * Les outils "hub" (vm_pause, vm_create_from_image...) pilotent libvirt directement, sans script
 * bash : ils passent TOUS par `run`. En production `run` appelle l'executeur du depot (journal,
 * audit, delai, spawn sans shell, arguments en tableau). Les tests remplacent l'implementation avec
 * `setRunner` : aucune commande reelle n'est lancee.
 */

import { execute } from './executor.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Nom de l'outil MCP appelant (journal et audit) */
  tool: string;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions
) => Promise<RunResult>;

// Sortie en anglais : les etats libvirt ("running", "shut off") et les messages d'erreur
// sont compares a des chaines fixes, jamais traduites.
const C_LOCALE = { LC_ALL: 'C', LANG: 'C' } as const;

export const executorRunner: CommandRunner = async (command, args, { tool, timeoutMs }) => {
  const result = await execute({
    tool,
    script: command,
    args: [...args],
    toolTimeoutMs: timeoutMs,
    env: { ...C_LOCALE }
  });
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

let active: CommandRunner = executorRunner;

/** Remplace l'executeur (tests). `null` remet l'executeur reel. */
export function setRunner(runner: CommandRunner | null): void {
  active = runner ?? executorRunner;
}

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions
): Promise<RunResult> {
  return active(command, args, options);
}
