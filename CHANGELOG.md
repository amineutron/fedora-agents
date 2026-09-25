# Changelog - fedora-agents

## [1.3.0] - 2026-09-25

### Fixed
- **Audit log was never written to disk** for a regular user: the logger only tried `/var/log/mcp-agents` (not writable), so every entry went to stderr. It now resolves `MCP_AGENTS_LOG_DIR`, then `/var/log/mcp-agents`, then `$XDG_STATE_HOME/mcp-agents`; the directory is created 0700 and files 0600. The `/tmp` fallback is gone (an audit log of sudo actions must not be world-readable).
- Audit entries are written synchronously, so the last one survives an immediate exit (stdin closed, crash).
- `fedora-agents-mcp --help` / `--version` answer without starting the server or opening any log.

### Added
- Lint with Biome (`npm run lint`), run in CI; CI and npm badges in the README.
- Tests: log directory resolution, real audit write, CLI (27 tests).

## [1.2.2] - 2026-09-24

### Added

- **registry** : MCP registry manifest and package ownership marker

## [1.2.1] - 2026-09-24

### Changed
- First release published to npm by GitHub Actions (Trusted Publishing with provenance). The release workflow is self-contained: registries reject OIDC tokens minted inside reusable workflows. 1.2.0 was published by hand.

## [1.2.0] - 2026-09-24

### Changed
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are derived from `TOOL_PERMISSIONS`; a client reads the danger of a tool from the protocol instead of keeping its own list.
- `vm_exec` (arbitrary command), `vm_copy` (overwrites files), `vm_snapshot` (revert/delete) and `vm_import` (copies a disk into libvirt and defines the VM) are now declared dangerous; SECURITY.md table regenerated.
- `virsh`, `virt-clone` and `qemu-img` run without sudo through the `libvirt` group; the sudoers rules for them are gone.
- SSH: host keys of the VMs are verified (dedicated known_hosts, `accept-new`) instead of accepted blindly; the SSH user is chosen per VM (`VM_SSH_USERS`).
- zod 4 and TypeScript 7; every tool parameter is exposed in the JSON schema.

### Added
- README lists the host packages each tool needs.
- CI can be run manually (`workflow_dispatch`).

## [1.1.0] - 2026-09-10

See the GitHub release notes.
