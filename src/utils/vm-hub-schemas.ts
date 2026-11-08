/**
 * Schemas Zod des outils "hub" : pause, reprise, redemarrage, creation depuis une image,
 * console graphique et journal serie, edition du materiel et lecture du materiel.
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

// ----- edition et materiel -----

/** vm_edit : liste FERMEE de parametres. Au moins un doit etre fourni. */
export const VM_EDIT_LIMITS = {
  vcpus: { min: 1, max: 32 },
  memory_mib: { min: 512, max: 65536 },
  description: 256,
  disk_grow_gb: { min: 1, max: 2048 },
  cpu_models: ['host-passthrough', 'host-model', 'x86-64-v2', 'qemu64'],
  boot_devices: ['hd', 'cdrom', 'network'],
  displays: ['spice', 'vnc']
} as const;

/** Champs qui exigent une VM ARRETEE (effet au prochain demarrage) ; les autres s'appliquent VM allumee ou eteinte. */
export const VM_EDIT_NEEDS_STOP = ['vcpus', 'memory_mib', 'cpu_model', 'firmware', 'tpm', 'secure_boot', 'disk_grow_gb'] as const;
/** Champs appliques a chaud quand la VM tourne (usb, reseau), en plus de la config persistante. */
export const VM_EDIT_HOT = ['usb_attach', 'usb_detach', 'network'] as const;

export const VM_EDIT_FIELDS = [
  'vcpus', 'memory_mib', 'autostart', 'description', 'cpu_model', 'firmware', 'tpm', 'secure_boot',
  'boot_order', 'usb_attach', 'usb_detach', 'display', 'network', 'disk_grow_gb'
] as const;
export type VmEditField = typeof VM_EDIT_FIELDS[number];

// vendor:product USB en hexadecimal (4 + 4 chiffres), ex. 046d:c52b
export const usbIdSchema = z.string().regex(/^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$/, 'Format vendor:product en hexadecimal (ex. 046d:c52b)');

const hasControlChar = (text: string): boolean => [...text].some((ch) => (ch.codePointAt(0) ?? 0) < 32 || ch === '\x7f');

export const vmEditSchema = z.object({
  vm_name: vmNameSchema,
  vcpus: z.number().int().min(VM_EDIT_LIMITS.vcpus.min).max(VM_EDIT_LIMITS.vcpus.max).optional(),
  memory_mib: z.number().int().min(VM_EDIT_LIMITS.memory_mib.min).max(VM_EDIT_LIMITS.memory_mib.max).optional(),
  autostart: flexibleBoolean.optional(),
  /** Chaine vide = effacer la description */
  description: z.string().max(VM_EDIT_LIMITS.description)
    .refine((v) => !hasControlChar(v), 'Caracteres de controle interdits').optional(),
  cpu_model: z.enum(VM_EDIT_LIMITS.cpu_models).optional(),
  firmware: z.enum(['bios', 'uefi']).optional(),
  tpm: flexibleBoolean.optional(),
  /** Exige firmware=uefi dans le meme appel */
  secure_boot: flexibleBoolean.optional(),
  /** Ordre de demarrage, du premier au dernier, sans doublon */
  boot_order: z.array(z.enum(VM_EDIT_LIMITS.boot_devices)).min(1).max(VM_EDIT_LIMITS.boot_devices.length).optional(),
  usb_attach: usbIdSchema.optional(),
  usb_detach: usbIdSchema.optional(),
  display: z.enum(VM_EDIT_LIMITS.displays).optional(),
  network: networkNameSchema.optional(),
  /** Agrandissement seulement (jamais de reduction), en Go */
  disk_grow_gb: z.number().int().min(VM_EDIT_LIMITS.disk_grow_gb.min).max(VM_EDIT_LIMITS.disk_grow_gb.max).optional()
}).strict()
  .refine(
    (v) => VM_EDIT_FIELDS.some((k) => v[k] !== undefined),
    { message: `Au moins un parametre a modifier est requis (${VM_EDIT_FIELDS.join(', ')})` }
  )
  .refine(
    (v) => v.boot_order === undefined || new Set(v.boot_order).size === v.boot_order.length,
    { message: 'boot_order: pas de doublon', path: ['boot_order'] }
  )
  .refine(
    (v) => v.secure_boot === undefined || v.firmware === 'uefi',
    { message: 'secure_boot exige firmware=uefi dans le meme appel', path: ['secure_boot'] }
  )
  .refine(
    (v) => v.usb_attach === undefined || v.usb_detach === undefined || v.usb_attach.toLowerCase() !== v.usb_detach.toLowerCase(),
    { message: 'usb_attach et usb_detach designent le meme peripherique', path: ['usb_detach'] }
  );

/** Vrai si au moins un champ demande une VM arretee. */
export function vmEditNeedsStop(v: Record<string, unknown>): boolean {
  return VM_EDIT_NEEDS_STOP.some((k) => v[k] !== undefined);
}

export const vmHardwareSchema = z.object({
  vm_name: vmNameSchema
});

export type VmPauseParams = z.infer<typeof vmPauseSchema>;
export type VmResumeParams = z.infer<typeof vmResumeSchema>;
export type VmRebootParams = z.infer<typeof vmRebootSchema>;
export type VmCreateFromImageParams = z.infer<typeof vmCreateFromImageSchema>;
export type VmImageFetchParams = z.infer<typeof vmImageFetchSchema>;
export type VmConsoleParams = z.infer<typeof vmConsoleSchema>;
export type VmConsoleLogParams = z.infer<typeof vmConsoleLogSchema>;
export type VmEditParams = z.infer<typeof vmEditSchema>;
export type VmHardwareParams = z.infer<typeof vmHardwareSchema>;
