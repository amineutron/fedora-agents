/**
 * Outil MCP : vm_create_from_image (cloud, virt-builder ou ISO -> VM definie dans libvirt).
 *
 * Tout passe par libvirt (groupe libvirt, aucun sudo) : les disques sont des volumes du pool
 * (`VM_HUB_POOL`, defaut `default`) crees puis remplis par `vol-upload`, jamais ecrits a la main
 * dans /var/lib/libvirt. Les fichiers de travail (graine cloud-init, disque virt-builder) vivent
 * dans un dossier temporaire de `VM_IMAGES_DIR`, supprime en fin d'appel. Aucune URL, aucun chemin,
 * aucune commande ne vient de l'appelant : l'image est designee par un identifiant du catalogue.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '../config.js';
import { buildMetaData, buildUserData, defaultHostname } from '../utils/cloud-init.js';
import { run } from '../utils/runner.js';
import { vmCreateFromImageSchema, type VmCreateFromImageParams } from '../utils/vm-hub-schemas.js';
import { buildDomainXml, isSafeVolumePath, type DomainDisk } from '../utils/vm-domain-xml.js';
import {
  bytesFromGib, findCachedImage, findImage, gibCeil, imagesDir, poolName, type ImageEntry
} from '../utils/vm-images.js';
import { fail, nameLines, ok, virsh } from '../utils/virsh.js';
import type { ToolDefinition, ToolResult } from './vm-controller.js';

const TOOL = 'vm_create_from_image';
const T_SHORT = 60_000;
const T_UPLOAD = 600_000;
const T_BUILD = 1_200_000;
const DEFAULT_VCPUS = 2;

interface DiskInfo {
  format: 'qcow2' | 'raw';
  virtualBytes: number;
}

interface Plan {
  name: string;
  entry: ImageEntry;
  pool: string;
  vcpus: number;
  memoryMib: number;
  diskGb: number;
  network: string;
  hostname: string;
  user: string;
  /** compte demande explicitement par l'appelant (virt-builder : cree en plus de root) */
  requestedUser?: string;
  sshKey?: string;
  start: boolean;
  /** fichier d'image (cloud ou ISO) dans VM_IMAGES_DIR */
  sourcePath?: string;
  source?: DiskInfo;
  isoBytes?: number;
  warnings: string[];
}

class StepError extends Error {}

type Checked = { ok: true; plan: Plan } | { ok: false; result: ToolResult };
const refuse = (message: string, extra: Record<string, unknown> = {}): { ok: false; result: ToolResult } =>
  ({ ok: false, result: fail(ErrorCode.VALIDATION_ERROR, message, extra) });

// ----- lecture de l'image -----

export async function inspectDisk(path: string): Promise<DiskInfo | string> {
  const r = await run('qemu-img', ['info', '--output=json', path], { tool: TOOL, timeoutMs: T_SHORT });
  if (r.code !== 0) return r.stderr || `qemu-img info a echoue (code ${r.code})`;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return 'sortie de qemu-img illisible';
  }
  const format = data.format;
  const size = data['virtual-size'];
  if (format !== 'qcow2' && format !== 'raw') return `format d'image non pris en charge: ${String(format)}`;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return 'taille virtuelle illisible';
  if (typeof data['backing-filename'] === 'string') return 'image avec fichier de base (backing file) refusee';
  return { format, virtualBytes: size };
}

// ----- verifications avant toute ecriture -----

async function listNames(args: readonly string[]): Promise<string[] | string> {
  const r = await virsh(TOOL, args, T_SHORT);
  if (r.code !== 0) return r.stderr || `virsh ${args[0]} a echoue (code ${r.code})`;
  return nameLines(r.stdout);
}

function volumeNames(name: string, entry: ImageEntry): string[] {
  return entry.fmt === 'iso' ? [`${name}.qcow2`, `${name}-install.iso`]
    : entry.fmt === 'cloud' ? [`${name}.qcow2`, `${name}-seed.iso`]
      : [`${name}.qcow2`];
}

async function checkHost(v: VmCreateFromImageParams, entry: ImageEntry, pool: string): Promise<string | null> {
  const domains = await listNames(['list', '--all', '--name']);
  if (typeof domains === 'string') return domains;
  if (domains.includes(v.name)) return `Le nom '${v.name}' est deja pris par une VM`;

  const networks = await listNames(['net-list', '--all', '--name']);
  if (typeof networks === 'string') return networks;
  if (!networks.includes(v.network)) return `Reseau libvirt '${v.network}' introuvable (disponibles: ${networks.join(', ') || 'aucun'})`;

  // vol-list : "Name  Path" puis une ligne par volume (le nom est la premiere colonne)
  const vols = await virsh(TOOL, ['vol-list', '--pool', pool], T_SHORT);
  if (vols.code !== 0) return `Pool '${pool}' illisible: ${vols.stderr || `code ${vols.code}`}`;
  const existing = new Set(vols.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]));
  const clash = volumeNames(v.name, entry).find((n) => existing.has(n));
  return clash ? `Le volume '${clash}' existe deja dans le pool '${pool}'` : null;
}

async function check(v: VmCreateFromImageParams): Promise<Checked> {
  const entry = findImage(v.image_id);
  if (!entry) return refuse(`Image inconnue: ${v.image_id}`);
  const pool = poolName();
  const warnings: string[] = [];
  const diskGb = v.disk_gb ?? entry.disk;
  const hostError = await checkHost(v, entry, pool);
  if (hostError) return refuse(hostError);

  const plan: Plan = {
    name: v.name, entry, pool,
    vcpus: v.vcpus ?? DEFAULT_VCPUS,
    memoryMib: v.memory_mib ?? entry.ram,
    diskGb, network: v.network,
    hostname: v.hostname ?? defaultHostname(v.name),
    user: v.user ?? entry.defaultUser ?? 'user',
    requestedUser: v.user,
    sshKey: v.ssh_key, start: v.start, warnings
  };

  if (entry.fmt === 'vb') {
    if (!v.ssh_key) return refuse('Image virt-builder : ssh_key requis (sans cle, la VM serait inaccessible)');
    return { ok: true, plan };
  }

  const dir = imagesDir();
  const sourcePath = await findCachedImage(dir, entry);
  if (sourcePath === null) {
    const how = entry.url ? `lancer vm_image_fetch image_id=${entry.id}` : `image a placer a la main dans ${dir}`;
    return refuse(`Image '${entry.id}' absente de ${dir} : ${how}`, { image_id: entry.id, images_dir: dir });
  }

  if (entry.fmt === 'iso') {
    plan.isoBytes = (await stat(sourcePath)).size;
    if (v.ssh_key || v.user || v.hostname) warnings.push('ssh_key, user et hostname ignores : une ISO s\'installe a la main');
    return { ok: true, plan: { ...plan, sourcePath } };
  }

  const info = await inspectDisk(sourcePath);
  if (typeof info === 'string') return refuse(`Image '${entry.id}' refusee : ${info}`);
  if (bytesFromGib(diskGb) < info.virtualBytes) {
    return refuse(`disk_gb=${diskGb} est plus petit que l'image (${gibCeil(info.virtualBytes)} Go) : un disque ne se reduit pas`, { image_gb: gibCeil(info.virtualBytes) });
  }
  if (!v.ssh_key) warnings.push('aucune cle ssh : le compte est verrouille, la connexion par ssh sera impossible (console seulement)');
  return { ok: true, plan: { ...plan, sourcePath, source: info } };
}

// ----- description des etapes (dry_run et compte rendu) -----

export function describeSteps(p: Plan): string[] {
  const vol = volumeNames(p.name, p.entry);
  const steps: string[] = [];
  if (p.entry.fmt === 'cloud') {
    steps.push(`copie de l'image ${p.entry.id} dans le volume ${vol[0]} du pool ${p.pool} (virsh vol-upload)`);
    if (p.source && bytesFromGib(p.diskGb) > p.source.virtualBytes) steps.push(`agrandissement du disque a ${p.diskGb} Go (virsh vol-resize)`);
    steps.push(`graine cloud-init (user ${p.user}, hote ${p.hostname}${p.sshKey ? ', cle ssh' : ''}) en ISO ${vol[1]} (xorriso)`);
  } else if (p.entry.fmt === 'vb') {
    steps.push(`virt-builder ${p.entry.vbTemplate} : disque ${p.diskGb} Go, hote ${p.hostname}, cle ssh injectee${p.requestedUser ? `, compte ${p.requestedUser}` : ''}`);
    steps.push(`copie du disque dans le volume ${vol[0]} du pool ${p.pool} (virsh vol-upload)`);
  } else {
    steps.push(`disque vide de ${p.diskGb} Go : volume ${vol[0]} du pool ${p.pool}`);
    steps.push(`copie de l'ISO ${p.entry.id} dans le volume ${vol[1]} (virsh vol-upload), demarrage sur le lecteur`);
  }
  steps.push(`definition de la VM ${p.name} (${p.vcpus} vCPU, ${p.memoryMib} MiB, reseau ${p.network}) : virsh define`);
  if (p.start) steps.push(`demarrage de ${p.name} (virsh start)`);
  return steps;
}

// ----- execution -----

async function must(label: string, r: Promise<{ code: number; stderr: string }>): Promise<void> {
  const res = await r;
  if (res.code !== 0) throw new StepError(`${label} : ${res.stderr || `code ${res.code}`}`);
}

async function addVolume(p: Plan, created: string[], name: string, bytes: number, format: string): Promise<void> {
  await must(`creation du volume ${name}`, virsh(TOOL, ['vol-create-as', p.pool, name, String(bytes), '--format', format], T_SHORT));
  created.push(name);
}

const uploadVolume = (p: Plan, name: string, file: string): Promise<void> =>
  must(`copie vers le volume ${name}`, virsh(TOOL, ['vol-upload', '--pool', p.pool, name, file], T_UPLOAD));

async function volumePath(p: Plan, name: string): Promise<string> {
  const r = await virsh(TOOL, ['vol-path', '--pool', p.pool, name], T_SHORT);
  const path = r.stdout.trim();
  if (r.code !== 0 || !isSafeVolumePath(path)) throw new StepError(`chemin du volume ${name} illisible ou refuse`);
  return path;
}

async function buildSeedIso(p: Plan, work: string): Promise<{ file: string; bytes: number }> {
  const seedDir = join(work, 'seed');
  await mkdir(seedDir, { recursive: true });
  await writeFile(join(seedDir, 'user-data'), buildUserData({ hostname: p.hostname, user: p.user, sshKey: p.sshKey }));
  await writeFile(join(seedDir, 'meta-data'), buildMetaData(p.hostname));
  const file = join(work, 'seed.iso');
  await must('image cloud-init (xorriso)', run('xorriso', [
    '-as', 'mkisofs', '-quiet', '-V', 'cidata', '-J', '-r', '-o', file,
    join(seedDir, 'user-data'), join(seedDir, 'meta-data')
  ], { tool: TOOL, timeoutMs: T_SHORT }));
  return { file, bytes: (await stat(file)).size };
}

function builderArgs(p: Plan, output: string): string[] {
  const args = [
    p.entry.vbTemplate as string, '--quiet', '--format', 'qcow2', '--size', `${p.diskGb}G`, '--output', output,
    '--hostname', p.hostname, '--root-password', 'disabled', '--ssh-inject', `root:string:${p.sshKey}`
  ];
  // compte supplementaire seulement si l'appelant le demande (ex. user=ops) : sinon root par cle
  if (p.requestedUser) {
    args.push('--run-command', `useradd -m -s /bin/bash ${p.requestedUser}`, '--ssh-inject', `${p.requestedUser}:string:${p.sshKey}`);
  }
  return args;
}

async function prepareDisks(p: Plan, work: string, created: string[]): Promise<DomainDisk[]> {
  const [diskName, extraName] = volumeNames(p.name, p.entry);
  const disk = (path: string, format: 'qcow2' | 'raw', order: number): DomainDisk =>
    ({ path, format, device: 'disk', target: 'vda', bootOrder: order });
  const cdrom = (path: string, order?: number): DomainDisk =>
    ({ path, format: 'raw', device: 'cdrom', target: 'sda', bootOrder: order });

  if (p.entry.fmt === 'cloud') {
    const src = p.source as DiskInfo;
    await addVolume(p, created, diskName, src.virtualBytes, src.format);
    await uploadVolume(p, diskName, p.sourcePath as string);
    await must('actualisation du pool', virsh(TOOL, ['pool-refresh', p.pool], T_SHORT));
    if (bytesFromGib(p.diskGb) > src.virtualBytes) {
      await must('agrandissement du disque', virsh(TOOL, ['vol-resize', '--pool', p.pool, diskName, String(bytesFromGib(p.diskGb))], T_SHORT));
    }
    const seed = await buildSeedIso(p, work);
    await addVolume(p, created, extraName, seed.bytes, 'raw');
    await uploadVolume(p, extraName, seed.file);
    return [disk(await volumePath(p, diskName), src.format, 1), cdrom(await volumePath(p, extraName))];
  }

  if (p.entry.fmt === 'vb') {
    const output = join(work, 'disk.qcow2');
    await must('virt-builder', run('virt-builder', builderArgs(p, output), { tool: TOOL, timeoutMs: T_BUILD }));
    const built = await inspectDisk(output);
    if (typeof built === 'string') throw new StepError(`disque virt-builder refuse : ${built}`);
    await addVolume(p, created, diskName, built.virtualBytes, 'qcow2');
    await uploadVolume(p, diskName, output);
    return [disk(await volumePath(p, diskName), 'qcow2', 1)];
  }

  await addVolume(p, created, diskName, bytesFromGib(p.diskGb), 'qcow2');
  await addVolume(p, created, extraName, p.isoBytes as number, 'raw');
  await uploadVolume(p, extraName, p.sourcePath as string);
  return [cdrom(await volumePath(p, extraName), 1), disk(await volumePath(p, diskName), 'qcow2', 2)];
}

async function rollback(p: Plan, created: readonly string[], defined: boolean): Promise<string[]> {
  const undone: string[] = [];
  if (defined) {
    const r = await virsh(TOOL, ['undefine', p.name], T_SHORT);
    if (r.code === 0) undone.push(`VM ${p.name}`);
  }
  for (const vol of [...created].reverse()) {
    const r = await virsh(TOOL, ['vol-delete', '--pool', p.pool, vol], T_SHORT);
    if (r.code === 0) undone.push(`volume ${vol}`);
  }
  return undone;
}

async function build(p: Plan): Promise<ToolResult> {
  const dir = imagesDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(dir, '.work-'));
  const created: string[] = [];
  let defined = false;
  try {
    const disks = await prepareDisks(p, work, created);
    const xml = buildDomainXml({
      name: p.name, memoryMib: p.memoryMib, vcpus: p.vcpus, network: p.network, disks,
      serialLogPath: `/var/log/libvirt/qemu/${p.name}-serial0.log`
    });
    const xmlFile = join(work, 'domain.xml');
    await writeFile(xmlFile, xml);
    await must('definition de la VM', virsh(TOOL, ['define', xmlFile], T_SHORT));
    defined = true;

    let started = false;
    if (p.start) {
      const r = await virsh(TOOL, ['start', p.name], T_SHORT);
      started = r.code === 0;
      if (!started) p.warnings.push(`VM creee mais le demarrage a echoue : ${r.stderr || `code ${r.code}`}`);
    }
    return ok({
      vm: p.name, image_id: p.entry.id, format: p.entry.fmt, vcpus: p.vcpus, memory_mib: p.memoryMib,
      disk_gb: p.diskGb, network: p.network, user: p.entry.fmt === 'iso' ? null : p.entry.fmt === 'vb' ? (p.requestedUser ?? 'root') : p.user,
      ssh_key: p.sshKey !== undefined, started, volumes: created, warnings: p.warnings
    });
  } catch (error) {
    const message = error instanceof StepError ? error.message : `erreur inattendue : ${error instanceof Error ? error.message : String(error)}`;
    const rolledBack = await rollback(p, created, defined);
    return fail(ErrorCode.SCRIPT_ERROR, message, { rolled_back: rolledBack });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function vmCreateFromImageHandler(params: unknown): Promise<ToolResult> {
  const validated = vmCreateFromImageSchema.parse(params) as VmCreateFromImageParams;
  const checked = await check(validated);
  if (!checked.ok) return checked.result;
  const { plan } = checked;

  if (validated.dry_run) {
    return ok({
      dry_run: true, vm: plan.name, image_id: plan.entry.id, format: plan.entry.fmt, vcpus: plan.vcpus,
      memory_mib: plan.memoryMib, disk_gb: plan.diskGb, network: plan.network, steps: describeSteps(plan),
      warnings: plan.warnings
    });
  }
  return build(plan);
}

export const vmCreateFromImage: ToolDefinition = {
  name: 'vm_create_from_image',
  description: [
    'Cree une VM depuis une image du catalogue interne (image_id) : image cloud (copie + redimensionnement + graine cloud-init),',
    'virt-builder (image assemblee avec cle ssh et nom d\'hote) ou ISO (disque vide + ISO attachee, demarrage sur le lecteur).',
    'Refuse un nom deja pris, une image absente de ~/vm-images, un disque plus petit que l\'image, un reseau inconnu.',
    'dry_run=true decrit les etapes sans rien creer. start=true demarre la VM apres creation. Defauts : 2 vCPU, memoire et disque conseilles par le catalogue.'
  ].join(' '),
  inputSchema: vmCreateFromImageSchema,
  handler: vmCreateFromImageHandler
};

export const vmCreateTools: ToolDefinition[] = [vmCreateFromImage];
