/**
 * Graine cloud-init (NoCloud) : user-data et meta-data. Fonctions pures.
 *
 * Toute valeur issue de l'appelant est ecrite entre guillemets JSON (un texte JSON est du YAML
 * valide) : un retour a la ligne ou un deux-points ne peut ni ajouter une cle ni sortir de la valeur.
 */

import { randomUUID } from 'node:crypto';

export interface SeedSpec {
  hostname: string;
  user: string;
  sshKey?: string;
}

const q = (value: string): string => JSON.stringify(value);

export function buildUserData(spec: SeedSpec): string {
  const lines = [
    '#cloud-config',
    `hostname: ${q(spec.hostname)}`,
    'manage_etc_hosts: true',
    'users:',
    `  - name: ${q(spec.user)}`,
    '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
    '    shell: /bin/bash',
    '    lock_passwd: true'
  ];
  if (spec.sshKey) {
    lines.push('    ssh_authorized_keys:', `      - ${q(spec.sshKey)}`);
  }
  lines.push('ssh_pwauth: false', '');
  return lines.join('\n');
}

/** instance-id neuf a chaque creation : cloud-init rejoue sa configuration pour une VM neuve. */
export function buildMetaData(hostname: string, instanceId: string = randomUUID()): string {
  return `instance-id: ${q(instanceId)}\nlocal-hostname: ${q(hostname)}\n`;
}

/** Nom d'hote par defaut : le nom de la VM, en minuscules, `_` devenu `-`, borne a 63 caracteres. */
export function defaultHostname(vmName: string): string {
  const base = vmName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return base.replace(/-+$/g, '') || 'vm';
}
