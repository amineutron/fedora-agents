/**
 * Outil MCP : vm_edit. Modifie le materiel et les reglages d'une VM (liste FERMEE de champs) par
 * virsh et virt-xml, sans script bash ni XML libre.
 *
 * Tout est valide avant de toucher a libvirt ; les champs sont ensuite appliques dans un ordre fixe
 * et, a la premiere erreur, l'outil s'arrete en rendant ce qui a deja ete applique.
 */

import { ErrorCode } from '../config.js';
import { run } from '../utils/runner.js';
import { fail, getDomainState, ok, virsh } from '../utils/virsh.js';
import { growableDisk, hotFields, needsRestart, needsStopMessage, planEdit, type Command, type EditStep, type GrowTarget } from '../utils/vm-edit-plan.js';
import { parseBlkList, parseCapacityBytes, parseHardwareXml } from '../utils/vm-hardware-xml.js';
import {
  VM_EDIT_HOT,
  VM_EDIT_LIMITS,
  VM_EDIT_NEEDS_STOP,
  vmEditNeedsStop,
  vmEditSchema,
  type VmEditField,
  type VmEditParams
} from '../utils/vm-hub-schemas.js';
import type { ToolDefinition, ToolResult } from './vm-controller.js';

export { VM_EDIT_HOT, VM_EDIT_LIMITS, VM_EDIT_NEEDS_STOP, vmEditNeedsStop };

const TOOL = 'vm_edit';
const T_LONG = 120_000;

interface Outcome {
  applied: VmEditField[];
  changes: string[];
  skipped: string[];
  failed?: { step: EditStep; error: string };
}

/** Lance une suite de commandes ; s'arrete a la premiere qui echoue et rend son erreur. */
async function runSequence(commands: readonly Command[]): Promise<string | null> {
  for (const c of commands) {
    const r = await run(c.command, c.args, { tool: TOOL, timeoutMs: T_LONG });
    if (r.code !== 0) return r.stderr.trim() || `${c.command} ${c.args.slice(2, 4).join(' ')} a echoue (code ${r.code})`;
  }
  return null;
}

/** Premiere tentative entierement reussie ; sinon la derniere erreur. */
async function runStep(step: EditStep): Promise<string | null> {
  let last: string | null = null;
  for (const attempt of step.attempts) {
    last = await runSequence(attempt);
    if (last === null) return null;
  }
  return last;
}

async function applySteps(steps: readonly EditStep[]): Promise<Outcome> {
  const out: Outcome = { applied: [], changes: [], skipped: [] };
  for (const step of steps) {
    if (step.skipped !== undefined) {
      out.skipped = [...out.skipped, step.skipped];
      continue;
    }
    const error = await runStep(step);
    if (error !== null) return { ...out, failed: { step, error } };
    out.applied = [...out.applied, ...step.fields];
    out.changes = [...out.changes, step.label];
  }
  return out;
}

type GrowLookup =
  | { ok: true; target: GrowTarget }
  | { ok: false; code: ErrorCode; message: string; extra: Record<string, unknown> };

/**
 * Premier disque fichier de la VM, son pool libvirt (`vol-pool` : un chemin qui n'est le volume
 * d'aucun pool est refuse) et sa capacite actuelle (`domblkinfo`). Lectures seules.
 */
async function resolveGrowTarget(vm: string): Promise<GrowLookup> {
  const list = await virsh(TOOL, ['domblklist', vm, '--details']);
  if (list.code !== 0) return { ok: false, code: ErrorCode.SCRIPT_ERROR, message: list.stderr || `virsh domblklist a echoue (code ${list.code})`, extra: {} };
  const blocks = parseBlkList(list.stdout);
  const found = growableDisk(blocks);
  if (!found.ok) return { ok: false, code: ErrorCode.VALIDATION_ERROR, message: found.message, extra: { disks: blocks } };
  const disk = found.disk;

  const pool = await virsh(TOOL, ['vol-pool', disk.source]);
  const poolName = pool.stdout.trim();
  if (pool.code !== 0 || poolName === '') {
    return {
      ok: false, code: ErrorCode.VALIDATION_ERROR,
      message: `disk_grow_gb : le disque ${disk.target} (${disk.source}) n'est le volume d'aucun pool libvirt : agrandissement refuse (seuls les volumes geres par libvirt sont agrandis, par vol-resize)`,
      extra: { disk: disk.source }
    };
  }

  const info = await virsh(TOOL, ['domblkinfo', vm, disk.target]);
  const capacityBytes = info.code === 0 ? parseCapacityBytes(info.stdout) : null;
  if (capacityBytes === null) {
    return { ok: false, code: ErrorCode.SCRIPT_ERROR, message: `disk_grow_gb : capacite actuelle du disque ${disk.target} illisible (${info.stderr.trim() || 'virsh domblkinfo'})`, extra: { disk: disk.source } };
  }
  return { ok: true, target: { disk, pool: poolName, capacityBytes } };
}

function summary(vm: string, outcome: Outcome, restart: boolean): string {
  const done = outcome.changes.length > 0 ? `VM '${vm}' modifiee : ${outcome.changes.join(', ')}` : `VM '${vm}' : rien a modifier`;
  const skipped = outcome.skipped.length > 0 ? ` (sans effet : ${outcome.skipped.join(', ')})` : '';
  return `${done}${skipped}${restart ? ' ; effectif au prochain demarrage' : ''}`;
}

async function vmEditHandler(params: unknown): Promise<ToolResult> {
  const p = vmEditSchema.parse(params) as VmEditParams;
  const vm = p.vm_name;

  const lookup = await getDomainState(TOOL, vm);
  if (!lookup.ok) return fail(lookup.code, lookup.message);
  const state = lookup.state;
  if (vmEditNeedsStop(p) && state !== 'shut off') {
    return fail(ErrorCode.VALIDATION_ERROR, needsStopMessage(vm, p, state), { state });
  }

  const dump = await virsh(TOOL, ['dumpxml', vm]);
  if (dump.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, dump.stderr || `virsh dumpxml a echoue (code ${dump.code})`, { state });
  const hardware = parseHardwareXml(dump.stdout);

  let grow: GrowTarget | null = null;
  if (p.disk_grow_gb !== undefined) {
    const resolved = await resolveGrowTarget(vm);
    if (!resolved.ok) return fail(resolved.code, resolved.message, { state, ...resolved.extra });
    grow = resolved.target;
  }

  const plan = planEdit({ params: p, state, hardware, grow }, dump.stdout);
  if (!plan.ok) return fail(ErrorCode.VALIDATION_ERROR, plan.message, { state, ...plan.extra });

  const outcome = await applySteps(plan.steps);
  const restart = needsRestart(outcome.applied, state);
  if (outcome.failed) {
    const { step, error } = outcome.failed;
    return fail(ErrorCode.SCRIPT_ERROR, `${step.label} : ${error}`, {
      state, failed: step.fields, applied: outcome.applied, changes: outcome.changes, skipped: outcome.skipped, needs_restart: restart
    });
  }
  return ok({
    vm, state,
    changes: outcome.changes,
    applied: outcome.applied,
    skipped: outcome.skipped,
    needs_restart: restart,
    hot: hotFields(outcome.applied, state),
    message: summary(vm, outcome, restart)
  });
}

export const vmEdit: ToolDefinition = {
  name: 'vm_edit',
  description: [
    'Modifie une VM (liste fermee de champs, au moins un) : vcpus, memory_mib, autostart, description, cpu_model',
    `(${VM_EDIT_LIMITS.cpu_models.join(' | ')}), firmware (bios | uefi), tpm, secure_boot (avec firmware=uefi),`,
    'boot_order (hd, cdrom, network sans doublon), usb_attach / usb_detach (vendor:product ; attache en',
    '"optionnel au demarrage" : la VM demarre meme si le peripherique est absent), display (spice | vnc),',
    'network (reseau libvirt), disk_grow_gb (agrandit le premier disque de N Gio par virsh vol-resize : le disque',
    'doit etre le volume d\'un pool libvirt ; le systeme de fichiers de l\'invite reste a agrandir).',
    'Retour au bios depuis l\'UEFI : l\'attribut firmware de <os>, loader, nvram, firmware et smm sont retires en une seule',
    'definition (SeaBIOS par defaut : Fedora n\'a pas de descripteur SeaBIOS pour la selection automatique) ; le fichier NVRAM reste sur le disque.',
    `VM ARRETEE obligatoire pour : ${VM_EDIT_NEEDS_STOP.join(', ')} (refus avant toute modification sinon).`,
    `Appliques a chaud quand la VM tourne : ${VM_EDIT_HOT.join(', ')}. Les autres s'ecrivent dans la configuration`,
    'et prennent effet au prochain demarrage. En cas d\'erreur, la reponse liste ce qui a deja ete applique.',
    'Note : une VM creee par vm_create_from_image a un cpu de mode custom (pas host-passthrough).'
  ].join(' '),
  inputSchema: vmEditSchema,
  handler: vmEditHandler
};

export const vmEditTools: ToolDefinition[] = [vmEdit];
