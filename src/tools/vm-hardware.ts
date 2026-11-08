/**
 * Outil MCP : vm_hardware. Lit le materiel d'une VM (cpu, firmware, secure boot, TPM, ordre de
 * demarrage, affichage, reseau, disques, USB) : lecture seule, aucune modification.
 */

import { ErrorCode } from '../config.js';
import { fail, getDomainState, ok, virsh } from '../utils/virsh.js';
import { bytesToGb, parseAutostart, parseCapacityBytes, parseHardwareXml, type HardwareDisk } from '../utils/vm-hardware-xml.js';
import { vmHardwareSchema, type VmHardwareParams } from '../utils/vm-hub-schemas.js';
import type { ToolDefinition, ToolResult } from './vm-controller.js';

const TOOL = 'vm_hardware';

/** Capacite virtuelle de chaque disque (`virsh domblkinfo`) ; null si illisible. */
function withCapacities(vm: string, disks: readonly HardwareDisk[]): Promise<HardwareDisk[]> {
  return Promise.all(disks.map(async (d) => {
    const r = await virsh(TOOL, ['domblkinfo', vm, d.target]);
    const bytes = r.code === 0 ? parseCapacityBytes(r.stdout) : null;
    return { ...d, capacity_gb: bytes === null ? null : bytesToGb(bytes) };
  }));
}

async function vmHardwareHandler(params: unknown): Promise<ToolResult> {
  const { vm_name: vm } = vmHardwareSchema.parse(params) as VmHardwareParams;

  const lookup = await getDomainState(TOOL, vm);
  if (!lookup.ok) return fail(lookup.code, lookup.message);

  const dump = await virsh(TOOL, ['dumpxml', vm]);
  if (dump.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, dump.stderr || `virsh dumpxml a echoue (code ${dump.code})`);
  const parsed = parseHardwareXml(dump.stdout);

  const info = await virsh(TOOL, ['dominfo', vm]);
  const autostart = info.code === 0 ? parseAutostart(info.stdout) : null;
  const disks = await withCapacities(vm, parsed.disks);

  return ok({ vm, state: lookup.state, hardware: { ...parsed, disks, autostart } });
}

export const vmHardware: ToolDefinition = {
  name: 'vm_hardware',
  description: 'Rend le materiel d\'une VM tel que libvirt le declare (lecture seule) : modele cpu, firmware (bios | uefi), secure boot, TPM, ordre de demarrage, affichage, premier reseau, disques avec capacite, peripheriques USB, vcpus, memoire, autostart, description. Sert a preparer un appel vm_edit.',
  inputSchema: vmHardwareSchema,
  handler: vmHardwareHandler
};

export const vmHardwareTools: ToolDefinition[] = [vmHardware];
