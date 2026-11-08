/**
 * Lecture du materiel d'une VM dans son XML libvirt (`virsh dumpxml`) et dans les sorties texte de
 * `virsh domblklist --details`, `virsh domblkinfo` et `virsh dominfo` (locale C). Fonctions pures.
 *
 * Aucune bibliotheque XML : le XML vient de libvirt (bien forme) et n'est interroge que par motifs,
 * robustes a l'ordre des attributs et au type de guillemets.
 */

import { elements, xmlUnescape, type XmlElement } from './vm-domain-xml.js';

/** Texte d'un element (entites decodees), ou undefined s'il manque. */
const text = (el: XmlElement | undefined): string | undefined => (el === undefined ? undefined : xmlUnescape(el.body.trim()));

export type Firmware = 'bios' | 'uefi';
export type BootDevice = 'hd' | 'cdrom' | 'network';

export interface HardwareDisk {
  target: string;
  path: string;
  /** Capacite virtuelle en Gio (une decimale) ; null tant qu'elle n'est pas lue */
  capacity_gb: number | null;
}

export interface VmHardware {
  /** `host-passthrough`, `host-model`, ou le nom du modele (`x86-64-v2`...) ; null si aucun bloc <cpu> */
  cpu_model: string | null;
  firmware: Firmware;
  secure_boot: boolean;
  tpm: boolean;
  /** d'apres `<boot dev>` de <os>, sinon d'apres les `<boot order>` des peripheriques */
  boot_order: BootDevice[];
  /** `os` : ordre global, `devices` : ordre par peripherique, `none` : aucun */
  boot_order_source: 'os' | 'devices' | 'none';
  /** premier affichage declare : `spice`, `vnc`, `none`, ou un autre type libvirt tel quel */
  display: string;
  /** premiere interface : reseau libvirt ou pont ; null si aucune */
  network: string | null;
  disks: HardwareDisk[];
  /** peripheriques USB passes a la VM : `vendor:product` en minuscules */
  usb: string[];
  vcpus: number | null;
  memory_mib: number | null;
  description: string | null;
}

function cpuModel(xml: string): string | null {
  const cpu = elements(xml, 'cpu')[0];
  if (!cpu) return null;
  const mode = cpu.attrs.mode;
  if (mode === 'host-passthrough' || mode === 'host-model') return mode;
  const model = text(elements(cpu.body, 'model')[0]);
  return model ? model : (mode ?? null);
}

function firmwareOf(os: XmlElement | undefined): { firmware: Firmware; secure: boolean } {
  if (!os) return { firmware: 'bios', secure: false };
  const loader = elements(os.body, 'loader')[0];
  const efi = os.attrs.firmware === 'efi' || loader?.attrs.type === 'pflash' || /ovmf|edk2|aavmf/i.test(loader?.body ?? '');
  const feature = elements(os.body, 'feature').find((f) => f.attrs.name === 'secure-boot');
  const secure = loader?.attrs.secure === 'yes' || feature?.attrs.enabled === 'yes';
  return { firmware: efi ? 'uefi' : 'bios', secure: efi && secure };
}

const BOOT_DEVICES: readonly string[] = ['hd', 'cdrom', 'network'];
const isBootDevice = (d: string | undefined): d is BootDevice => d !== undefined && BOOT_DEVICES.includes(d);

/** Ordre de demarrage global (<os><boot dev>), sinon par peripherique (<boot order>) trie. */
function bootOrder(xml: string, os: XmlElement | undefined): Pick<VmHardware, 'boot_order' | 'boot_order_source'> {
  const global = elements(os?.body ?? '', 'boot').map((b) => b.attrs.dev).filter(isBootDevice);
  if (global.length > 0) return { boot_order: global, boot_order_source: 'os' };

  const ranked: Array<{ order: number; dev: BootDevice }> = [];
  const devices = elements(xml, 'devices')[0]?.body ?? '';
  for (const disk of elements(devices, 'disk')) {
    const order = Number(elements(disk.body, 'boot')[0]?.attrs.order);
    if (Number.isInteger(order)) ranked.push({ order, dev: disk.attrs.device === 'cdrom' ? 'cdrom' : 'hd' });
  }
  for (const iface of elements(devices, 'interface')) {
    const order = Number(elements(iface.body, 'boot')[0]?.attrs.order);
    if (Number.isInteger(order)) ranked.push({ order, dev: 'network' });
  }
  const ordered = [...ranked].sort((a, b) => a.order - b.order).map((r) => r.dev);
  const unique = ordered.filter((d, i) => ordered.indexOf(d) === i);
  return { boot_order: unique, boot_order_source: unique.length > 0 ? 'devices' : 'none' };
}

function firstNetwork(devices: string): string | null {
  const iface = elements(devices, 'interface')[0];
  if (!iface) return null;
  const source = elements(iface.body, 'source')[0]?.attrs ?? {};
  return source.network ?? source.bridge ?? source.dev ?? null;
}

function fileDisks(devices: string): HardwareDisk[] {
  return elements(devices, 'disk')
    .filter((d) => d.attrs.device === 'disk')
    .map((d) => ({
      target: elements(d.body, 'target')[0]?.attrs.dev ?? '',
      path: elements(d.body, 'source')[0]?.attrs.file ?? elements(d.body, 'source')[0]?.attrs.dev ?? '',
      capacity_gb: null
    }))
    .filter((d) => d.target !== '' && d.path !== '');
}

const hex4 = (raw: string | undefined): string | null => {
  const m = /^(?:0x)?([0-9a-fA-F]{1,4})$/.exec(raw ?? '');
  return m ? m[1].toLowerCase().padStart(4, '0') : null;
};

/** Identifiant `vendor:product` d'un <hostdev> USB, null pour tout autre hostdev. */
function usbId(hostdev: XmlElement): string | null {
  if (hostdev.attrs.type !== 'usb') return null;
  const source = elements(hostdev.body, 'source')[0]?.body ?? '';
  const vendor = hex4(elements(source, 'vendor')[0]?.attrs.id);
  const product = hex4(elements(source, 'product')[0]?.attrs.id);
  return vendor && product ? `${vendor}:${product}` : null;
}

function memoryMib(xml: string): number | null {
  const mem = elements(xml, 'memory')[0];
  if (!mem) return null;
  const value = Number(mem.body.trim());
  if (!Number.isFinite(value)) return null;
  const unit = (mem.attrs.unit ?? 'KiB').toLowerCase();
  const factor: Record<string, number> = { b: 1 / 1024 ** 2, bytes: 1 / 1024 ** 2, kib: 1 / 1024, kb: 1 / 1024, mib: 1, mb: 1, gib: 1024, gb: 1024, tib: 1024 ** 2 };
  const f = factor[unit];
  return f === undefined ? null : Math.round(value * f);
}

export function parseHardwareXml(xml: string): VmHardware {
  const os = elements(xml, 'os')[0];
  const devices = elements(xml, 'devices')[0]?.body ?? '';
  const { firmware, secure } = firmwareOf(os);
  const graphics = elements(devices, 'graphics')[0]?.attrs.type;
  const vcpus = Number(elements(xml, 'vcpu')[0]?.body.trim());
  const description = text(elements(xml, 'description')[0]);
  return {
    cpu_model: cpuModel(xml),
    firmware,
    secure_boot: secure,
    tpm: elements(devices, 'tpm').length > 0,
    ...bootOrder(xml, os),
    display: graphics ?? 'none',
    network: firstNetwork(devices),
    disks: fileDisks(devices),
    usb: elements(devices, 'hostdev').map(usbId).filter((id): id is string => id !== null),
    vcpus: Number.isInteger(vcpus) && vcpus > 0 ? vcpus : null,
    memory_mib: memoryMib(xml),
    description: description ? description : null
  };
}

/** Rang (1 = premier) du <hostdev> USB `vendor:product` parmi TOUS les <hostdev> (c'est l'index que virt-xml attend) ; null si absent. */
export function usbHostdevIndex(xml: string, id: string): number | null {
  const devices = elements(xml, 'devices')[0]?.body ?? '';
  const index = elements(devices, 'hostdev').findIndex((h) => usbId(h) === id.toLowerCase());
  return index === -1 ? null : index + 1;
}

export interface BlockDevice {
  type: string;
  device: string;
  target: string;
  source: string;
}

/** Lignes de `virsh domblklist --details` (locale C) : Type, Device, Target, Source. */
export function parseBlkList(stdout: string): BlockDevice[] {
  const out: BlockDevice[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !['file', 'block', 'dir', 'network', 'volume'].includes(cols[0])) continue;
    out.push({ type: cols[0], device: cols[1], target: cols[2], source: cols.slice(3).join(' ') });
  }
  return out;
}

/** Capacite (octets) d'une sortie `virsh domblkinfo` ; null si absente. */
export function parseCapacityBytes(stdout: string): number | null {
  const m = /^Capacity:\s*(\d+)\s*$/m.exec(stdout);
  return m ? Number(m[1]) : null;
}

/** Demarrage automatique d'une sortie `virsh dominfo` (locale C) ; null si la ligne manque. */
export function parseAutostart(stdout: string): boolean | null {
  const m = /^Autostart:\s*(enable|disable)\s*$/m.exec(stdout);
  return m ? m[1] === 'enable' : null;
}

export const bytesToGb = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 10) / 10;
