# Acceptance ledger

This is a verification index, not a claim that the specification is complete. The principal (Sol 6.1 medium) checks each Luna max delivery before closing its issue. The closed specification issue is not the implementation status.

| Story | Evidence and coverage                                                    | Status / known limit                                                                                                                                                |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | #2 — `evidence/01.md`, `evidence/01-runtime.md`                          | Implemented; separate product profile and vault                                                                                                                     |
| 2     | #5 — `evidence/04.md`, `database.test.ts`                                | Implemented; type, description and display settings                                                                                                                 |
| 3     | #5 — `evidence/04.md`, `database.test.ts`                                | Implemented; one-time defaults and explicit-value precedence                                                                                                        |
| 4     | #5 — `evidence/04.md`, `database.test.ts`                                | Implemented; calculated values keep their result type                                                                                                               |
| 5     | #5 — `evidence/04.md`, `database.test.ts`                                | Implemented; false, zero, empty and missing remain distinct                                                                                                         |
| 6     | #5 — `evidence/04.md`, `database.test.ts`, `i18n.test.ts`                | Implemented; PT style labels and boolean display localization added in #13                                                                                          |
| 7     | #5 — `evidence/04.md`, `database.test.ts`                                | Implemented; conversion reports invalid values without discarding them                                                                                              |
| 8     | #4 — `evidence/03.md`, `evidence/03-runtime.md`                          | Implemented; target, single/multiple selection and option filters                                                                                                   |
| 9     | #4 — `evidence/03.md`, `evidence/03-runtime.md`                          | Implemented; inverse relation navigation and edits                                                                                                                  |
| 10    | #6 — `evidence/05.md`, `evidence/05-runtime.md`, `FORMULAS.md`           | Implemented; related-row projection                                                                                                                                 |
| 11    | #6 — `evidence/05.md`, `FORMULAS.md`                                     | Implemented; table references and completion                                                                                                                        |
| 12    | #6 — `evidence/05.md`, `FORMULAS.md`                                     | Implemented; filters, projections, aggregation and typed rows                                                                                                       |
| 13    | #6 — `evidence/05.md`, `FORMULAS.md`                                     | Implemented; documented bounded formula functions                                                                                                                   |
| 14    | #8 — `evidence/07.md`, `evidence/07-runtime.md`                          | Implemented; page-scoped controls in formulas and filters                                                                                                           |
| 15    | #8 — `evidence/07.md`, `evidence/07-runtime.md`                          | Implemented; inline calculated results                                                                                                                              |
| 16    | #6/#8 — `evidence/05.md`, `evidence/07.md`, `FORMULAS.md`                | Implemented; missing, type, cycle and evaluation errors stay visible                                                                                                |
| 17    | #6 — `evidence/05.md`, `evidence/05-runtime.md`                          | Implemented; stable binding and duplicate-name diagnostics                                                                                                          |
| 18    | #7 — `evidence/06.md`, `evidence/06-runtime.md`                          | Implemented; source rows remain shared                                                                                                                              |
| 19    | #7 — `evidence/06.md`, `evidence/06-runtime.md`                          | Implemented; independent filters, sorts and layout state                                                                                                            |
| 20    | #7 — `evidence/06.md`, `evidence/06-runtime.md`                          | Implemented; visible quick filters and search                                                                                                                       |
| 21    | #7 — `evidence/06.md`, `evidence/06-runtime.md`                          | Implemented; source and linked-view navigation                                                                                                                      |
| 22    | #7 — `evidence/06.md`, `evidence/06-runtime.md`                          | Implemented; dependent references are guarded and recoverable                                                                                                       |
| 23    | #7 — `evidence/06.md`, `evidence/06-runtime.md`                          | Implemented; table, board, gallery, list and calendar                                                                                                               |
| 24    | #7 — `evidence/06.md`, `evidence/06-runtime.md`                          | Implemented; summaries and conditional row/cell formatting                                                                                                          |
| 25    | #12 — `evidence/11.md`, `evidence/11-runtime.md`                         | Implemented; configured actions are the only mutation path                                                                                                          |
| 26    | #12 — `evidence/11.md`, `evidence/11-runtime.md`, `tableActions.test.ts` | Implemented; preview, recovery, undo and exact cent allocation                                                                                                      |
| 27    | #9 — `evidence/08.md`, `evidence/09-runtime.md`                          | Implemented with licensed Lucide and custom uploads; exact Notion icon set is excluded because redistribution permission is unconfirmed                             |
| 28    | #9 — `evidence/08.md`, `evidence/09-runtime.md`                          | Implemented; sanitized SVGs and consistent icon display                                                                                                             |
| 29    | #10 — `evidence/09.md`, `evidence/09-runtime.md`                         | Implemented; cover preview, crop and save/cancel                                                                                                                    |
| 30    | #9 — `evidence/08.md`                                                    | Implemented; links use subtle underlines and relations remain identifiable                                                                                          |
| 31    | #10 — `evidence/09.md`, `evidence/09-runtime.md`                         | Implemented; block backgrounds are separate from text highlighting                                                                                                  |
| 32    | #10 — `evidence/09.md`, `evidence/09-runtime.md`                         | Implemented; editable columns and existing content blocks                                                                                                           |
| 33    | #10 — `evidence/09.md`, `evidence/09-runtime.md`                         | Implemented; per-note styling and reversible batch application                                                                                                      |
| 34    | #3 — `evidence/02.md`, `evidence/02-runtime.md`                          | Implemented; structured YAML and unknown values are preserved                                                                                                       |
| 35    | #3 — `evidence/02.md`, `evidence/02-runtime.md`                          | Implemented; OKF metadata and compatibility diagnostics                                                                                                             |
| 36    | #13 — `portability.test.ts`, `evidence/12.md`                            | Implemented; Markdown now includes frontmatter, attachments, row snapshots and dynamic-element fallbacks. External Markdown does not run formulas or refresh views. |
| 37    | #13 — `evidence/12-demo.md`, `evidence/12-runtime.md`, `GUIA.md`         | Implemented and verified: synthetic demo, hidden UI/reopen review, preserved legacy-pilot copy, and separate Windows installer/portable builds.                       |

## Final integration gates

- Every implemented UI action must use the application command/session/save path; core-only support is insufficient.
- Fresh and reopened synthetic documents must agree. Changing defaults must not rewrite old rows. False, zero, empty and missing are distinct where specified.
- A relation points to a stable row, not a copied title. Formula bindings must survive renaming, including schemas with no rows.
- An invalid conversion must leave all original cells intact. Numeric strings must not be interpreted by discarding arbitrary characters.
- A linked view has its own presentation/filter state and edits source records. Removing it must not remove source records.
- Financial actions must distinguish successful memory updates from successful disk writes. Test partial write failure, recovery, repeated clicks and undo after intervening edits.
- Demonstrations contain invented data and assets with known provenance. No original personal vault, financial row, credentials or app profile enters Git.
- UI testing uses invisible isolated Electron windows where possible; the packaged-app smoke test was confined to the second monitor.
- Run the integrated `npm run check`, review the actual rendered UI and produce the separate Windows build before claiming final delivery.

## Disclosed exception

The exact Notion icon set has no verified redistribution license in the research. The implemented catalog is licensed Lucide, with recoloring and custom uploads. It must not be described as imported Notion assets.
