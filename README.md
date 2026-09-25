# fedora-agents MCP Server
<!-- mcp-name: io.github.amineutron/fedora-agents -->

[![CI](https://github.com/amineutron/fedora-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/amineutron/fedora-agents/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/fedora-agents-mcp.svg)](https://www.npmjs.com/package/fedora-agents-mcp) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](https://www.typescriptlang.org/)

**English summary.** MCP server that gives an AI agent hands on KVM/libvirt virtual machines and Borg/Timeshift backups on Fedora. Each tool declares whether it needs sudo and whether it is destructive; the client must confirm destructive calls. Arguments are validated with Zod before any script runs. Install with `npx fedora-agents-mcp` (`--help` lists the settings) or `npm ci && npm run build`. Security policy and tool table: [SECURITY.md](SECURITY.md).

Serveur MCP (Model Context Protocol) qui expose les agents VM-Controller et Backup-Manager
via le protocole MCP. Permet a Claude Code de gerer les VMs KVM et les backups directement.

## Demo

![Client MCP : liste des 19 outils, aide, puis etat des VMs KVM](docs/assets/demo.gif)

Enregistree sur la machine reelle avec [`docs/demo/record.sh`](docs/demo/record.sh) : un client MCP minimal ([`docs/demo/mcp_demo.py`](docs/demo/mcp_demo.py)) demarre le serveur en stdio, liste les outils, appelle `help` puis `vm_status` (lecture seule). Les adresses IP sont remplacees par des adresses d'exemple.

## Architecture

```
fedora-agents/
  scripts/                -- scripts bash embarques (autonomes, plus de dependance a fedora-setup)
    agents/vm-controller/   vm-start, vm-stop, vm-status, vm-exec, vm-copy, vm-snapshot,
                            vm-destroy, vm-export, vm-import (+ common.sh)
    agents/backup-manager/  backup-create, backup-list, backup-restore, backup-verify,
                            backup-clean, backup-status (+ common.sh)
    kvm/                    kvm-clone, kvm-clone-system, kvm-snapshot, verify-vm-clone
                            (+ helpers fix-nm-connection-vm, _fix-grub-vm)
    backup/                 borg-backup, test-restore, get-borg-passphrase
    utils/tracking.sh       reporting optionnel vers MCP Tracking (127.0.0.1:8765)
    config.env.example      surcharges locales (KVM_IMAGES_DIR, VM_SSH_USER...)
  src/
    index.ts          -- point d'entree, enregistrement des outils MCP
    config.ts         -- timeouts, permissions, codes d'erreur
    logger.ts         -- logging JSON structure
    tools/
      vm-controller.ts    -- outils vm_start, vm_stop, vm_status, vm_exec, vm_copy,
                             vm_snapshot, vm_verify, vm_clone, vm_clone_system, vm_destroy
      backup-manager.ts   -- outils backup_create, backup_list, backup_restore,
                             backup_verify, backup_clean, backup_status
      vm-portability.ts   -- outils vm_export, vm_import
    utils/
      executor.ts     -- execution des scripts bash avec retry, timeout, gestion erreurs
      validation.ts   -- schemas Zod pour tous les parametres d'outils
```

## Outils MCP exposes

### help
Liste tous les outils disponibles avec leurs descriptions.
- Script sous-jacent: aucun (genere directement dans index.ts)

### VM Controller

| Outil | Script sous-jacent | Description |
|-------|-------------------|-------------|
| `vm_start` | `vm-controller/vm-start.sh` | Demarre une VM, attend optionnellement SSH |
| `vm_stop` | `vm-controller/vm-stop.sh` | Arrete une VM (proprement ou force) |
| `vm_destroy` | `vm-controller/vm-destroy.sh` | Supprime definition + stockage d'une VM |
| `vm_status` | `vm-controller/vm-status.sh` | Affiche l'etat d'une VM (ou liste toutes) |
| `vm_exec` | `vm-controller/vm-exec.sh` | Execute une commande dans une VM via SSH |
| `vm_copy` | `vm-controller/vm-copy.sh` | Copie des fichiers hote <-> VM via SCP |
| `vm_snapshot` | `vm-controller/vm-snapshot.sh` | Gere les snapshots (create/list/restore/delete) |
| `vm_verify` | `kvm/verify-vm-clone.sh` | Verifie qu'un clone est fidele au systeme hote |
| `vm_clone` | `kvm/kvm-clone.sh` | Clone une VM existante (complet ou lie) |
| `vm_clone_system` | `kvm/kvm-clone-system.sh` | Clone le systeme hote entier vers une VM |

### Backup Manager

| Outil | Script sous-jacent | Description |
|-------|-------------------|-------------|
| `backup_status` | `backup-manager/backup-status.sh` | Dashboard global des backups |
| `backup_list` | `backup-manager/backup-list.sh` | Liste les backups disponibles |
| `backup_create` | `backup-manager/backup-create.sh` | Cree un backup (timeshift/borg/vm-snapshot/manual) |
| `backup_verify` | `backup-manager/backup-verify.sh` | Verifie l'integrite des backups |
| `backup_restore` | `backup-manager/backup-restore.sh` | Restaure un backup (destructif) |
| `backup_clean` | `backup-manager/backup-clean.sh` | Applique les politiques de retention |

### VM Portabilite

| Outil | Script sous-jacent | Description |
|-------|-------------------|-------------|
| `vm_export` | `vm-controller/vm-export.sh` | Exporte une VM en archive .tar.gz sanitarisee |
| `vm_import` | `vm-controller/vm-import.sh` | Importe une VM depuis une archive vm_export |

## Scripts helpers non exposes

Ces scripts sont utilises en interne mais pas directement accessibles via MCP:

| Script | Role |
|--------|------|
| `agents/vm-controller/common.sh` | Fonctions communes (virsh, SSH, logging) |
| `agents/backup-manager/common.sh` | Fonctions communes (borg, locks, notifications) |
| `kvm/kvm-snapshot.sh` | Moteur de snapshots appele par vm-snapshot.sh |
| `kvm/fix-nm-connection-vm.sh`, `kvm/_fix-grub-vm.sh` | Corrections post-clone (NetworkManager, grub BLS) |
| `backup/borg-backup.sh`, `backup/get-borg-passphrase.sh` | Sauvegarde Borg ; passphrase via systemd-creds ou Bitwarden, jamais en clair |
| `backup/test-restore.sh` | Test de restauration utilise par backup-verify --deep |

## Emplacement des scripts et sudoers

`src/config.ts` resout la racine des scripts dans cet ordre :

1. `LYRA_SCRIPTS_DIR` (variable d'environnement)
2. `/usr/local/lib/lyra/scripts` : copie `root:root 0755` installee par l'installeur Lyra
3. `scripts/` du depot (mode developpement)

Les outils sans `sudo` (`vm_status`, `vm_start`, `vm_stop`, `vm_exec`, `vm_copy`, `vm_snapshot`,
`vm_export`, `vm_verify`) pilotent libvirt directement : l'utilisateur doit etre membre du groupe
`libvirt`, que polkit autorise sur `qemu:///system` :

```bash
sudo usermod -aG libvirt "$USER"   # puis se reconnecter
virsh -c qemu:///system list --all # doit repondre sans sudo
```

Aucune regle sudoers ne vise `virsh`, `virt-clone` ou `qemu-img` : un `NOPASSWD` sur ces binaires
equivaut a root (un domaine peut monter le disque de l'hote). Les outils qui demandent root
(`vm_destroy`, `vm_clone`, `vm_clone_system`, `vm_import` et les `backup_*`) lancent leur script
entier via `sudo`. Ces regles visent **uniquement** la copie systeme, script par script, jamais un
glob sur un dossier inscriptible par l'utilisateur (sinon n'importe quel processus de son uid obtient
root en y deposant un `.sh`) :

```
user ALL=(ALL) NOPASSWD: /usr/local/lib/lyra/scripts/kvm/kvm-clone.sh
user ALL=(ALL) NOPASSWD: /usr/local/lib/lyra/scripts/kvm/kvm-clone-system.sh
...
```

L'installeur Lyra genere ce fichier (`/etc/sudoers.d/lyra`) et le valide avec
`visudo -cf` avant de l'activer. Installation manuelle :

```bash
sudo install -d -o root -g root -m 0755 /usr/local/lib/lyra/scripts
sudo cp -r scripts/. /usr/local/lib/lyra/scripts/
sudo chown -R root:root /usr/local/lib/lyra/scripts
sudo find /usr/local/lib/lyra/scripts -type f -name '*.sh' -exec chmod 0755 {} +
```

## Configuration

| Variable | Rôle | Défaut |
|---|---|---|
| `SCRIPTS_DIR` | dossier des scripts (agents/, kvm/) : copie root pour la production, `scripts/` du dépôt pour les tests | copie root installée par Lyra, sinon `scripts/` |
| `MCP_AGENTS_LOG_DIR` | journaux JSON (serveur, erreurs, audit des appels sous sudo ou destructifs) | `/var/log/mcp-agents` s'il est inscriptible, sinon `$XDG_STATE_HOME/mcp-agents` (`~/.local/state/mcp-agents`) ; fichiers en 0600, jamais dans `/tmp` |
| `scripts/config.env` | chemins KVM, Borg, Timeshift (voir `config.env.example`) | valeurs d'exemple |
| `VM_SSH_USER`, `VM_SSH_USERS` | compte SSH des VMs : par defaut, puis par VM (`"fedora-base=fedora ubuntu-base=ubuntu"`), dans `config.env` ou `~/.config/vm-controller/config` | utilisateur courant |

Le serveur est un composant de Lyra mais fonctionne seul : `SCRIPTS_DIR=./scripts node dist/index.js` démarre sans sudoers (les outils marqués `requiresSudo` échoueront alors proprement).


- Timeouts: `src/config.ts` (TIMEOUTS)
- Permissions sudo: `src/config.ts` (TOOL_PERMISSIONS)
- Retry: `src/config.ts` (RETRY_CONFIG)
- Config locale: `scripts/config.env` (copier depuis `scripts/config.env.example`)

## Logs

Les logs JSON structures sont ecrits dans:
1. `/var/log/mcp-agents/` (si accessible en ecriture)
2. `~/.local/state/mcp-agents/` (fallback utilisateur)
3. `/tmp/mcp-agents-logs/` (fallback final)

## Installation en une ligne

```bash
npx fedora-agents-mcp            # depuis npm ; `npx fedora-agents-mcp --help` pour les reglages
                                 # depuis un clone : npm ci && npm run build && node dist/index.js
```

Configuration Claude Desktop / Claude Code (`mcpServers`) :

```json
{ "fedora-agents": { "command": "npx", "args": ["-y", "fedora-agents-mcp"] } }
```

Politique de securite et tableau des outils : [SECURITY.md](SECURITY.md).

## Installation et demarrage

Paquets a installer sur l'hote (noms Fedora ; Debian/Ubuntu entre parentheses quand ils different) :

| Commande | Paquet | Outils concernes |
|---|---|---|
| `virsh` | `libvirt-client` (`libvirt-clients`) | tous les `vm_*` |
| `virt-clone` | `virt-install` (`virtinst`) | `vm_clone` |
| `virt-install` | `virt-install` (`virtinst`) | `vm_clone_system` |
| `qemu-img` | `qemu-img` (`qemu-utils`) | `vm_status`, `vm_clone`, `vm_clone_system`, `vm_import`, `vm_export`, `vm_destroy` |
| `guestfish` | `guestfs-tools` (`libguestfs-tools`) | `vm_clone` (reseau et GRUB du clone) |
| `ssh`, `scp` | `openssh-clients` (`openssh-client`) | `vm_exec`, `vm_copy`, `vm_clone` (nom d'hote du clone) |
| `borg` | `borgbackup` | `backup_*`, `vm_export` |
| `timeshift` | `timeshift` | `backup_*`, `vm_clone_system` |
| `rsync` | `rsync` | `backup_create`, `backup_list`, `backup_restore`, `vm_clone_system` |
| `nmap` (optionnel) | `nmap` | `vm_verify`, `vm_clone` (recherche d'IP sans agent invite) |
| Node.js >= 18 | `nodejs` | le serveur MCP |

Les cles d'hote SSH des VMs sont conservees dans `$XDG_STATE_HOME/fedora-agents/known_hosts` (a defaut `~/.local/state/fedora-agents/known_hosts`) : premier contact accepte, cle modifiee refusee.

```bash
npm install
npm run build

# Test local (scripts/ du depot, sans sudoers)
node dist/index.js
```

La configuration MCP pour Claude Code ou Claude Desktop est decrite dans la section
[Installation en une ligne](#installation-en-une-ligne).

## Part of the Lyra ecosystem

| Dépôt | Rôle |
|---|---|
| [lyra](https://github.com/amineutron/lyra) | assistant DevOps vocal, local par défaut (AGPL-3.0) |
| [fedora-agents](https://github.com/amineutron/fedora-agents) | MCP : machines virtuelles KVM et sauvegardes |
| [mcp-tracking](https://github.com/amineutron/mcp-tracking) | MCP + API + tableau de bord des tâches longues |
| [neutroncore](https://github.com/amineutron/neutroncore) | hub PWA du homelab |
| [hue-mcp](https://github.com/amineutron/hue-mcp) | MCP Philips Hue (fork de ThomasRohde/hue-mcp) |
| [pylips-mcp](https://github.com/amineutron/pylips-mcp) | MCP TV Philips |
| [denon-mcp](https://github.com/amineutron/denon-mcp) | MCP ampli Denon |
| [catt-mcp](https://github.com/amineutron/catt-mcp) | MCP Chromecast et DLNA |
