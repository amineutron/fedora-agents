/**
 * Configuration centrale du serveur MCP
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Racine des scripts bash (vm-controller, backup-manager, kvm).
 *
 * Ordre de resolution :
 *   1. LYRA_SCRIPTS_DIR (variable d'environnement)
 *   2. /usr/local/lib/lyra/scripts : copie root:root 0755 installee par
 *      l'installeur Lyra. C'est la SEULE disposition compatible avec des
 *      regles sudoers NOPASSWD : un script dans $HOME (inscriptible par
 *      l'utilisateur) donnerait root a n'importe quel processus de son uid.
 *   3. scripts/ du depot (developpement, sans sudoers).
 */
export const SYSTEM_SCRIPTS_DIR = '/usr/local/lib/lyra/scripts';

export function resolveScriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.LYRA_SCRIPTS_DIR;
  if (fromEnv?.trim()) return resolve(fromEnv);
  if (existsSync(SYSTEM_SCRIPTS_DIR)) return SYSTEM_SCRIPTS_DIR;
  return resolve(__dirname, '../scripts');
}

export const SCRIPTS_DIR = resolveScriptsDir();

// Chemins vers les agents
export const PATHS = {
  SCRIPTS_DIR,
  AGENTS_DIR: resolve(SCRIPTS_DIR, 'agents'),
  VM_CONTROLLER: resolve(SCRIPTS_DIR, 'agents/vm-controller'),
  BACKUP_MANAGER: resolve(SCRIPTS_DIR, 'agents/backup-manager'),
  KVM_SCRIPTS: resolve(SCRIPTS_DIR, 'kvm'),
} as const;

// Timeouts par outil (en ms)
export const TIMEOUTS: Record<string, number> = {
  // VM Controller
  vm_start: 300_000,      // 5 min (attente SSH)
  vm_stop: 120_000,       // 2 min
  vm_status: 30_000,      // 30s
  vm_exec: 300_000,       // 5 min
  vm_copy: 300_000,       // 5 min
  vm_snapshot: 120_000,   // 2 min
  vm_verify: 300_000,     // 5 min (vérification complète)
  vm_clone: 600_000,      // 10 min (clone complet)
  vm_clone_system: 1800_000, // 30 min (clone système entier)
  vm_export: 900_000,     // 15 min (export + virt-sysprep + tarball)
  vm_import: 600_000,     // 10 min (extraction + copie + virsh define)
  vm_pause: 30_000,
  vm_resume: 30_000,
  vm_reboot: 120_000,     // 2 min (arret ACPI + demarrage si wait)
  vm_create_from_image: 1800_000, // 30 min (virt-builder, copie d'ISO)
  vm_image_fetch: 1800_000,       // 30 min (telechargement)
  vm_console: 30_000,
  vm_console_log: 30_000,
  vm_hardware: 30_000,
  vm_edit: 300_000,       // 5 min (virt-xml par champ, virsh vol-resize)

  // Backup Manager
  backup_create: 600_000,  // 10 min
  backup_list: 60_000,     // 1 min
  backup_restore: 900_000, // 15 min
  backup_verify: 300_000,  // 5 min
  backup_clean: 300_000,   // 5 min
  backup_status: 60_000,   // 1 min

  // Default
  default: 60_000          // 1 min
};

// Permissions et flags par outil
export interface ToolPermission {
  requiresSudo: boolean;
  dangerous: boolean;
  description: string;
}

// Outils sans aucun effet de bord : ils lisent un etat, ils ne le modifient pas.
// Sert a deriver readOnlyHint des ToolAnnotations MCP exposees par list_tools.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'help', 'vm_status', 'vm_verify', 'backup_status', 'backup_list', 'backup_verify',
  'vm_console', 'vm_console_log', 'vm_hardware'
]);

// Outils rejouables sans effet cumulatif (relancer ne change rien de plus).
// vm_snapshot, backup_create, vm_clone ou vm_export creent un objet a chaque
// appel : ils n'en font pas partie.
export const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'help', 'vm_status', 'vm_verify', 'backup_status', 'backup_list', 'backup_verify',
  'vm_start', 'vm_stop', 'vm_destroy', 'vm_copy', 'backup_restore',
  'vm_pause', 'vm_resume', 'vm_image_fetch', 'vm_console', 'vm_console_log', 'vm_hardware'
]);

export const TOOL_PERMISSIONS: Record<string, ToolPermission> = {
  // Aide
  help: {
    requiresSudo: false,
    dangerous: false,
    description: 'Liste les outils disponibles'
  },

  // VM Controller - lecture
  vm_status: {
    requiresSudo: false,
    dangerous: false,
    description: 'Affiche le status d\'une VM'
  },

  // VM Controller - modification
  vm_start: {
    requiresSudo: false,
    dangerous: false,
    description: 'Démarre une VM'
  },
  vm_stop: {
    requiresSudo: false,
    dangerous: true,
    description: 'Arrête une VM (peut causer perte de données non sauvegardées)'
  },
  vm_exec: {
    requiresSudo: false,
    dangerous: true,   // commande arbitraire dans la VM (audit Lyra 2026-09-19)
    description: 'Exécute une commande dans une VM'
  },
  vm_copy: {
    requiresSudo: false,
    dangerous: true,   // ecrase des fichiers hote/VM (scp)
    description: 'Copie des fichiers vers/depuis une VM'
  },
  vm_snapshot: {
    requiresSudo: false,
    dangerous: true,   // revert remplace l'etat, delete supprime
    description: 'Gère les snapshots d\'une VM'
  },
  vm_verify: {
    requiresSudo: false,
    dangerous: false,
    description: 'Vérifie qu\'une VM est une copie fidèle du système hôte'
  },
  vm_destroy: {
    requiresSudo: true,   // undefine + suppression du stockage dans /var/lib/libvirt/images/
    dangerous: true,
    description: 'Supprime définitivement une VM (définition + stockage) : irréversible'
  },
  vm_clone: {
    requiresSudo: true,
    dangerous: false,
    description: 'Clone une VM existante'
  },
  vm_clone_system: {
    requiresSudo: true,
    dangerous: true,
    description: 'Clone le système hôte vers une VM (opération longue)'
  },
  vm_export: {
    requiresSudo: false,
    dangerous: false,
    description: 'Exporte une VM dans une archive portable avec sanitarisation (mode classic ou exam)'
  },
  vm_import: {
    requiresSudo: true,   // besoin root pour cp vers /var/lib/libvirt/images/
    dangerous: true,   // copie un disque dans libvirt + virsh define
    description: 'Importe une VM depuis une archive exportée par vm_export'
  },

  // VM Hub - cycle de vie, creation, console (libvirt direct, sans sudo)
  vm_pause: {
    requiresSudo: false,
    dangerous: false,
    description: 'Suspend une VM en marche (reprise avec vm_resume)'
  },
  vm_resume: {
    requiresSudo: false,
    dangerous: false,
    description: 'Reprend une VM en pause'
  },
  vm_reboot: {
    requiresSudo: false,
    dangerous: true,   // force = reset materiel : perte possible de donnees non ecrites
    description: 'Redémarre une VM (arrêt ACPI, ou reset matériel avec force)'
  },
  vm_create_from_image: {
    requiresSudo: false,
    dangerous: false,  // crée uniquement (refuse un nom pris) ; dry_run disponible
    description: 'Crée une VM depuis une image du catalogue (cloud, virt-builder ou ISO)'
  },
  vm_image_fetch: {
    requiresSudo: false,
    dangerous: false,  // seule sortie réseau : URL https fixes du catalogue interne
    description: 'Télécharge une image cloud du catalogue dans le dossier d\'images'
  },
  vm_console: {
    requiresSudo: false,
    dangerous: false,
    description: 'Donne l\'adresse de la console graphique d\'une VM (sans ouvrir de port)'
  },
  vm_console_log: {
    requiresSudo: false,
    dangerous: false,
    description: 'Lit les dernières lignes du journal du port série d\'une VM'
  },
  vm_hardware: {
    requiresSudo: false,
    dangerous: false,
    description: 'Lit le matériel déclaré d\'une VM (cpu, firmware, TPM, démarrage, affichage, réseau, disques, USB)'
  },
  vm_edit: {
    requiresSudo: false,
    dangerous: false,  // écrit la configuration ; n'arrête, ne supprime ni ne réduit rien (disque : agrandissement seul)
    description: 'Modifie une VM : vcpus, mémoire, cpu, firmware, TPM, secure boot, démarrage, USB, affichage, réseau, disque'
  },

  // Backup Manager - lecture
  backup_status: {
    requiresSudo: true,
    dangerous: false,
    description: 'Affiche le dashboard des backups'
  },
  backup_list: {
    requiresSudo: true,
    dangerous: false,
    description: 'Liste les backups disponibles'
  },
  backup_verify: {
    requiresSudo: true,
    dangerous: false,
    description: 'Vérifie l\'intégrité des backups'
  },

  // Backup Manager - modification
  backup_create: {
    requiresSudo: true,
    dangerous: false,
    description: 'Crée un nouveau backup'
  },

  // Backup Manager - dangereux
  backup_restore: {
    requiresSudo: true,
    dangerous: true,
    description: 'Restaure un backup (DESTRUCTIF)'
  },
  backup_clean: {
    requiresSudo: true,
    dangerous: true,
    description: 'Supprime des backups selon la rétention'
  },
};

// Configuration retry
export const RETRY_CONFIG = {
  // Opérations idempotentes avec retry
  retryable: ['vm_status', 'backup_status', 'backup_list', 'backup_verify'],
  maxRetries: 3,
  backoffMs: [1000, 2000, 5000],

  // Opérations sans retry (modifications)
  nonRetryable: ['vm_stop', 'vm_start', 'vm_snapshot', 'vm_reboot', 'vm_create_from_image', 'vm_edit', 'backup_restore', 'backup_clean', 'backup_create']
} as const;

// Codes d'erreur
export enum ErrorCode {
  SUCCESS = 'SUCCESS',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TIMEOUT = 'TIMEOUT',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  VM_NOT_FOUND = 'VM_NOT_FOUND',
  BACKUP_NOT_FOUND = 'BACKUP_NOT_FOUND',
  SCRIPT_ERROR = 'SCRIPT_ERROR',
  LOCK_CONFLICT = 'LOCK_CONFLICT',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

// Mapping exit codes scripts -> ErrorCode
export const EXIT_CODE_MAP: Record<number, ErrorCode> = {
  0: ErrorCode.SUCCESS,
  1: ErrorCode.SCRIPT_ERROR,
  2: ErrorCode.TIMEOUT,
  3: ErrorCode.LOCK_CONFLICT,
  4: ErrorCode.SCRIPT_ERROR, // Espace insuffisant
  5: ErrorCode.SCRIPT_ERROR, // Vérification échouée
  6: ErrorCode.SCRIPT_ERROR, // Annulé par utilisateur
};
