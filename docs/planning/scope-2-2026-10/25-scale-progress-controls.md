# T25 — Controles de escala e progresso com valores numéricos

**GitHub:** https://github.com/hodeliun/Morrow/issues/76

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Usar escala e progresso configuráveis sem perder a precisão dos cálculos.

**Implementação autorizada posteriormente pelo mantenedor; critérios verificados nesta entrega.**

## Acceptance criteria

- [x] Escala e progresso reutilizam validação numérica; mínimo, máximo e passo são explícitos e coerentes.
- [x] Diferenciar entrada manual e resultado calculado, sem tornar resultado editável por acidente.
- [x] Ícone, cor, legenda e valor acessível não dependem só de cor; teclado respeita limites.
- [x] Persistir número tipado, não texto formatado; distinguir zero e vazio, respeitar padrão/reset e readonly.
- [x] Fórmulas e filtros recebem o mesmo número apresentado; configuração inválida informa o problema.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/74

## Verification

Limites/passos, zero/vazio, formato, teclado, reset, readonly e consumo de ambos em fórmula.

## Traceability and delivery

Origem: S2-29. Grupo de publicação D7 — Catálogo e configuração de controles. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Autorização posterior registrada na execução.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T25 -->
