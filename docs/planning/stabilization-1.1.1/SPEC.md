# Stabilization and illustrated release 1.1.1

## Problem Statement

An audit against the original twenty requirements found twelve working and eight partially delivered. Individual feature tickets being closed did not establish that the original workflows worked together. Inverse creation fails, a row insert/undo scenario fails verification, menus can obscure the icon picker, uploaded column icons expand beyond their intended size, and table presentation does not fully match the requested interactions. Fork 1.1.0 also has not been published as a downloadable release.

## Solution

Stabilize the actual workflows in three coherent functional deliveries, repeat the original twenty-item acceptance audit, and publish Windows x64 installer and portable artifacts. Adopt an illustrated release policy that separates official-base changes from fork changes and explains the actual additions since the last downloadable release, 1.0.1. Preserve the user's installation and all original personal data.

## User Stories

1. As a table user, I want to create a reciprocal relation directly, so that I do not have to pre-create both columns.
2. As a table user, I want existing reciprocal relations to retain their values, so that corrections do not lose data.
3. As a table user, I want insertion before and after a row to work after undo, so that a quick sequence of operations is reliable.
4. As a table user, I want duplicate, copy, move, trash and recovery to preserve the correct rows after reopening.
5. As an editor user, I want the icon dialog to appear above the originating settings panel, so that I can use it with the mouse.
6. As a keyboard user, I want Escape and focus restoration to act on the topmost menu or dialog.
7. As an editor user, I want uploaded icons to fit their header and settings slots regardless of image dimensions.
8. As an editor user, I want collapsing a linked table to preserve document selection without application errors.
9. As a table user, I want a hidden title to stop displaying the source name while retaining a discreet way to restore it.
10. As a table user, I want the row grip to support selection and a context menu as well as dragging.
11. As a table user, I want a compact toolbar with discoverable settings and active filter/sort indicators.
12. As a page author, I want canonical inline tables and linked views of the same table to share the same visual style.
13. As a page author, I want each view's name and configuration to remain independent.
14. As a table user, I want footer calculations aligned with their columns by default and after resizing, scrolling or freezing.
15. As a user, I want all twenty original requirements checked in the actual final app rather than inferred from ticket status.
16. As a downloader, I want separate base and fork versions with clear notes about which changes came from each.
17. As a downloader, I want examples and real screenshots or short demonstrations of new features.
18. As a downloader, I want verified Windows artifacts and checksums, with honest descriptions of testing and limitations.
19. As the maintainer, I want functional grouped commits and repeatable release guidance without replacing my current installation.

## Implementation Decisions

- Keep the current official base 1.2.1 and its recorded commit. This is stabilization, not another upstream synchronization.
- Use the existing command/session/save queue and relation validation contracts. Validate newly staged schemas as a coherent proposed state; retain atomic failure, cardinality and undo behavior.
- Diagnose the insert/undo failure before changing behavior. Do not weaken assertions, suppress errors or rely on blind delays.
- Correct shared modal/popover ownership, focus and sizing contracts rather than patching individual click targets.
- Fix document selection at the editor/view boundary without silencing page errors.
- Retain the shared table engine and normalize styling across canonical inline embeds and linked views. Preserve per-view state and independent names.
- Keep active filters, sorts, accessibility and keyboard operations discoverable when reducing toolbar clutter.
- Use fork version 1.1.1 independently of base 1.2.1. Release notes cover published 1.0.1 through 1.1.1.
- Work only in isolated hidden profiles and synthetic vaults. No personal installation, real records or original attachments are release fixtures.
- Packaged builds currently ignore development-only hidden/profile flags. Add an explicit constrained smoke-test startup mode: hidden opt-in and a dedicated absolute temporary profile, containment and real-filesystem checks before side effects, fail closed on invalid combinations, and no global capture shortcut. Normal installed startup remains unchanged.
- Publication groups are planning/policy, data reliability, editor/menus/icons, table interaction/presentation, and final release bookkeeping. Development fixups stay in their relevant delivery.

## Testing Decisions

- Exercise externally visible command behavior, storage persistence and reopening, including atomic rejected relation configuration and existing pair union.
- Reproduce insert-before/undo/insert-after with robust readiness checks and meaningful row-count assertions. Recheck other row actions and recovery.
- Use real mouse and keyboard interactions for menus, grip operations, icon upload and linked-view collapse. Listen to errors on every reopened page.
- Compare canonical inline embed and linked view using identical database, view configuration and viewport. Check icon bounds against intended fixed slots, not expanded parents.
- Cover default and explicit calculation alignment, resize, scroll and frozen columns.
- Repeat all twenty original acceptance items, preserving qualified results and limitations, then run repository check, independent Sol review, CI and packaged application smoke.
- Capture genuine synthetic screenshots and short interaction media from the tested build; verify final uploaded artifacts and checksums.

## Out of Scope

New database engines, formula languages, additional column families, upstream feature work, PDF layout redesign, promises of instant disk persistence, cross-platform release artifacts, signing procurement, or installation into the user's personal environment.

## Further Notes

The audit and its exact reproduction evidence are retained with the repository evidence. The source notes and personal reference screenshots remain private. Three correction deliveries can have separate reviews, but the release is blocked until all correction acceptance criteria and integrated validation pass.
