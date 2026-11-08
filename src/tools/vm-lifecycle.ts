/**
 * Outils MCP : pause, reprise et redemarrage d'une VM (virsh direct, sans script).
 */

import { ErrorCode } from '../config.js';
import {
  vmPauseSchema,
  vmResumeSchema,
  vmRebootSchema,
  type VmPauseParams,
  type VmResumeParams,
  type VmRebootParams
} from '../utils/vm-hub-schemas.js';
import { fail, getDomainState, ok, virsh, waitFor } from '../utils/virsh.js';
import type { ToolDefinition, ToolResult } from './vm-controller.js';

// ========================================
// vm_pause
// ========================================
async function vmPauseHandler(params: unknown): Promise<ToolResult> {
  const { vm_name: vm } = vmPauseSchema.parse(params) as VmPauseParams;

  const lookup = await getDomainState('vm_pause', vm);
  if (!lookup.ok) return fail(lookup.code, lookup.message);
  if (lookup.state === 'paused') {
    return ok({ vm, state: 'paused', changed: false, message: `VM '${vm}' deja en pause` });
  }
  if (lookup.state !== 'running') {
    return fail(ErrorCode.VALIDATION_ERROR, `VM '${vm}' n'est pas en marche (etat: ${lookup.state}) : rien a suspendre`, { state: lookup.state });
  }

  const r = await virsh('vm_pause', ['suspend', vm]);
  if (r.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, r.stderr || `virsh suspend a echoue (code ${r.code})`);
  return ok({ vm, state: 'paused', changed: true, message: `VM '${vm}' suspendue` });
}

export const vmPause: ToolDefinition = {
  name: 'vm_pause',
  description: 'Suspend une VM en marche (virsh suspend : memoire conservee, CPU gele). Refuse si la VM n\'est pas en marche ; sans effet si elle est deja en pause.',
  inputSchema: vmPauseSchema,
  handler: vmPauseHandler
};

// ========================================
// vm_resume
// ========================================
async function vmResumeHandler(params: unknown): Promise<ToolResult> {
  const { vm_name: vm } = vmResumeSchema.parse(params) as VmResumeParams;

  const lookup = await getDomainState('vm_resume', vm);
  if (!lookup.ok) return fail(lookup.code, lookup.message);
  if (lookup.state === 'running') {
    return ok({ vm, state: 'running', changed: false, message: `VM '${vm}' deja en marche` });
  }
  if (lookup.state !== 'paused') {
    return fail(ErrorCode.VALIDATION_ERROR, `VM '${vm}' n'est pas en pause (etat: ${lookup.state}) : utiliser vm_start`, { state: lookup.state });
  }

  const r = await virsh('vm_resume', ['resume', vm]);
  if (r.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, r.stderr || `virsh resume a echoue (code ${r.code})`);
  return ok({ vm, state: 'running', changed: true, message: `VM '${vm}' reprise` });
}

export const vmResume: ToolDefinition = {
  name: 'vm_resume',
  description: 'Reprend une VM en pause (virsh resume). Sans effet si la VM est deja en marche ; refuse si elle est arretee.',
  inputSchema: vmResumeSchema,
  handler: vmResumeHandler
};

// ========================================
// vm_reboot
// ========================================
async function vmRebootHandler(params: unknown): Promise<ToolResult> {
  const v = vmRebootSchema.parse(params) as VmRebootParams;
  const vm = v.vm_name;

  const lookup = await getDomainState('vm_reboot', vm);
  if (!lookup.ok) return fail(lookup.code, lookup.message);
  if (lookup.state !== 'running') {
    const hint = lookup.state === 'paused' ? ' (reprendre d\'abord avec vm_resume)' : lookup.state === 'shut off' ? ' (utiliser vm_start)' : '';
    return fail(ErrorCode.VALIDATION_ERROR, `VM '${vm}' n'est pas en marche (etat: ${lookup.state})${hint}`, { state: lookup.state });
  }

  // Reset materiel : immediat, sans cooperation de l'invite (perte possible de donnees non ecrites)
  if (v.force) {
    const r = await virsh('vm_reboot', ['reset', vm]);
    if (r.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, r.stderr || `virsh reset a echoue (code ${r.code})`);
    return ok({ vm, mode: 'reset', waited: v.wait, message: `VM '${vm}' reinitialisee (reset materiel)` });
  }

  // Sans attente : une seule demande ACPI, la VM redemarre d'elle-meme (reponse immediate)
  if (!v.wait) {
    const r = await virsh('vm_reboot', ['reboot', vm, '--mode', 'acpi']);
    if (r.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, r.stderr || `virsh reboot a echoue (code ${r.code})`);
    return ok({ vm, mode: 'acpi', waited: false, message: `Redemarrage ACPI demande pour '${vm}' (l'invite redemarre seule)` });
  }

  // Avec attente : arret ACPI, attente de l'extinction, puis demarrage
  const stop = await virsh('vm_reboot', ['shutdown', vm, '--mode', 'acpi']);
  if (stop.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, stop.stderr || `virsh shutdown a echoue (code ${stop.code})`);

  const stopped = await waitFor(async () => {
    const s = await getDomainState('vm_reboot', vm);
    return s.ok && s.state === 'shut off';
  }, v.timeout * 1000);
  if (!stopped) {
    return fail(ErrorCode.TIMEOUT, `VM '${vm}' toujours en marche apres ${v.timeout}s d'arret ACPI : relancer avec force=true`, { mode: 'acpi' });
  }

  const start = await virsh('vm_reboot', ['start', vm]);
  if (start.code !== 0) {
    return fail(ErrorCode.SCRIPT_ERROR, `VM arretee mais le demarrage a echoue : ${start.stderr || `code ${start.code}`}`, { mode: 'acpi', state: 'shut off' });
  }
  return ok({ vm, mode: 'acpi', waited: true, message: `VM '${vm}' redemarree (arret ACPI puis demarrage)` });
}

export const vmReboot: ToolDefinition = {
  name: 'vm_reboot',
  description: [
    'Redemarre une VM en marche. Par defaut : arret ACPI cooperatif puis redemarrage.',
    'force=true : reset materiel immediat (perte possible de donnees non ecrites).',
    'wait=false (defaut) : rend la main tout de suite apres la demande ; wait=true : attend l\'extinction puis demarre la VM (timeout en secondes pour l\'arret).'
  ].join(' '),
  inputSchema: vmRebootSchema,
  handler: vmRebootHandler
};

export const vmLifecycleTools: ToolDefinition[] = [vmPause, vmResume, vmReboot];
