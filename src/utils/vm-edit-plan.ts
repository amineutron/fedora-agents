/**
 * Plan d'edition d'une VM : traduit les parametres de vm_edit en une suite ordonnee d'etapes
 * (commandes virsh et virt-xml), sans rien executer. Fonction pure, testee.
 *
 * Chaque etape porte une ou plusieurs tentatives : la premiere tentative dont TOUTES les commandes
 * reussissent suffit (libvirt refuse `setvcpus --maximum` avant ou apres `setvcpus` selon que l'on
 * monte ou descend la valeur : on essaie les deux ordres).
 */

import type { DomainState } from './virsh.js';
import { LIBVIRT_URI } from './virsh.js';
import { usbHostdevIndex, type BlockDevice, type VmHardware } from './vm-hardware-xml.js';
import { VM_EDIT_HOT, VM_EDIT_NEEDS_STOP, type VmEditField, type VmEditParams } from './vm-hub-schemas.js';

export interface Command {
  command: string;
  args: string[];
}

export interface EditStep {
  /** champs couverts (plusieurs pour firmware + secure_boot) */
  fields: VmEditField[];
  /** libelle court en francais, ex. "vcpus=4" */
  label: string;
  /** suites de commandes essayees dans l'ordre ; vide quand il n'y a rien a faire (`skipped`) */
  attempts: Command[][];
  /** raison pour laquelle rien n'est lance (etat deja conforme) */
  skipped?: string;
  /** applique aussi a la VM en marche (`--update`) */
  hot: boolean;
}

export type PlanResult =
  | { ok: true; steps: EditStep[] }
  | { ok: false; message: string; extra: Record<string, unknown> };

/** Disque a agrandir, resolu par l'outil : volume d'un pool libvirt et capacite actuelle (`domblkinfo`). */
export interface GrowTarget {
  disk: BlockDevice;
  pool: string;
  capacityBytes: number;
}

export interface PlanInput {
  params: VmEditParams;
  state: DomainState;
  hardware: VmHardware;
  /** present seulement quand `disk_grow_gb` est demande */
  grow: GrowTarget | null;
}

export const GIB = 1024 ** 3;

const virshCmd = (...args: string[]): Command => ({ command: 'virsh', args: ['-c', LIBVIRT_URI, ...args] });
const virtXml = (vm: string, update: boolean, ...args: string[]): Command => ({
  command: 'virt-xml',
  args: [vm, '--connect', LIBVIRT_URI, ...args, ...(update ? ['--update'] : [])]
});

const yesNo = (v: boolean): string => (v ? 'yes' : 'no');
const ouiNon = (v: boolean): string => (v ? 'oui' : 'non');

function vcpusStep(vm: string, vcpus: number): EditStep {
  const n = String(vcpus);
  const max = virshCmd('setvcpus', vm, n, '--maximum', '--config');
  const cur = virshCmd('setvcpus', vm, n, '--config');
  return { fields: ['vcpus'], label: `vcpus=${vcpus}`, attempts: [[max, cur], [cur, max]], hot: false };
}

function memoryStep(vm: string, mib: number): EditStep {
  const kib = String(mib * 1024);
  const max = virshCmd('setmaxmem', vm, kib, '--config');
  const cur = virshCmd('setmem', vm, kib, '--config');
  return { fields: ['memory_mib'], label: `memoire=${mib}MiB`, attempts: [[max, cur], [cur, max]], hot: false };
}

/** Firmware et secure boot ensemble : le secure boot exige l'UEFI (schema). */
function firmwareStep(vm: string, firmware: 'bios' | 'uefi', secure: boolean | undefined, hw: VmHardware): EditStep {
  if (firmware === 'bios') {
    if (hw.firmware === 'bios') return { fields: ['firmware'], label: 'firmware=bios', attempts: [], skipped: 'firmware deja bios', hot: false };
    // Fedora ne livre AUCUN descripteur SeaBIOS dans /usr/share/qemu/firmware (edk2-ovmf seulement) :
    // `<os firmware='bios'>` (selection automatique) echoue toujours ("Unable to find 'bios' firmware").
    // Il faut RETIRER l'attribut (`<os>` nu = SeaBIOS par defaut) : `./os/@firmware=` (valeur vide) ;
    // surtout pas `xpath.delete=./os/@firmware`, qui supprime tout l'element <os>. Le <smm state='on'/>
    // du secure boot doit partir dans la MEME definition (libvirt le refuse avec SeaBIOS). `--xml` = xpath
    // sur tout le domaine, repetable dans un seul --edit. Le fichier NVRAM reste sur le disque.
    const cmd = virtXml(vm, false, '--edit',
      '--xml', './os/@firmware=',
      '--xml', 'xpath.delete=./os/loader',
      '--xml', 'xpath.delete=./os/nvram',
      '--xml', 'xpath.delete=./os/firmware',
      '--xml', 'xpath.delete=./features/smm');
    return { fields: ['firmware'], label: 'firmware=bios', attempts: [[cmd]], hot: false };
  }
  if (secure === undefined) {
    if (hw.firmware === 'uefi') return { fields: ['firmware'], label: 'firmware=uefi', attempts: [], skipped: 'firmware deja uefi', hot: false };
    return { fields: ['firmware'], label: 'firmware=uefi', attempts: [[virtXml(vm, false, '--edit', '--boot', 'uefi')]], hot: false };
  }
  // 1) ancien choix de firmware efface (un chemin OVMF explicite empecherait la selection automatique)
  // 2) UEFI + secure boot demande a la fois par <loader secure> et par <firmware><feature>
  const reset = virtXml(vm, false, '--edit', '--boot', 'xpath1.delete=./firmware,xpath2.delete=./loader,xpath3.delete=./nvram');
  const set = virtXml(vm, false, '--edit', '--boot',
    `uefi,loader.secure=${yesNo(secure)},firmware.feature0.name=secure-boot,firmware.feature0.enabled=${yesNo(secure)}`);
  return { fields: ['firmware', 'secure_boot'], label: `firmware=uefi, secure boot=${ouiNon(secure)}`, attempts: [[reset, set]], hot: false };
}

function tpmStep(vm: string, wanted: boolean, hw: VmHardware): EditStep {
  const label = `tpm=${ouiNon(wanted)}`;
  if (wanted === hw.tpm) return { fields: ['tpm'], label, attempts: [], skipped: wanted ? 'TPM deja present' : 'aucun TPM a retirer', hot: false };
  const cmd = wanted ? virtXml(vm, false, '--add-device', '--tpm', 'default') : virtXml(vm, false, '--remove-device', '--tpm', 'all');
  return { fields: ['tpm'], label, attempts: [[cmd]], hot: false };
}

/** libvirt refuse de melanger <os><boot dev> et <boot order> par peripherique : on efface d'abord ces derniers. */
function bootOrderStep(vm: string, order: readonly string[], hw: VmHardware): EditStep {
  const clear: Command[] = hw.boot_order_source === 'devices'
    ? [
      virtXml(vm, false, '--edit', 'all', '--disk', 'xpath1.delete=./boot'),
      ...(hw.network !== null ? [virtXml(vm, false, '--edit', 'all', '--network', 'xpath1.delete=./boot')] : [])
    ]
    : [];
  const set = virtXml(vm, false, '--edit', '--boot', order.join(','));
  return { fields: ['boot_order'], label: `ordre de demarrage=${order.join(',')}`, attempts: [[...clear, set]], hot: false };
}

function displayStep(vm: string, display: 'spice' | 'vnc', hw: VmHardware): EditStep {
  const label = `affichage=${display}`;
  if (hw.display === display) return { fields: ['display'], label, attempts: [], skipped: `affichage deja ${display}`, hot: false };
  const cmd = hw.display === 'none'
    ? virtXml(vm, false, '--add-device', '--graphics', `${display},listen=127.0.0.1`)
    : virtXml(vm, false, '--edit', '--graphics', display);
  return { fields: ['display'], label, attempts: [[cmd]], hot: false };
}

function networkStep(vm: string, network: string, hw: VmHardware, update: boolean): EditStep {
  const label = `reseau=${network}`;
  if (hw.network === network) return { fields: ['network'], label, attempts: [], skipped: `reseau deja ${network}`, hot: true };
  const action = hw.network === null ? '--add-device' : '--edit';
  return { fields: ['network'], label, attempts: [[virtXml(vm, update, action, '--network', `network=${network}`)]], hot: true };
}

function usbDetachStep(vm: string, id: string, xml: string, update: boolean): EditStep {
  const index = usbHostdevIndex(xml, id);
  const label = `usb detache=${id.toLowerCase()}`;
  if (index === null) return { fields: ['usb_detach'], label, attempts: [], skipped: `peripherique ${id.toLowerCase()} non attache`, hot: true };
  return { fields: ['usb_detach'], label, attempts: [[virtXml(vm, update, '--remove-device', '--hostdev', String(index))]], hot: true };
}

/**
 * Par xpath : pas de recherche du peripherique sur l'hote, il peut etre branche plus tard.
 * `startupPolicy=optional` : la VM demarre meme si le peripherique est absent (sinon le demarrage echoue
 * tant qu'il n'est pas detache).
 */
function usbAttachStep(vm: string, id: string, hw: VmHardware, update: boolean): EditStep {
  const low = id.toLowerCase();
  const label = `usb attache=${low} (optionnel au demarrage)`;
  if (hw.usb.includes(low)) return { fields: ['usb_attach'], label, attempts: [], skipped: `peripherique ${low} deja attache`, hot: true };
  const [vendor, product] = low.split(':');
  const spec = `type=usb,source.startupPolicy=optional,xpath1.set=./source/vendor/@id,xpath1.value=0x${vendor},xpath2.set=./source/product/@id,xpath2.value=0x${product}`;
  return { fields: ['usb_attach'], label, attempts: [[virtXml(vm, update, '--add-device', '--hostdev', spec)]], hot: true };
}

/**
 * Par libvirt (le volume appartient a libvirt, l'utilisateur n'a que le groupe : `qemu-img resize`
 * direct est refuse) : `vol-resize` a la capacite actuelle + N Gio, puis `pool-refresh`.
 */
function diskGrowStep(gb: number, g: GrowTarget): EditStep {
  const target = String(g.capacityBytes + gb * GIB);
  const resize = virshCmd('vol-resize', g.disk.source, target, '--pool', g.pool);
  const refresh = virshCmd('pool-refresh', g.pool);
  return { fields: ['disk_grow_gb'], label: `disque ${g.disk.target} +${gb}G`, attempts: [[resize, refresh]], hot: false };
}

/** Premier disque de type fichier de `virsh domblklist --details` ; message d'erreur si absent. */
export function growableDisk(blocks: BlockDevice[] | null): { ok: true; disk: BlockDevice } | { ok: false; message: string } {
  const disk = (blocks ?? []).find((b) => b.type === 'file' && b.device === 'disk' && b.source !== '-');
  if (!disk) return { ok: false, message: 'disk_grow_gb : aucun disque de type fichier sur cette VM' };
  return { ok: true, disk };
}

export function needsStopMessage(vm: string, params: VmEditParams, state: DomainState): string {
  const asked = VM_EDIT_NEEDS_STOP.filter((k) => params[k] !== undefined);
  return `VM '${vm}' n'est pas arretee (etat: ${state}) : ${asked.join(', ')} exige${asked.length > 1 ? 'nt' : ''} une VM arretee `
    + `(champs concernes : ${VM_EDIT_NEEDS_STOP.join(', ')}). Arreter la VM d'abord (vm_stop) ou retirer ces champs.`;
}

/** Ordre fixe d'application. Rien n'est lance ici. */
export function planEdit(input: PlanInput, xml: string): PlanResult {
  const { params: p, state, hardware: hw, grow } = input;
  const vm = p.vm_name;
  const update = state === 'running';

  if (p.disk_grow_gb !== undefined && grow === null) {
    return { ok: false, message: 'disk_grow_gb : aucun disque de type fichier sur cette VM', extra: {} };
  }

  const steps: EditStep[] = [];
  if (p.vcpus !== undefined) steps.push(vcpusStep(vm, p.vcpus));
  if (p.memory_mib !== undefined) steps.push(memoryStep(vm, p.memory_mib));
  if (p.cpu_model !== undefined) {
    steps.push({ fields: ['cpu_model'], label: `modele cpu=${p.cpu_model}`, attempts: [[virtXml(vm, false, '--edit', '--cpu', p.cpu_model)]], hot: false });
  }
  if (p.firmware !== undefined) steps.push(firmwareStep(vm, p.firmware, p.secure_boot, hw));
  if (p.tpm !== undefined) steps.push(tpmStep(vm, p.tpm, hw));
  if (p.boot_order !== undefined) steps.push(bootOrderStep(vm, p.boot_order, hw));
  if (p.display !== undefined) steps.push(displayStep(vm, p.display, hw));
  if (p.network !== undefined) steps.push(networkStep(vm, p.network, hw, update));
  if (p.usb_detach !== undefined) steps.push(usbDetachStep(vm, p.usb_detach, xml, update));
  if (p.usb_attach !== undefined) steps.push(usbAttachStep(vm, p.usb_attach, hw, update));
  if (p.disk_grow_gb !== undefined && grow !== null) steps.push(diskGrowStep(p.disk_grow_gb, grow));
  if (p.autostart !== undefined) {
    const cmd = p.autostart ? virshCmd('autostart', vm) : virshCmd('autostart', '--disable', vm);
    steps.push({ fields: ['autostart'], label: `autostart=${p.autostart}`, attempts: [[cmd]], hot: true });
  }
  if (p.description !== undefined) {
    steps.push({ fields: ['description'], label: p.description === '' ? 'description effacee' : 'description', attempts: [[virshCmd('desc', vm, '--config', '--new-desc', p.description)]], hot: true });
  }
  return { ok: true, steps };
}

const HOT: ReadonlySet<string> = new Set(VM_EDIT_HOT);
const STOP: ReadonlySet<string> = new Set(VM_EDIT_NEEDS_STOP);
/** Champs ecrits dans la config seulement : effectifs au prochain demarrage si la VM tourne. */
const CONFIG_ONLY: ReadonlySet<string> = new Set(['boot_order', 'display']);

/** Vrai si un champ applique n'est effectif qu'au prochain demarrage. */
export function needsRestart(applied: readonly VmEditField[], state: DomainState): boolean {
  if (applied.some((f) => STOP.has(f))) return true;
  if (state === 'shut off') return false;
  const notHot = state !== 'running';
  return applied.some((f) => CONFIG_ONLY.has(f) || (notHot && HOT.has(f) && f !== 'autostart'));
}

/** Champs appliques a chaud (VM en marche). */
export function hotFields(applied: readonly VmEditField[], state: DomainState): VmEditField[] {
  return state === 'running' ? applied.filter((f) => HOT.has(f)) : [];
}
