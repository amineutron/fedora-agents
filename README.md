# fedora-agents MCP Server
<!-- mcp-name: io.github.amineutron/fedora-agents -->

[![CI](https://github.com/amineutron/fedora-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/amineutron/fedora-agents/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/fedora-agents-mcp.svg)](https://www.npmjs.com/package/fedora-agents-mcp) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](https://www.typescriptlang.org/)

**English summary.** MCP server that gives an AI agent hands on KVM/libvirt virtual machines and Borg/Timeshift backups on Fedora. Each tool declares whether it needs sudo and whether it is destructive; the client must confirm destructive calls. Arguments are validated with Zod before any script runs. Install with `npx fedora-agents-mcp` (`--help` lists the settings) or `npm ci && npm run build`. Security policy and tool table: [SECURITY.md](SECURITY.md).

Serveur MCP (Model Context Protocol) qui expose les agents VM-Controller et Backup-Manager
via le protocole MCP. Permet a Claude Code de gerer les VMs KVM et les backups directement.

## Pourquoi c'est conçu pour des agents LLM

Un script `virsh` suffit à un humain qui lit la sortie et réagit. Un agent LLM (grand
modèle de langage) qui pilote des machines a besoin d'autres garanties, et c'est ce que
ce serveur ajoute autour des scripts :

- **Chaque appel est traçable.** Un identifiant de corrélation est créé par appel d'outil
  et suit toutes les lignes du journal ; le journal d'audit JSON est écrit de façon
  synchrone, sur disque avant la réponse à l'agent (`src/logger.ts`).
- **Le réessai dépend de la nature de l'outil.** Seules les lectures idempotentes
  (`vm_status`, `backup_status`, `backup_list`, `backup_verify`) sont retentées, trois fois
  avec un délai croissant de 1, 2 puis 5 s ; une action qui modifie (démarrer, arrêter,
  restaurer, nettoyer) ne l'est jamais. Une erreur de validation ou de permission arrête
  tout de suite (`src/utils/executor.ts`).
- **Le code de sortie devient une erreur typée.** Les scripts renvoient un code (délai
  dépassé, verrou déjà pris, espace insuffisant...) que le serveur traduit en `ErrorCode`
  lisible par l'agent, au lieu d'un texte à interpréter (`EXIT_CODE_MAP`, `src/config.ts`).
- **Les droits root sont donnés script par script.** Aucune règle sudoers sur `virsh`,
  `virt-clone` ou `qemu-img` ; seuls les scripts système qui en ont besoin sont autorisés,
  un par un (voir [Emplacement des scripts et sudoers](#emplacement-des-scripts-et-sudoers)).
- **La progression des tâches longues est publiée.** Clone, export ou sauvegarde reportent
  leurs étapes à [mcp-tracking](https://github.com/amineutron/mcp-tracking)
  (`scripts/utils/tracking.sh`) : l'agent vérifie l'avancement plus tard au lieu de bloquer.
- **Le client sait ce qui est dangereux sans liste à maintenir.** Chaque outil publie ses
  annotations MCP (`readOnlyHint`, `destructiveHint`, `idempotentHint`) ; Lyra y lit la
  dangerosité et fait confirmer l'humain avant une action destructrice.

Local-first et self-hosted : tout tourne sur la machine (on-prem), sans service tiers,
avec un modèle local via Ollama dans [Lyra](https://github.com/amineutron/lyra) ou
n'importe quel client MCP.

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
      vm-hub.ts           -- regroupe les outils "hub" ci-dessous (pilotage libvirt direct, sans script) :
        vm-lifecycle.ts     vm_pause, vm_resume, vm_reboot
        vm-create.ts        vm_create_from_image
        vm-image-fetch.ts   vm_image_fetch
        vm-console.ts       vm_console, vm_console_log
        vm-hardware.ts      vm_hardware (lecture du materiel)
        vm-edit.ts          vm_edit (vcpus, memoire, cpu, firmware, TPM, secure boot, demarrage, USB, affichage, reseau, disque)
    utils/
      executor.ts     -- execution des scripts bash avec retry, timeout, gestion erreurs
      validation.ts   -- schemas Zod pour tous les parametres d'outils
      runner.ts       -- couture d'execution des outils hub (virsh, virt-xml, qemu-img, xorriso, virt-builder, curl) :
                         l'executeur reel en production, un faux dans les tests (setRunner)
      vm-hub-schemas.ts, vm-images.ts (catalogue interne d'images), vm-domain-xml.ts, cloud-init.ts,
      snapshot-current.ts, virsh.ts, vm-hardware-xml.ts (lecture du materiel dans le XML),
      vm-edit-plan.ts (plan de commandes de vm_edit) -- schemas et fonctions pures des outils hub
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
| `vm_snapshot` | `vm-controller/vm-snapshot.sh` | Gere les snapshots (create/list/restore/delete) ; `list` ajoute la ligne `Current: <nom>` (voir ci-dessous) |
| `vm_verify` | `kvm/verify-vm-clone.sh` | Verifie qu'un clone est fidele au systeme hote |
| `vm_clone` | `kvm/kvm-clone.sh` | Clone une VM existante (complet ou lie) |
| `vm_clone_system` | `kvm/kvm-clone-system.sh` | Clone le systeme hote entier vers une VM |

#### `vm_snapshot` action `list` : ligne du snapshot courant

Apres la liste, le serveur interroge `virsh snapshot-current --name <vm>` et insere, **juste avant la ligne `Total:`**, la ligne

```
Current: <nom-du-snapshot>
```

Aucune ligne si la VM n'a pas de snapshot courant. Le reste de la sortie est inchange : l'analyseur historique de lyra-control-api (`parse_snapshots`) ignore la ligne (le nom contient un `:` et un espace), un client qui la connait lit le snapshot courant avec `^Current: (\S+)$`. Un nom hors de `[A-Za-z0-9][A-Za-z0-9._:-]*` n'est pas ecrit (la sortie reste analysable).

### VM Hub (pause, redemarrage, creation depuis une image, console)

Ces outils ne passent pas par un script bash : ils pilotent libvirt directement (`virsh -c qemu:///system`, groupe `libvirt`, aucun sudo) et rendent un JSON `{"ok": true, ...}` ou `{"ok": false, "code": "...", "error": "..."}` (`isError` positionne sur un echec). Aucune commande n'est construite par interpolation : les arguments sont des tableaux, valides par schema Zod. Toutes les commandes passent par `src/utils/runner.ts`, ce qui permet de tester sans libvirt.

| Outil | Arguments | Effet |
|---|---|---|
| `vm_pause` | `vm_name` | `virsh suspend`. Refuse si la VM n'est pas en marche ; sans effet (`changed: false`) si elle est deja en pause |
| `vm_resume` | `vm_name` | `virsh resume`. Sans effet si elle est deja en marche ; refuse si elle est arretee |
| `vm_reboot` | `vm_name`, `force` (faux), `wait` (faux), `timeout` (90 s, 10 a 300) | Par defaut une demande ACPI (`virsh reboot --mode acpi`), reponse immediate. `force` : `virsh reset` (dangereux : perte possible de donnees). `wait` : `virsh shutdown --mode acpi`, attente de l'extinction (`timeout`), puis `virsh start` ; invite qui ignore l'ACPI : erreur `TIMEOUT`, relancer avec `force` |
| `vm_create_from_image` | `name`, `image_id`, `vcpus` (2), `memory_mib` (conseil du catalogue), `disk_gb` (conseil du catalogue), `network` (`default`), `ssh_key`, `hostname`, `user`, `start` (faux), `dry_run` (faux) | Cree et definit une VM depuis une image du catalogue (voir ci-dessous) |
| `vm_image_fetch` | `image_id` | Telecharge une image cloud du catalogue dans `VM_IMAGES_DIR` |
| `vm_console` | `vm_name`, `type` (`spice`, `vnc` ou `auto`) | Adresse de la console graphique d'une VM allumee : socket Unix (`transport: unix`) ou `127.0.0.1:port` (`transport: tcp`), avec `uri` ; `public: true` et un `warning` si l'ecoute n'est pas locale. N'ouvre aucun port et ne pont pas en websocket (a la charge de l'appelant) |
| `vm_console_log` | `vm_name`, `lines` (100, 1 a 2000) | Dernieres lignes du journal du port serie declare dans le XML de la VM (`<log file>` ou serie de type fichier), 512 Ko au plus, limite a `/var/log/libvirt`, `/var/lib/libvirt`, `VM_IMAGES_DIR` et `VM_CONSOLE_LOG_DIRS`. Echec : `reason` vaut `absent` (`VALIDATION_ERROR` : VM definie sans journal ou jamais demarree), `droits` ou `hors_racines` (`PERMISSION_DENIED`) |
| `vm_hardware` | `vm_name` | Lecture seule du materiel declare (`virsh dumpxml`, `dominfo`, `domblkinfo`) : `hardware.{cpu_model, firmware (bios/uefi), secure_boot, tpm, boot_order[], boot_order_source, display (spice/vnc/none), network, disks[{target, path, capacity_gb}], usb[vendor:product], vcpus, memory_mib, autostart, description}` |
| `vm_edit` | `vm_name` + au moins un champ : `vcpus` (1-32), `memory_mib` (512-65536), `autostart`, `description` (256 car., vide = effacer), `cpu_model` (`host-passthrough`, `host-model`, `x86-64-v2`, `qemu64`), `firmware` (`bios`, `uefi`), `tpm`, `secure_boot` (avec `firmware=uefi`), `boot_order` (`hd`, `cdrom`, `network`, sans doublon), `usb_attach` / `usb_detach` (`vendor:product`), `display` (`spice`, `vnc`), `network`, `disk_grow_gb` (1-2048 Gio, agrandissement seul, disque = volume d'un pool libvirt) | Voir ci-dessous. Reponse : `changes[]` (libelles), `applied[]` (champs), `skipped[]` (deja conforme), `needs_restart`, `hot[]` (appliques a chaud), `message` ; en echec : `failed[]`, `applied[]` de ce qui est deja fait |

`vm_edit` : **VM arretee obligatoire** pour `vcpus`, `memory_mib`, `cpu_model`, `firmware`, `tpm`, `secure_boot`, `disk_grow_gb` (refus `VALIDATION_ERROR` avant toute modification). Tout est valide d'abord (schema, disque reconnu comme volume d'un pool par `virsh vol-pool`), puis applique champ par champ dans un ordre fixe ; a la premiere erreur l'outil s'arrete et rend `applied`. Commandes : `virsh setvcpus --maximum --config` puis `--config` (les deux ordres sont essayes, libvirt refusant l'un ou l'autre selon le sens du changement), `virsh setmaxmem` / `setmem --config` (KiB), `virsh autostart [--disable]`, `virsh desc --config --new-desc` ; le reste par `virt-xml --connect qemu:///system` : `--edit --cpu <modele>`, `--edit --boot uefi` (secure boot : les anciens `<firmware>`, `<loader>` et `<nvram>` sont effaces puis `uefi,loader.secure=yes|no,firmware.feature0.name=secure-boot,firmware.feature0.enabled=yes|no` ; le fichier NVRAM existant est conserve, `virsh start --reset-nvram` si l'invite ne demarre plus), `--edit --boot firmware=bios` (+ suppression de `<loader>`, `<nvram>`, `<firmware>`) puis `--edit --features xpath1.delete=./smm` (le `<smm state='on'/>` pose par libvirt pour le secure boot empeche SeaBIOS : « Unable to find 'bios' firmware » ; le fichier NVRAM reste sur le disque), `--add-device --tpm default` / `--remove-device --tpm all`, `--edit --boot hd,cdrom,network` (les `<boot order>` par peripherique sont effaces d'abord), `--edit --graphics <type>` ou `--add-device --graphics <type>,listen=127.0.0.1`, `--edit --network network=<nom>`, USB : `--add-device --hostdev type=usb,source.startupPolicy=optional,xpath...` (par identifiant, sans que le peripherique soit branche ; `optional` : la VM demarre meme s'il est absent, sinon le demarrage echouerait tant qu'il n'est pas detache) / `--remove-device --hostdev <rang>`. `network`, `usb_attach`, `usb_detach` recoivent `--update` quand la VM tourne (effet immediat, `hot`). `disk_grow_gb` : par libvirt, car le volume appartient a libvirt et l'utilisateur n'a que le groupe (`qemu-img resize` direct : `Permission denied`) : `virsh vol-pool <chemin>` (refus `VALIDATION_ERROR` si le premier disque fichier n'est le volume d'aucun pool), capacite actuelle par `virsh domblkinfo`, puis `virsh vol-resize <chemin> <capacite + N Gio en octets> --pool <pool>` et `virsh pool-refresh <pool>` ; le systeme de fichiers de l'invite reste a agrandir.

`vm_create_from_image` selon le format de l'image (`fmt` du catalogue) :

- `cloud` (image prete qcow2/raw) : copie de l'image dans un volume du pool (`vol-create-as` puis `vol-upload`), agrandissement jusqu'a `disk_gb` (`vol-resize`), graine cloud-init (`user-data`/`meta-data` -> ISO `cidata` par `xorriso`) attachee en lecteur. `user` (defaut : compte de l'image : debian, fedora, ubuntu, arch, cirros) recoit `ssh_key` et sudo sans mot de passe. Sans `ssh_key`, la VM est creee mais inaccessible en ssh (avertissement).
- `vb` (virt-builder) : `virt-builder <modele> --format qcow2 --size <disk_gb>G --hostname ... --ssh-inject root:string:<cle>` (+ un compte `user` si demande), puis copie du disque dans le pool. `ssh_key` est obligatoire.
- `iso` : disque qcow2 vide de `disk_gb` Go, ISO copiee dans le pool (`<nom>-install.iso`), demarrage sur le lecteur ; `ssh_key`, `user` et `hostname` sont ignores (avertissement).

Refus avant toute ecriture : nom deja pris (VM ou volume), reseau libvirt inconnu, image absente de `VM_IMAGES_DIR`, image qcow2 avec fichier de base, disque plus petit que l'image. `dry_run` fait ces verifications (lectures seules) puis liste les etapes sans rien creer. En cas d'echec en cours de route, les volumes et la VM crees par l'appel sont supprimes (`rolled_back`). La VM est definie en q35/BIOS, virtio, ecran SPICE sur `127.0.0.1`, canal agent invite et port serie journalise dans `/var/log/libvirt/qemu/<nom>-serial0.log`.

**Catalogue d'images** (`src/utils/vm-images.ts`) : 25 identifiants fixes, identiques a `lib/vm_library.py` de lyra-control-api (`cirros`, `debian-cloud`, `fedora-cloud`, `ubuntu-cloud`, `arch-cloud`, `vb-debian`, `vb-fedora`, `alpine`, `debian-netinst`, `fedora-ws`, `kali`...). L'agent ne fournit jamais d'URL ni de chemin. Un fichier en cache se reconnait comme dans l'API : son nom avant le premier point vaut l'identifiant (`debian-cloud.qcow2`) ou commence par `<id>_` (`alpine_3.22.iso`) ; le tiret n'est pas un separateur. Seules cinq images cloud portent une URL https officielle (cirros 0.6.2, Debian 12 `latest`, Fedora 43, Ubuntu 24.04 `current`, Arch `latest`) ; pour toutes les autres, `vm_image_fetch` repond « image a placer a la main dans ~/vm-images ».

Prerequis des outils hub, en plus de `virsh` : `qemu-img` (lecture de l'image), `xorriso` (graine cloud-init), `virt-builder` (`guestfs-tools`, images `vb-*`), `curl` (`vm_image_fetch`). Reglages :

| Variable | Role | Defaut |
|---|---|---|
| `VM_IMAGES_DIR` | dossier des images (lecture), des fichiers de travail temporaires et des telechargements ; meme variable que l'API | `~/vm-images` |
| `VM_HUB_POOL` | pool libvirt qui recoit les disques de `vm_create_from_image` | `default` |
| `VM_CONSOLE_LOG_DIRS` | dossiers supplementaires (separes par `:`) ou `vm_console_log` peut lire | aucun |

Pour que `vm_console_log` lise le journal des VMs creees par l'outil, l'utilisateur doit pouvoir lire `/var/log/libvirt/qemu` (reserve a root par defaut) : une seule fois, a la main, par exemple `sudo setfacl -m u:$USER:rx /var/log/libvirt /var/log/libvirt/qemu && sudo setfacl -d -m u:$USER:r /var/log/libvirt/qemu`. Sans cela l'outil repond `PERMISSION_DENIED` (`reason: droits`) avec la liste des dossiers autorises ; `reason: absent` (`VALIDATION_ERROR`) signifie au contraire que le fichier n'existe pas : VM definie sans `<log file>` ou jamais demarree. Les VMs creees par `vm_create_from_image` declarent `<serial type='pty'><log file='/var/log/libvirt/qemu/<nom>-serial0.log' append='on'/>...` et la `<console type='pty'>` associee.

Prerequis supplementaire de `vm_edit` : `virt-xml` (paquet `virt-install`).

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
| `xorriso` | `xorriso` | `vm_create_from_image` (graine cloud-init des images cloud) |
| `virt-builder` | `guestfs-tools` (`libguestfs-tools`) | `vm_create_from_image` (images `vb-*`) |
| `curl` | `curl` | `vm_image_fetch` |
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
| [lyra](https://github.com/amineutron/lyra) | French-first voice assistant : assistant DevOps vocal, local par défaut (AGPL-3.0) ; le français familier est compris par des règles avant même d'appeler un modèle, ce qui lui suffit d'un modèle de 0.5B |
| [fedora-agents](https://github.com/amineutron/fedora-agents) | MCP : machines virtuelles KVM et sauvegardes |
| [mcp-tracking](https://github.com/amineutron/mcp-tracking) | MCP + API + tableau de bord des tâches longues |
| [neutroncore](https://github.com/amineutron/neutroncore) | hub PWA du homelab |
| [hue-mcp](https://github.com/amineutron/hue-mcp) | MCP Philips Hue (fork de ThomasRohde/hue-mcp) |
| [pylips-mcp](https://github.com/amineutron/pylips-mcp) | MCP TV Philips |
| [denon-mcp](https://github.com/amineutron/denon-mcp) | MCP ampli Denon |
| [catt-mcp](https://github.com/amineutron/catt-mcp) | MCP Chromecast et DLNA |
