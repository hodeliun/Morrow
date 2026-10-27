# Synthetic end-to-end scenarios

These are planned acceptance fixtures, not results. Use invented names and locally generated shapes/assets. Do not copy personal vaults, portraits, Coda rows or attachments. The final integration issue must record execution and reopen evidence.

## RPG page and related resources

Create a normal page “Asha — demonstração” with a local cover, a recolorable page icon, a three-column area (portrait placeholder / characteristics / navigation links), a rounded full-block “Informações” heading and linked child pages “Místico” and “Artefatos”. Editing must remain available in the normal document UI.

Create “Artefatos de demonstração” with two rows:

| Name | Base cost | Active |
|---|---:|---|
| Anel de Vidro | 3 | true |
| Lanterna de Névoa | 5 | false |

Create “Recursos de demonstração” with a single relation restricted to the artifact table and a calculated numeric column projecting its base cost. Selecting Anel de Vidro must produce 3. Changing its cost to 4 must update the result to 4 without reselecting the relation. Renaming the source column/table must preserve the bound expression. Unrelated pages must not appear in the picker. Verify the inverse link and reopen.

Add two views of the artifact table in normal pages. Filter one to active rows and leave the other unfiltered; modifying a source row from either view must update the other without copying it. Removing one embedded view must retain both source records.

## Entertainment database

Create statuses “Planejado”, “Em andamento”, “Concluído” in that order, a type choice, a five-star rating, progress, and created/modified timestamps. Set new-row defaults to Planejado, progress 0 and a false favorite checkbox.

| Name | Type | Status | Completed units | Total units | Rating |
|---|---|---|---:|---:|---:|
| Jardim das Nuvens | Anime | Em andamento | 3 | 12 | 4 |
| Atlas dos Ventos | Livro | Planejado | 0 | 20 | empty |
| Estação do Norte | Série | Concluído | 8 | 8 | 5 |

Calculated progress should show 25%, 0%, and 100%. A missing rating must remain distinct from a rating of zero. Verify gallery/board grouping and order, select labels/colors, a visible type filter, search, a table view with independent widths/hidden columns/wrapping, and summaries. Change a default and verify existing records are unchanged. Add a fresh record through the UI and reopen.

## Finance database and explicit actions

Use invented bank “Banco Aurora”, categories “Livros” and “Lazer”, invoice rows December 2026 and January 2027, and currency BRL with pt-BR display. The pending/paid field is boolean with a false creation default.

| Name | Date | Amount | Paid |
|---|---|---:|---|
| Livro demonstrativo | 2026-12-05 | 60.00 | false |
| Ingresso demonstrativo | 2026-12-15 | 40.00 | true |
| Renovação demonstrativa | 2027-01-05 | 25.00 | false |

Named year/month controls initially select 2026/12. A filtered view and named total should show two rows and R$ 100,00; pending total R$ 60,00. Changing controls to 2027/1 should show one row and R$ 25,00, without editing source dates. Relation projections should supply bank/invoice labels and invoice totals. Verify empty relation diagnostics and explicit resolution of duplicate table names.

Configure a table action for a synthetic purchase of R$ 100,00 split into three monthly installments starting December 2026. Preview must explain the rows; execution must produce December/January/February dates and amounts totaling exactly 10,000 centavos (for example 33.34 + 33.33 + 33.33). Repeated activation while running must not duplicate rows. Confirm durable save, inject a second-file failure in automated tests, recover, and verify conflict-aware undo with an intervening row edit. Merely recalculating a formula must never trigger this action.

## Rich cells and portability

Attach one generated local image to two records; removing it from the first must not delete the second record's file. Verify single/multiple choices, metadata, missing-file state and reopen. In a rich cell, author paragraphs, a list, link and image, then close/reopen the cell and app. Export/read Markdown outside the app: static content is readable and dynamic elements have documented fallback behavior. Do not claim external editors execute formulas or views.

## Packaging gate

The executable must identify itself as Morrow Polaris and use its own app data and initial vault. Deliver a separate Windows artifact and demo directory, not an overwrite of Morrow or the user's pilot. Record build commit, test results, exact license exception for Notion icons and remaining limitations in the guide.
