# T38 — Escolher abas e arrastar arquivos para cada painel

**GitHub:** https://github.com/hodeliun/Morrow/issues/90

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Preencher explicitamente espaços vazios e mover abas sem perder seu estado.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Slot vazio mostra escolher aba e arrastar arquivo/nota; seletor lista abas abertas identificadas por título, tipo e origem e não seleciona automaticamente.
- [ ] Arrastar aba ou escolhê-la move a instância e seu histórico para o destino; aba anterior de slot ocupado fica acessível, sem fechar documento.
- [ ] Arrastar nota/arquivo da lateral abre no painel indicado; destinos de borda dividem apenas se houver menos de quatro, com preview único e rejeição clara do quinto.
- [ ] Selecionar mesma nota em duas instâncias usa a mesma sessão de documento, com foco/scroll/histórico de navegação independentes e sem sobrescrita concorrente.
- [ ] Foco do painel define alvo de navegação, atalhos, painel de títulos e configurações; gesto em imagem/vídeo/célula não vira arraste da aba.
- [ ] Alternar/fechar/restaurar layouts conserva identidades e localização; falha de salvar impede perda silenciosa. Alternativa por menu/teclado equivale ao drag.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/85
- https://github.com/hodeliun/Morrow/issues/89

## Verification

Dois e quatro painéis, escolher aba existente, drop novo e ocupado, quinto rejeitado, mesma nota em dois lugares, salvar conflitante, navegador/viewers quando disponíveis e reabertura.

## Traceability and delivery

Origem: S2-37. Grupo D13 — Workspace de até quatro painéis. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T38 -->
