# Morrow — isolated Polaris Dados pilot

This branch is an experimental candidate integrating upstream Morrow v2.2.0 at
068bbdb846bc2806bcf8e43349dcb82fcbc42757. The published fork is preserved
on main at 778c6b6ef7d30aad8678dbbbcb50fdcab6bc1106 (base 1.3 / fork 1.2).
This candidate is NOT a complete migration or replacement for that fork.
Preserve Apache-2.0 attribution and public history; never publish private source history.

## Canonical instructions and scope

Read /media/sf_MeuDrive/Polaris/Central Polaris/AGENTS.md and Início.md,
then Projetos/Polaris/Agentes/Polaris/BOOTSTRAP.md and Projetos/Morrow/index.md.
Scope: Projetos/Morrow/Escopos/Escopo 003 — Morrow 2.0 e plugins Polaris.md.
Canonical pilot spec: Projetos/Morrow/Planejamento/Especificações/E003 — Plugin Polaris Dados — Especificação.md.
Policies in Projetos/Polaris/Agentes/Políticas: Orquestração e subagentes.md,
Estrutura e documentação de projetos.md, Ambientes de desenvolvimento e encerramento de escopos.md,
Commits e releases.md; scope template in Projetos/Polaris/Agentes/Templates/Template de escopo.md.
GitHub Issues https://github.com/hodeliun/Morrow/issues is the canonical tracker.
On 2026-11-20 Carlos authorized specification, tickets and implementation of full
published-fork feature parity on Tauri, using four plugins plus necessary host changes.
Canonical full-parity spec: https://github.com/hodeliun/Morrow/issues/191.
Preserve the P1 evidence and stable main/release; do not force-push, retag, merge
main, replace personal apps or deploy a stable release before human acceptance.
Upstream 2.2 reconciliation and platform verification are tracked in issue195 and
issue224. This staging candidate includes the upstream 2.2.0 parent; it does not
replace the stable fork or establish Windows runtime or human acceptance. G16 begins
with issue192.

## Implementation and verification

Use existing commands/session/save queue. No raw filesystem writes from plugin,
DOM scraping, private host imports, eval, formula network/shell/filesystem effects,
or a second canonical database inside plugin settings. A provider must be opt-in,
exclusive, removable, and fail safely with readable fallback when absent.
Guard loss of representability BEFORE normalizing fork data; schema numbers alone
are insufficient. Preserve unknown Markdown/YAML and protect unsupported edits.
executeAll is atomic in memory, not automatically atomic over multiple files.
Run meaningful behavior tests, typecheck/lint/build; npm run check is integration gate.
Each ticket gets its own executor; independent reviewer/validator are required.
Preserve others' WIP. Assigned agents execute only their mission without restarting orchestration.

## Personal-data and runtime boundary

Only synthetic vaults and isolated profiles. Never launch/restart/replace personal
apps, profiles, vaults, clipboard or visible windows. Test-native runtime must use
proven isolated profile and hidden/headless display. MORROW_USER_DATA is debug-only
in upstream Tauri; release ignores it. Verify profile, instance identity and paths
before any launch; do not assume an env var alone proves isolation.

## Public commit identity

For new public commits use the verified GitHub noreply identity:
`hodeliun <280457170+hodeliun@users.noreply.github.com>`.
Do not publish the host's default personal email or rewrite existing commits.
Use per-command Git config rather than altering the user's global preferences.
