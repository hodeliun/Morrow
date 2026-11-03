# T20 — Remover colunas, inserir texto entre blocos e indicar o drop correto

**GitHub:** https://github.com/hodeliun/Morrow/issues/71

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Manipular grupos de colunas e inserir parágrafos sem perder conteúdo ou ver destinos conflitantes.

**Execução autorizada:** primeira entrega sequencial isolada em 03/11/2026.
Os seis critérios receberam aceite local no pacote 38 e passaram novamente na
entrega isolada corrigida, com revisão e validação próprias.
As outras frentes permanecem pausadas. [Detalhes da entrega](../../deliveries/T20-layout-columns.md).

## Acceptance criteria

- [x] Ação de remover coluna é evidente; vazia pode ser removida por Backspace no limite apropriado, sem capturar edição de texto normal.
- [x] Decisão de planejamento: coluna com conteúdo pede confirmação/prévia e conserva os blocos no fluxo após o grupo; descartar conteúdo é uma ação distinta e explícita.
- [x] Ao retirar a estrutura, atualizar larguras das colunas restantes sem perder IDs/ordem dos filhos.
- [x] Oferecer ponto visível/acessível para inserir parágrafo entre imagens/grupos sem precisar acertar poucos pixels.
- [x] Mostrar um único destino de drop coerente com cima/baixo/lateral, com realce consistente.
- [x] Cancelar, desfazer e reabrir preservam blocos, tabelas vinculadas e controles contidos.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/65
- https://github.com/hodeliun/Morrow/issues/70

## Verification

Documento/session/armazenamento e UI dos gestos de remover, inserir e arrastar; cenários com conteúdo não vazio e cancelamento.

## Traceability and delivery

Origem: S2-18. Grupo de publicação D5 — Imagens e colunas de layout. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T20 -->

Validação isolada concluída: 787 testes/99 arquivos, tipos, lint e build; pacote
3597/3597 e UI dos seis critérios no snapshot isolado 02. Ver detalhes e limites
no relatório da entrega. O encerramento no tracker ocorre após publicação e CI.
