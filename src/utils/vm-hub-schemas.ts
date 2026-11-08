/**
 * Schemas Zod des outils "hub" : pause, reprise, redemarrage, creation depuis une image,
 * console graphique et journal serie.
 */

import { z } from 'zod';
import { IMAGE_IDS } from './vm-images.js';
import { flexibleBoolean, vmNameSchema } from './validation.js';

// Reseau libvirt : nom court, caracteres surs, premier caractere alphanumerique
export const networkNameSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Caracteres autorises: a-z, A-Z, 0-9, _, ., - (alphanumerique en premier)');

// Nom d'hote (etiquette RFC 1123)
export const hostnameSchema = z.string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Nom d\'hote: minuscules, chiffres et tirets (ni en premier ni en dernier)');

// Compte Unix
export const unixUserSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[a-z_][a-z0-9_-]*$/, 'Compte: minuscules, chiffres, _ et - (commence par une lettre ou _)');

// Cle publique OpenSSH sur une seule ligne : type connu, base64, commentaire sans controle
const SSH_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{20,4096}={0,2}(?: [^\r\n]{1,128})?$/;
export const sshPublicKeySchema = z.string()
  .max(4600)
  .regex(SSH_KEY, 'Cle publique OpenSSH attendue (une ligne: ssh-ed25519 AAAA... commentaire)')
  .refine((key) => ![...key].some((ch) => (ch.codePointAt(0) ?? 0) < 32 || ch === '\x7f'), 'Caracteres de controle interdits');

// ----- cycle de vie -----

export const vmPauseSchema = z.object({
  vm_name: vmNameSchema
});

export const vmResumeSchema = z.object({
  vm_name: vmNameSchema
});

export const vmRebootSchema = z.object({
  vm_name: vmNameSchema,
  /** reset materiel immediat au lieu de l'arret ACPI */
  force: flexibleBoolean.optional().default(false),
  /** true : attend le redemarrage (arret ACPI, puis demarrage). false : rend la main tout de suite. */
  wait: flexibleBoolean.optional().default(false),
  /** delai de l'arret ACPI quand wait=true (secondes) */
  timeout: z.number().int().min(10).max(300).optional().default(90)
});

// ----- creation depuis une image -----

export const vmCreateFromImageSchema = z.object({
  name: vmNameSchema,
  image_id: z.enum(IMAGE_IDS),
  /** defaut 2 */
  vcpus: z.number().int().min(1).max(32).optional(),
  /** defaut : memoire conseillee par le catalogue */
  memory_mib: z.number().int().min(256).max(65536).optional(),
  /** defaut : disque conseille par le catalogue */
  disk_gb: z.number().int().min(1).max(1024).optional(),
  network: networkNameSchema.optional().default('default'),
  ssh_key: sshPublicKeySchema.optional(),
  hostname: hostnameSchema.optional(),
  user: unixUserSchema.optional(),
  start: flexibleBoolean.optional().default(false),
  dry_run: flexibleBoolean.optional().default(false)
});

export const vmImageFetchSchema = z.object({
  image_id: z.enum(IMAGE_IDS)
});

// ----- console -----

export const vmConsoleSchema = z.object({
  vm_name: vmNameSchema,
  /** `auto` : le premier affichage graphique declare par la VM */
  type: z.enum(['spice', 'vnc', 'auto']).optional().default('auto')
});

export const vmConsoleLogSchema = z.object({
  vm_name: vmNameSchema,
  lines: z.number().int().min(1).max(2000).optional().default(100)
});

export type VmPauseParams = z.infer<typeof vmPauseSchema>;
export type VmResumeParams = z.infer<typeof vmResumeSchema>;
export type VmRebootParams = z.infer<typeof vmRebootSchema>;
export type VmCreateFromImageParams = z.infer<typeof vmCreateFromImageSchema>;
export type VmImageFetchParams = z.infer<typeof vmImageFetchSchema>;
export type VmConsoleParams = z.infer<typeof vmConsoleSchema>;
export type VmConsoleLogParams = z.infer<typeof vmConsoleLogSchema>;
