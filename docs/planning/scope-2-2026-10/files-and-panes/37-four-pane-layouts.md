# T37 — Organizar notas em até quatro painéis redimensionáveis

**GitHub:** https://github.com/hodeliun/Morrow/issues/89

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Estender o split atual com layouts predefinidos e separadores horizontais/verticais.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Layouts com previews: único, duas colunas, uma esquerda e duas direita, grade 2×2; botão próximo aos controles de janela em área sem conflito com minimizar/maximizar.
- [ ] Aplicar preset mantém aba atual no primeiro slot, novos slots vazios; demais abas abertas permanecem acessíveis sem distribuição automática.
- [ ] Até quatro folhas/painéis visíveis, sem reduzir limite de abas totais. Separadores ajustam proporções de cada ramo com teclado, Esc/cancelar e reset.
- [ ] Generalizar main/side de forma compatível e incremental; migração inicial conserva splitShare, alvos e históricos antigos, sem resetar sessão.
- [ ] Fechar/reduzir painel devolve abas à lista e preserva drafts/save queue; layout/foco/proporções são estado do app, não edições das notas.
- [ ] Janela pequena mantém acesso aos painéis por overflow/adaptação explícita, sem apagar slots; readonly, PT/EN/ES e navegação por foco funcionam.

## Blocked by

Nenhum bloqueador funcional — atribuir somente após autorização de desenvolvimento.

## Verification

Layouts de uma a quatro notas sintéticas, reabrir sessão legada, resize/keyboard/cancel, reduzir durante draft e viewport estreito; coordenar contrato de scroll de #67 sem bloqueio artificial.

## Traceability and delivery

Origem: S2-36. Grupo D13 — Workspace de até quatro painéis. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T37 -->
