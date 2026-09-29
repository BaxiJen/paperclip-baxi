# Kiro local adapter

Own integration by BaXiJen. External adapter type `kiro_local`, package
`@baxijen/paperclip-adapter-kiro`. Compatible with the Paperclip adapter API at
v2026.916.1. It does not change the database, built-in adapter registry, or auth flow.

## Status

Validated on Linux through the Paperclip heartbeat API with Kiro CLI 2.25.0 and
Builder ID authentication. A read-only agent read a fixture file and returned its
actual contents with a valid completion and recorded session. The package also has
22 subprocess and protocol tests. Revalidate authentication and permissions for
each deployment. The version guard accepts Kiro CLI
2.24+ within 2.x. Version 3.x must be qualified before extending the guard.

A task-scoped live run also retained its session id, but repeated a previous
answer after the fixture changed. Session identity is verified; fresh file reads
on resume are not. Do not treat a successful completion as proof of a tool action.
Use a fresh session and verify artifacts when validating changed workspace state.

## Setup

1. Install the official Kiro CLI under the same unprivileged OS account as Paperclip.
   Pin a version and verify the SHA-256 from its official release manifest.
2. The operator completes Kiro authentication in their own interactive terminal.
   Do not put login URLs, device codes, or credentials in run logs.
3. Create a named Kiro agent with a reviewed model, tools, permissions, hooks, and MCP
   configuration. Select it with `kiroAgent`. The model belongs to the Kiro agent;
   the adapter does not invent a `--model` flag or rewrite shared settings.
4. Build and load this package through Paperclip's external adapter manager.
   Create the archive with `pnpm pack` from the package directory and install that
   archive into a separate local directory for the package smoke test. The release API uses `POST /api/adapters/install` with `packageName` and
   `isLocalPath: true` for an absolute path to the built package directory.
   This operation requires instance-admin access. Building does not install it.
5. Run the environment check, then a small operator-approved task. Confirm actual
   file changes and command results independently before enabling unattended runs.

Build from the monorepo root with `pnpm --filter @baxijen/paperclip-adapter-kiro build`.
The external loader imports `dist/index.js`. The build bundles the pinned workspace
helpers. The npm adapter-utils 0.3.1 package does not contain the helpers present in
this Paperclip release, despite the matching version. Runtime resolution to that npm
package would fail. The distributable therefore has no runtime npm dependencies.
Type-check the TypeScript source in this workspace; this first package does not ship
a public declaration API.
Run `pnpm test`, `pnpm typecheck`, and `pnpm test:bundle` from the adapter directory.
The bundle smoke test copies the built file to a fresh temporary directory and runs
it there, with no workspace dependencies or provider account.
No npm package has been published as part of this change.

Example adapter configuration (use an actual reviewed Kiro agent name):

```json
{
  "kiroAgent": "baxijen-review",
  "engine": "v2",
  "trustedTools": "read,grep",
  "timeoutSec": 1800,
  "graceSec": 5
}
```

The assigned Paperclip workspace supplies the working directory. `cwd` is only a
fallback. `command` defaults to `kiro-cli`. Set `requireMcpStartup: true` when a task
requires the named agent's MCP servers. This adapter does not install or configure MCP
servers. Run-scoped Paperclip tool access is provided through the environment.

Use Paperclip `secret_ref` for `env.KIRO_API_KEY` when required; never store a literal
key in adapter configuration. The host must resolve that reference before execution.
Existing Kiro login sessions can take precedence over an API key. The current headless
guide asks for an API key, while the authentication guide describes session precedence;
verify the intended account and authentication mode with the selected CLI release.

On Linux, the default Kiro credential database is under
`~/.local/share/kiro-cli/data.sqlite3` (subject to `XDG_DATA_HOME`). `KIRO_HOME` changes
configuration/session storage; it must not be assumed to move credential storage.
This adapter never reads, copies, or modifies that credential database.

## Execution contract

- Prompts travel over stdin with the workspace, task context, instructions, and
  assigned Paperclip skills. They are not command-line arguments or logged metadata.
- Uses `chat --agent-engine v2|v3 --no-interactive --output-format stream-json`.
- Trust is explicit. The default is `read,grep`; `--trust-all-tools` is never enabled.
  CLI trust flags can add to the named agent's existing permissions. They are not
  a denial policy or an OS sandbox. Review that agent's tools and hooks separately.
  A read-only agent cannot update Paperclip by shell; grant the specific tools it
  needs only after reviewing the workload and host containment.
- The host-issued agent JWT is required. Configuration cannot override `PAPERCLIP_*`.
  Only an allowlist of ambient OS/provider variables reaches the subprocess.
- Stored operator environment names are validated separately from the controller's
  enriched execution environment. Unrelated projected variables, GitHub credentials,
  and process injection variables are not forwarded. Temporary directories come
  from the controller-owned scratch context; run identity comes from the host JWT.
- Provider stdout/stderr are captured with a 4 MiB total limit, not streamed into logs.
  Fixed status messages are logged. Known credential values are redacted from the
  returned final summary. Kiro itself may persist local session data; OS isolation,
  file permissions, tool policy, and secret handling still apply.
- A successful process exit AND one valid `runFinished` record are required.
  `runError`, malformed completion, timeout, cancellation, and incomplete output fail.
- Resumed sessions are bound to company, agent, task, real workspace path, profile,
  and adapter settings. A different returned session id fails the run without retry.
  The host must preserve the full task session parameters. Unscoped manual wakes
  without those parameters start a new session, even if a previous id is available.
  Reset the Paperclip runtime session after changing a named Kiro agent's model,
  hooks, tools, credentials/account, or instruction contents in place.
- Output is untrusted text. It is never evaluated as code by the adapter.
- Unknown usage and cost are omitted; they are not represented as free usage.
- Remote execution and automatic OAuth flows are unsupported.

## Authentication and version evidence

- [Official headless documentation](https://kiro.dev/docs/cli/headless/)
- [Official authentication documentation](https://kiro.dev/docs/getting-started/authentication/)
- [CLI session bug and reported 2.24.0 fix](https://github.com/kirodotdev/Kiro/issues/11069)
- [Paperclip external adapter API](https://docs.paperclip.ing/reference/adapters/external-adapters/)

The terminal fixtures use actual `runFinished` and `runError` shapes reported in that
Kiro issue. Other records are ignored. This adapter does not claim support for tool
transcripts, token accounting, quota discovery, model discovery, or ACP yet.
