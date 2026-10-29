# T33 — Abrir imagens existentes em abas sem importar para notas

**GitHub:** https://github.com/hodeliun/Morrow/issues/85

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Visualizar imagem de pasta comum em aba própria e introduzir alvos de recurso compatíveis com as abas existentes.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Alvo de aba diferencia página, arquivo local, URL e vazio sem converter binário em Page; rotas e abas antigas continuam funcionais durante expansão.
- [ ] Clique em imagem usa handler interno quando selecionado; zoom, ajustar à área, dimensão/nome e erro para arquivo removido; manter GIF animado quando suportado.
- [ ] Imagem já no vault é referenciada no lugar; não copiar para attachments nem aplicar limite de upload a arquivo existente.
- [ ] SVG é mostrado como imagem sem scripts, navegação ou preload do aplicativo; MIME e path reais validados pelo processo principal.
- [ ] Abrir/fechar/alternar vault libera recurso, preserva histórico e mantém readonly; erro de decode não modifica original.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/83

## Verification

Aba de PNG/GIF/SVG sintéticos, route migration, arquivo com espaços/Unicode, arquivo ausente, SVG ativo, duas instâncias e comparação de hashes/reabertura.

## Traceability and delivery

Origem: S2-33. Grupo D11 — Visualizadores locais de imagens, PDF e mídia. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T33 -->
