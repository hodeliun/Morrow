# T26 — Controle de intervalo de datas e períodos rápidos

**GitHub:** https://github.com/hodeliun/Morrow/issues/77

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Selecionar um intervalo de datas e utilizá-lo em filtros e fórmulas.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Persistir par ordenado de datas ISO sem hora ou vazio, com início menor ou igual ao fim.
- [ ] Oferecer personalizado, hoje, últimos sete dias, mês atual e próximos sete dias; limites inclusivos e rótulos claros.
- [ ] Presets usam calendário local e relógio injetável nos testes; selecionar salva limites, abrir nota não recalcula nem grava.
- [ ] Interpretador recebe lista ordenada compatível com First/Last; não confundir com IDs de relation.
- [ ] Configuração, padrão/reset, teclado e readonly seguem controles existentes; data simples continua compatível.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/74

## Verification

Datas invertidas, vazias, ano bissexto, mudança de mês/fuso/horário, filtros inclusivos e round-trip.

## Traceability and delivery

Origem: S2-29. Grupo de publicação D7 — Catálogo e configuração de controles. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T26 -->
