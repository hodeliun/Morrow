# T04 — Reordenar colunas por arraste apenas na visualização ativa

**GitHub:** https://github.com/hodeliun/Morrow/issues/55

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Arrastar um cabeçalho para antes/depois de outro com destino claro, mantendo o schema e outras views.

Implementação autorizada e verificada na entrega sequencial T04.

## Acceptance criteria

- [x] Reutilizar ordem local da view já existente; não reordenar o schema do banco como efeito do arraste.
- [x] Suportar título e propriedades comuns, com colunas ocultas/congeladas e rolagem horizontal.
- [x] Indicar destino, confirmar numa única operação ao soltar e cancelar por Esc.
- [x] Oferecer alternativa por teclado/menu; cabeçalhos não iniciam edição ou redimensionamento acidentalmente.
- [x] Persistir e reabrir mantendo a ordem daquela view e a ordem independente de outra.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Comandos de configuração da view, serialização e UI com mouse/teclado; comparar duas views do mesmo banco.

## Traceability and delivery

Origem: S2-09. Grupo de publicação D2 — Apresentação e configuração de tabelas e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas.

Verificação: 974 testes/119 arquivos, tipos, lint, compilação e pacote com 3.597
artefatos conferidos. Cenários principal e complementar passaram na aplicação
isolada no Windows. [Entrega e evidências](../../deliveries/T04-view-column-order.md).

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T04 -->
