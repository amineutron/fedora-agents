/**
 * XML de domaine pour une VM creee depuis une image (construction) et lecture du XML d'une
 * VM existante (affichage graphique, journal serie). Fonctions pures.
 *
 * Aucune bibliotheque XML : le XML construit n'utilise que des valeurs deja validees par les
 * schemas (noms, reseau) ou rendues par libvirt (chemins de volumes), toutes echappees ; le XML
 * lu vient de `virsh dumpxml` (libvirt le produit bien forme) et n'est interroge que par motifs.
 */

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Inverse de xmlEscape : les cinq entites predefinies, telles que libvirt les ecrit. */
export function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Chemin de volume rendu par `virsh vol-path` : absolu, caracteres surs, pas de `..`
const VOLUME_PATH = /^\/[A-Za-z0-9._/-]+$/;
export function isSafeVolumePath(path: string): boolean {
  return VOLUME_PATH.test(path) && !path.includes('..');
}

export interface DomainDisk {
  path: string;
  format: 'qcow2' | 'raw';
  device: 'disk' | 'cdrom';
  /** `vda` (virtio) ou `sda` (sata) */
  target: string;
  /** ordre de demarrage (1 = premier) ; absent = pas de demarrage dessus */
  bootOrder?: number;
}

export interface DomainSpec {
  name: string;
  memoryMib: number;
  vcpus: number;
  network: string;
  disks: readonly DomainDisk[];
  /** journal du port serie ecrit par virtlogd */
  serialLogPath: string;
}

function diskXml(d: DomainDisk): string {
  if (!isSafeVolumePath(d.path)) throw new Error(`chemin de volume refuse: ${d.path}`);
  const bus = d.device === 'cdrom' ? 'sata' : 'virtio';
  const boot = d.bootOrder !== undefined ? `\n      <boot order='${d.bootOrder}'/>` : '';
  const readonly = d.device === 'cdrom' ? '\n      <readonly/>' : '';
  return `    <disk type='file' device='${d.device}'>
      <driver name='qemu' type='${d.format}'/>
      <source file='${xmlEscape(d.path)}'/>
      <target dev='${xmlEscape(d.target)}' bus='${bus}'/>${readonly}${boot}
    </disk>`;
}

/**
 * Domaine q35 / BIOS, virtio, ecran SPICE sur 127.0.0.1 (jamais une interface publique),
 * canal agent invite, port serie journalise.
 */
export function buildDomainXml(spec: DomainSpec): string {
  return `<domain type='kvm'>
  <name>${xmlEscape(spec.name)}</name>
  <memory unit='MiB'>${spec.memoryMib}</memory>
  <currentMemory unit='MiB'>${spec.memoryMib}</currentMemory>
  <vcpu placement='static'>${spec.vcpus}</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-model' check='partial'/>
  <clock offset='utc'>
    <timer name='rtc' tickpolicy='catchup'/>
    <timer name='pit' tickpolicy='delay'/>
    <timer name='hpet' present='no'/>
  </clock>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
${spec.disks.map(diskXml).join('\n')}
    <interface type='network'>
      <source network='${xmlEscape(spec.network)}'/>
      <model type='virtio'/>
    </interface>
    <serial type='pty'>
      <target type='isa-serial' port='0'>
        <model name='isa-serial'/>
      </target>
      <log file='${xmlEscape(spec.serialLogPath)}' append='on'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
    <channel type='unix'>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
    </channel>
    <input type='tablet' bus='usb'/>
    <graphics type='spice' autoport='yes'>
      <listen type='address' address='127.0.0.1'/>
    </graphics>
    <video>
      <model type='virtio' heads='1' primary='yes'/>
    </video>
    <memballoon model='virtio'/>
    <rng model='virtio'>
      <backend model='random'>/dev/urandom</backend>
    </rng>
  </devices>
</domain>
`;
}

// ----- lecture du XML d'une VM -----

export interface XmlElement {
  attrs: Record<string, string>;
  body: string;
}

/** Attributs d'une balise ouvrante (entites decodees), quel que soit leur ordre ou le type de guillemets. */
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")/g)) {
    out[m[1]] = xmlUnescape(m[2] ?? m[3] ?? '');
  }
  return out;
}

/** Elements `<name ...>...</name>` ou `<name .../>` : [attributs de l'ouvrante, corps]. */
export function elements(xml: string, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const re = new RegExp(`<${name}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${name}>)`, 'g');
  for (const m of xml.matchAll(re)) {
    out.push({ attrs: attrs(m[1] ?? ''), body: m[3] ?? '' });
  }
  return out;
}

export interface GraphicsInfo {
  type: string;
  /** port TCP attribue (VM allumee) ; null si absent ou -1 */
  port: number | null;
  /** adresse d'ecoute ; null si le serveur n'ecoute que sur un socket Unix */
  address: string | null;
  socket: string | null;
}

export function parseGraphics(xml: string): GraphicsInfo[] {
  return elements(xml, 'graphics').map(({ attrs: a, body }) => {
    const listens = elements(body, 'listen');
    const socketListen = listens.find((l) => l.attrs.type === 'socket' && l.attrs.socket);
    const addrListen = listens.find((l) => l.attrs.address);
    const portNum = a.port !== undefined ? Number(a.port) : Number.NaN;
    const socket = socketListen?.attrs.socket ?? a.socket ?? null;
    return {
      type: a.type ?? 'unknown',
      port: Number.isInteger(portNum) && portNum > 0 ? portNum : null,
      address: addrListen?.attrs.address ?? a.listen ?? null,
      socket
    };
  });
}

/** Adresses d'ecoute qui ne sortent pas de la machine. */
export function isLoopback(address: string | null): boolean {
  if (address === null) return true;
  return address === '127.0.0.1' || address === '::1' || address === 'localhost' || /^127\./.test(address);
}

export interface SerialLog {
  /** `log` : <log file=...> ; `file` : serie de type fichier */
  kind: 'log' | 'file';
  path: string;
}

/** Journaux du port serie declares par la VM (journal virtlogd d'abord, serie de type fichier ensuite). */
export function parseSerialLogs(xml: string): SerialLog[] {
  const logs: SerialLog[] = [];
  const files: SerialLog[] = [];
  for (const tag of ['serial', 'console']) {
    for (const { attrs: a, body } of elements(xml, tag)) {
      const log = elements(body, 'log')[0]?.attrs.file;
      if (log) logs.push({ kind: 'log', path: log });
      const source = elements(body, 'source')[0]?.attrs.path;
      if (a.type === 'file' && source) files.push({ kind: 'file', path: source });
    }
  }
  return [...logs, ...files];
}
