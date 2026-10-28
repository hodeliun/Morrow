# Unpublished checkpoint provenance

Before the first push of this stabilization branch, the four orchestrator-owned local commits were recreated with the account's public GitHub noreply author identity. Author name, functional messages, dates and file trees were preserved. The published main branch and upstream ancestry were not rewritten; no force push or tag change occurred.

Historical UI evidence correctly retains the local HEAD observed at capture time, often with uncommitted product changes. These old local IDs are not claims of clean release builds. The equivalent reviewed file trees are mapped here:

| Local checkpoint recorded in evidence | Public-identity equivalent |
|---|---|
| `7e26c1f` | `0f30659` — planning/audit/policy |
| `2d9aff5` | `d992e49` — data reliability |
| `43e4045` | `df14080` — packaged smoke support |
| `280010d` | `92c7f86` — editor/menus/icons |

Final source and artifact verification must record the actual publication candidate and its build fingerprints independently of these historical checkpoints.
