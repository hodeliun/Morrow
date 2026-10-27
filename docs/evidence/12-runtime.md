# Ticket 12 — final integration and Windows release evidence

## Integrated checks

- A prior integrated `npm run check` passed: typecheck, lint, 35 files / 278 tests, and production renderer, Electron and MCP builds. Its log remains outside this repository.
- The synthetic `demo/vault/` passed its separate production-loader suite: 5 tests. Its 29 pages and five SVGs are invented data and artwork.
- An isolated hidden Electron run opened the synthetic RPG, finance, entertainment, and installment-planning pages. The RPG page rendered portrait, characteristics and navigation as columns; finance showed the expected synthetic monthly totals; entertainment rendered gallery and board views. Screenshots and results remain outside this repository.
- Visual verification against the synthetic acceptance scenario confirmed the cover, icon, title, three-column profile section, rounded block, visible controls, totals, linked database and filter bar in the intended reading order. The result is a Morrow interface with comparable organization, not a pixel-exact replica of Notion or Coda.
- Changing finance controls to January 2027 changed the monthly and pending totals to R$ 25,00. The values persisted after restart, and the synthetic expense files remained unchanged.

## Windows packages

Built from the same integrated source with `electron-builder --win nsis portable --publish never`. The build log remains outside this repository.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `final-release/Morrow-1.2.0-portable-x64.exe` | 122,574,193 bytes | `9231FF8D77A76709FA96AD891B59A982F4EA5BBE1BEE2AC029DB80BF93DC84B7` |
| `final-release/Morrow-Setup-1.2.0-x64.exe` | 122,801,861 bytes | `57B7569EB1561F2D5EBCFB23138FB874C0B806944AC27E30E6B7D15B381F069F` |

The unpacked production executable reported the **Morrow** identity and used its separate app profile. It loaded a titled window and closed. Runtime evidence remains outside this repository. Both distribution files are unsigned.

## Compatibility limits

- Markdown export contains readable static snapshots of formulas and linked views; external Markdown readers cannot recalculate them.
- Legacy title-only relation values remain intact until the owner chooses their target table; ambiguous values were not guessed or rewritten.
- The exact Notion icon library has no verified redistribution license. The implemented library is Lucide with recoloring and custom uploads.
