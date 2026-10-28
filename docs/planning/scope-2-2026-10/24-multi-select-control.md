# T24 — Controle de seleção múltipla integrado às fórmulas

**GitHub:** https://github.com/hodeliun/Morrow/issues/75

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Escolher vários valores no documento e reutilizar a seleção em cálculos e filtros.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Opções e seleções usam identidades estáveis e sem duplicatas, compatíveis com o contrato do select existente.
- [ ] Busca e seleção funcionam por teclado; chips removíveis têm nomes acessíveis.
- [ ] Renomear opção preserva a seleção; remoção pede resolução explícita e não perde valores silenciosamente.
- [ ] Padrões, reset, readonly e reabertura preservam lista tipada; fórmulas e filtros consomem a lista sem strings de apresentação.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/74

## Verification

Duas opções, renomear/remover, padrão/reset, lista vazia, fórmula/filtro e round-trip Markdown.

## Traceability and delivery

Origem: S2-29. Grupo de publicação D7 — Catálogo e configuração de controles. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T24 -->
