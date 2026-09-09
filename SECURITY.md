# Politique de sécurité / Security policy

**FR.** fedora-agents donne à un agent IA des mains sur des machines virtuelles KVM et des sauvegardes Borg/Timeshift. Chaque outil est déclaré dans `src/config.ts` (`TOOL_PERMISSIONS`) avec deux drapeaux : `requiresSudo` (le script est lancé via `sudo`, autorisé script par script dans `sudoers.d`, jamais en `sudo` global) et `dangerous` (l'outil est annoncé comme destructif au client MCP, qui doit demander une confirmation humaine ; Lyra ne l'exécute jamais sans elle). Le serveur refuse de démarrer si un outil exposé n'a pas d'entrée dans cette table. Pour signaler une faille : onglet *Security* du dépôt (private vulnerability reporting) ou amine.neutroncore@gmail.com, objet `[security]`.

**EN.** fedora-agents gives an AI agent hands on KVM virtual machines and Borg/Timeshift backups. Every tool is declared in `src/config.ts` with `requiresSudo` (per-script sudoers entry, never a blanket sudo) and `dangerous` (announced to the MCP client as destructive; a human confirmation is expected). The server refuses to start if an exposed tool has no permission entry. Report vulnerabilities through the repository's Security tab or amine.neutroncore@gmail.com with `[security]` in the subject.

## Les outils et ce qu'ils peuvent faire

Tableau généré depuis `src/config.ts` (`npm run security:table`, vérifié en CI).

<!-- table:start -->
| Outil | sudo | Dangereux | Rôle |
|---|---|---|---|
| `vm_status` | non | non | Affiche le status d'une VM |
| `vm_start` | non | non | Démarre une VM |
| `vm_stop` | non | **oui** | Arrête une VM (peut causer perte de données non sauvegardées) |
| `vm_exec` | non | non | Exécute une commande dans une VM |
| `vm_copy` | non | non | Copie des fichiers vers/depuis une VM |
| `vm_snapshot` | non | non | Gère les snapshots d'une VM |
| `vm_verify` | non | non | Vérifie qu'une VM est une copie fidèle du système hôte |
| `vm_destroy` | oui | **oui** | Supprime définitivement une VM (définition + stockage) : irréversible |
| `vm_clone` | oui | non | Clone une VM existante |
| `vm_clone_system` | oui | **oui** | Clone le système hôte vers une VM (opération longue) |
| `vm_export` | non | non | Exporte une VM dans une archive portable avec sanitarisation (mode classic ou exam) |
| `vm_import` | oui | non | Importe une VM depuis une archive exportée par vm_export |
| `backup_status` | oui | non | Affiche le dashboard des backups |
| `backup_list` | oui | non | Liste les backups disponibles |
| `backup_verify` | oui | non | Vérifie l'intégrité des backups |
| `backup_create` | oui | non | Crée un nouveau backup |
| `backup_restore` | oui | **oui** | Restaure un backup (DESTRUCTIF) |
| `backup_clean` | oui | **oui** | Supprime des backups selon la rétention |
<!-- table:end -->

## Ce que le serveur ne fait pas

- Aucune commande shell construite à partir du texte de l'agent : les arguments sont validés par schéma (Zod) puis passés au script comme arguments séparés, jamais interpolés.
- Aucune écriture hors des chemins configurés (`PATHS` dans `src/config.ts`).
- Aucune sortie réseau : le serveur parle en stdio avec son client et lance des scripts locaux.

## Modèle de menace, en bref

| Menace | Mitigation |
|---|---|
| L'agent demande la destruction d'une VM | `vm_destroy` est `dangerous` : confirmation humaine côté client ; audit JSON de chaque appel |
| Injection dans un nom de VM ou un chemin | validation Zod (motifs stricts) avant tout appel de script |
| Élévation de privilèges | sudoers par script sur une copie root des scripts, `NOPASSWD` limité à ces chemins |
| Restauration d'une mauvaise sauvegarde | `backup_restore` est `dangerous` ; identifiant validé par expression régulière |

## Versions prises en charge

Seule la dernière release reçoit des correctifs.
