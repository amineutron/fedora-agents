/**
 * `vm_snapshot list` : ligne du snapshot courant.
 *
 * La liste (script kvm-snapshot.sh) se termine par `Total: N snapshot(s)`. On y ajoute, juste AVANT cette
 * ligne, `Current: <nom>` (nom rendu par `virsh snapshot-current --name`). Le format historique est inchange
 * (l'analyseur existant de lyra-control-api ignore la ligne : le nom contient `:` et un espace) ; un client
 * qui la connait lit le snapshot courant. Pas de snapshot courant : aucune ligne.
 */

import { virsh } from './virsh.js';

export const CURRENT_PREFIX = 'Current: ';

// Nom sur, sans espace ni retour a la ligne : la ligne reste analysable, rien n'est injecte dans la sortie
const SAFE_SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Insere `Current: <nom>` avant la ligne `Total:` (a defaut, en fin de sortie). Idempotent. */
export function insertCurrentLine(output: string, current: string): string {
  if (!SAFE_SNAPSHOT_NAME.test(current)) return output;
  const lines = output.split('\n');
  if (lines.some((l) => l.startsWith(CURRENT_PREFIX))) return output;
  const line = `${CURRENT_PREFIX}${current}`;
  const total = lines.findIndex((l) => l.trimStart().startsWith('Total:'));
  if (total === -1) return `${output}${output.endsWith('\n') || output === '' ? '' : '\n'}${line}`;
  return [...lines.slice(0, total), line, ...lines.slice(total)].join('\n');
}

/** Nom du snapshot courant d'une VM, ou null (aucun snapshot courant, VM sans snapshot, erreur). */
export async function currentSnapshotName(vm: string): Promise<string | null> {
  const r = await virsh('vm_snapshot', ['snapshot-current', '--name', vm]);
  if (r.code !== 0) return null;
  const name = r.stdout.trim();
  return name === '' ? null : name;
}
