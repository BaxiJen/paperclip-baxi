# BaXiJen UI and local Kiro adapter

Base: Paperclip v2026.916.1, commit d554c4789ed3930f8a53ac9fdf6503b3187097da.

## UI intent
Keep the operational dashboard, navigation, density, and semantic status colors.
Apply the BXat Buriti identity: warm cream canvas, green actions, Geist typography,
and the existing BaXiJen BX monogram. Green indicates actions and selection; it does
not replace error or warning semantics. Keep a warm dark theme as an explicit choice.
Use existing spacing, type scale, borders, radii, focus states, and motion tokens.
The light theme is the default. Existing saved theme choices remain valid.
Keep Paperclip attribution visible and preserve the upstream MIT license.

## Adapter architecture
Build an external package in packages/adapters/kiro-local. The host loads its factory
through the existing adapter manager, without a registry patch or database migration.
Use Kiro headless JSONL, stdin prompts, explicit trusted tools, bounded execution,
and defensive terminal-event parsing. A zero exit status alone is not success.
Bind resumed sessions to company, agent, task, workspace, and configuration.
Never log credentials or claim unknown usage or costs as zero.
Authentication and live provider validation are separate operator steps.

## Validation
Run protocol and process tests, package build/import, UI token gates, repository
checks, and visual checks in light/dark and mobile layouts. Scan all upstream history
and all additions before the first branch push. Keep operational notes outside Git.

## Sources checked on 2026-09-29
- https://docs.paperclip.ing/reference/adapters/external-adapters/
- https://docs.paperclip.ing/reference/adapters/creating-an-adapter/
- https://github.com/paperclipai/paperclip/tree/v2026.916.1
- https://kiro.dev/docs/cli/headless/
- https://github.com/kirodotdev/Kiro/issues/11069

The installed-release code is the compatibility target. Live documentation can describe
newer code. Kiro's terminal event fixtures come from reported CLI output in issue 11069;
this is protocol evidence, not a substitute for an authenticated end-to-end test.
