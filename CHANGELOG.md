# Changelog - fedora-agents

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
