# Maintaining the BaXiJen fork

## Branches and licensing

- `upstream` points to `paperclipai/paperclip`.
- `main` starts at release v2026.916.1 (d554c4789ed3930f8a53ac9fdf6503b3187097da).
- All custom work uses feature branches and pull requests within this fork.
- Keep branding changes in UI tokens/components and adapters in separate packages.
- Preserve the upstream MIT license and copyright. Geist carries its own OFL notice.
- The original upstream README follows the fork introduction.
- Review upstream changes in a branch before advancing the production baseline.

## Before replacing an npm installation

A build from a fork can apply database migrations. Do not treat it as a UI-only
replacement even when the patch has no database changes.

1. Record the installed release, commit, runtime versions, executable target, and
   migration journal without printing credentials or environment values.
2. During a maintenance window, quiesce writes and make a consistent database backup.
   Back up configuration, encrypted secret material, encryption keys, and file storage
   as one recovery set. Protect the backup and verify a restore in an isolated instance.
3. Build the exact reviewed commit. Compare migrations with the installed release.
   Reject unexpected migrations. Run tests and a smoke test against a restored copy.
4. Prepare a versioned release directory and a service configuration pointing to it.
   Preserve the existing service account, bind address, network containment, runtime,
   data paths, and resource limits. Confirm the rollback commands before switching.
5. Obtain deployment approval. Then stop the service, switch the executable target,
   start it, and verify health, authentication, workspaces, adapters, and backups.
6. If no migration or incompatible writes occurred, rollback can restore the prior
   executable. If schema/data changed, stop the service and restore the complete
   recovery set before using the previous executable. That can discard new writes;
   obtain explicit approval for the restore.

No service switch, VPS installation, authentication, firewall change, or database
migration is part of this local development phase. Private operational addresses,
identities, credentials, backups, and runbooks must stay outside this public repository.
