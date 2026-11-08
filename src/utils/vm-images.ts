/**
 * Catalogue interne d'images pour creer une VM (vm_create_from_image, vm_image_fetch).
 *
 * Les identifiants (`id`), formats (`fmt`) et sources (`src`) recopient le catalogue de
 * lyra-control-api (`lib/vm_library.py`) : l'API et l'ecran designent une image par ces
 * identifiants. Aucune URL ne vient de l'agent : seules les entrees ci-dessous qui portent
 * `url` (adresse https officielle verifiee le 2026-11-08) peuvent etre telechargees. Les autres
 * (ISO a nom versionne, images sans lien stable) se placent a la main dans `VM_IMAGES_DIR`.
 *
 * Convention de fichier en cache (identique a l'API) : le nom, avant le premier point, vaut
 * l'identifiant (`debian-cloud.qcow2`) ou commence par `<id>_` (`debian-cloud_12.5.iso`).
 * Le tiret n'est PAS un separateur : `alpine-std.iso` n'est pas l'image `alpine`.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

export type ImageFormat = 'iso' | 'cloud' | 'vb';

export interface ImageEntry {
  id: string;
  fmt: ImageFormat;
  /** Origine indicative (domaine) : meme valeur que le catalogue de l'API */
  src: string;
  nom: string;
  /** Taille indicative en Mo */
  mb: number;
  /** Memoire conseillee (MiB) et disque conseille (Go) */
  ram: number;
  disk: number;
  /** Adresse https officielle (cloud uniquement). Absente : image a placer a la main. */
  url?: string;
  /** Compte cree par defaut par l'image cloud */
  defaultUser?: string;
  /** Modele virt-builder (fmt vb) */
  vbTemplate?: string;
}

function e(
  id: string, fmt: ImageFormat, src: string, nom: string, mb: number, ram: number, disk: number,
  extra: Pick<ImageEntry, 'url' | 'defaultUser' | 'vbTemplate'> = {}
): ImageEntry {
  return { id, fmt, src, nom, mb, ram, disk, ...extra };
}

export const IMAGE_CATALOGUE: readonly ImageEntry[] = [
  e('cirros', 'cloud', 'download.cirros-cloud.net', 'CirrOS 0.6', 21, 256, 2, {
    url: 'https://download.cirros-cloud.net/0.6.2/cirros-0.6.2-x86_64-disk.img', defaultUser: 'cirros'
  }),
  e('tinycore', 'iso', 'tinycorelinux.net', 'Tiny Core Linux 15', 17, 256, 2),
  e('alpine', 'iso', 'alpinelinux.org', 'Alpine Linux 3.22 virt', 65, 512, 4),
  e('alpine-std', 'iso', 'alpinelinux.org', 'Alpine Linux 3.22 standard', 220, 512, 4),
  e('debian-cloud', 'cloud', 'cloud.debian.org', 'Debian 12 genericcloud', 340, 1024, 10, {
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2',
    defaultUser: 'debian'
  }),
  e('vb-debian', 'vb', 'libguestfs.org', 'Debian 12 virt-builder', 250, 1024, 10, { vbTemplate: 'debian-12' }),
  e('debian-netinst', 'iso', 'debian.org', 'Debian 12 netinst', 650, 2048, 20),
  e('debian-gnome', 'iso', 'debian.org', 'Debian 12 Live GNOME', 3000, 4096, 25),
  e('debian-kde', 'iso', 'debian.org', 'Debian 12 Live KDE Plasma', 3100, 4096, 25),
  e('debian-xfce', 'iso', 'debian.org', 'Debian 12 Live Xfce', 2800, 2048, 20),
  e('fedora-cloud', 'cloud', 'download.fedoraproject.org', 'Fedora 43 Cloud Base', 480, 2048, 15, {
    // dossier de release fige : le nom de fichier (numero de compose) ne change plus
    url: 'https://download.fedoraproject.org/pub/fedora/linux/releases/43/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-43-1.6.x86_64.qcow2',
    defaultUser: 'fedora'
  }),
  e('vb-fedora', 'vb', 'libguestfs.org', 'Fedora 43 virt-builder', 300, 2048, 15, { vbTemplate: 'fedora-43' }),
  e('fedora-server', 'iso', 'fedoraproject.org', 'Fedora Server 43 netinst', 900, 2048, 20),
  e('fedora-ws', 'iso', 'fedoraproject.org', 'Fedora Workstation 43', 2300, 4096, 30),
  e('fedora-kde', 'iso', 'fedoraproject.org', 'Fedora KDE 43', 2400, 4096, 30),
  e('fedora-xfce', 'iso', 'fedoraproject.org', 'Fedora Xfce 43', 2000, 2048, 25),
  e('fedora-sway', 'iso', 'fedoraproject.org', 'Fedora Sway 43', 2000, 2048, 25),
  e('ubuntu-cloud', 'cloud', 'cloud-images.ubuntu.com', 'Ubuntu 24.04 cloud image', 600, 2048, 15, {
    url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', defaultUser: 'ubuntu'
  }),
  e('ubuntu-iso', 'iso', 'ubuntu.com', 'Ubuntu Server 24.04 live', 2800, 2048, 20),
  e('ubuntu-desktop', 'iso', 'ubuntu.com', 'Ubuntu Desktop 24.04', 6000, 4096, 30),
  e('xubuntu', 'iso', 'xubuntu.org', 'Xubuntu 24.04', 3900, 2048, 25),
  e('arch-cloud', 'cloud', 'geo.mirror.pkgbuild.com', 'Arch Linux cloud image', 520, 1024, 10, {
    url: 'https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2', defaultUser: 'arch'
  }),
  e('arch-iso', 'iso', 'archlinux.org', 'Arch Linux ISO', 1300, 2048, 20),
  e('rocky', 'iso', 'rockylinux.org', 'Rocky Linux 9 minimal', 1700, 2048, 20),
  e('kali', 'iso', 'kali.org', 'Kali Linux 2026.3 installer', 4200, 4096, 40),
];

export const IMAGE_IDS = IMAGE_CATALOGUE.map((x) => x.id) as [string, ...string[]];

export function findImage(id: string): ImageEntry | undefined {
  return IMAGE_CATALOGUE.find((x) => x.id === id);
}

const GIB = 1024 ** 3;
export const bytesFromGib = (gib: number): number => gib * GIB;
export const gibCeil = (bytes: number): number => Math.ceil(bytes / GIB);

// ----- dossiers et noms (lus a chaque appel : les tests les redirigent par l'environnement) -----

/** Dossier des images (`VM_IMAGES_DIR`, defaut ~/vm-images) : le seul ou l'outil lit et ecrit. */
export function imagesDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VM_IMAGES_DIR?.trim();
  return fromEnv ? fromEnv : join(homedir(), 'vm-images');
}

const POOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Pool libvirt qui recoit les disques (`VM_HUB_POOL`, defaut `default`). */
export function poolName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VM_HUB_POOL?.trim();
  if (fromEnv && POOL_PATTERN.test(fromEnv)) return fromEnv;
  return 'default';
}

const EXTENSIONS: Record<ImageFormat, readonly string[]> = {
  cloud: ['.qcow2', '.img', '.raw'],
  iso: ['.iso'],
  vb: []
};

/** Extension du fichier telecharge, deduite de l'URL du catalogue. */
export function downloadExtension(entry: ImageEntry): string {
  const last = new URL(entry.url ?? 'https://invalid/').pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  const ext = dot >= 0 ? last.slice(dot).toLowerCase() : '';
  return EXTENSIONS[entry.fmt].includes(ext) ? ext : '.qcow2';
}

export function matchesImageName(fileName: string, id: string, fmt: ImageFormat): boolean {
  const low = fileName.toLowerCase();
  if (low.startsWith('.')) return false;
  const ext = low.includes('.') ? low.slice(low.lastIndexOf('.')) : '';
  if (!EXTENSIONS[fmt].includes(ext)) return false;
  return low.split('.', 1)[0] === id || low.startsWith(`${id}_`);
}

/**
 * Chemin reel du fichier d'une image dans le dossier d'images, ou null. Le chemin resolu
 * (liens suivis) doit rester DANS le dossier et designer un fichier ordinaire.
 */
export async function findCachedImage(dir: string, entry: ImageEntry): Promise<string | null> {
  let names: string[];
  let root: string;
  try {
    names = (await readdir(dir)).sort();
    root = await realpath(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!matchesImageName(name, entry.id, entry.fmt)) continue;
    try {
      const real = await realpath(join(dir, name));
      if (!real.startsWith(root + sep)) continue;
      if ((await stat(real)).isFile()) return real;
    } catch {
      // fichier illisible ou lien casse : on passe au suivant
    }
  }
  return null;
}
