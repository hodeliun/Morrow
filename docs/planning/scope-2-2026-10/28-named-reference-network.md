# T28 — Referências nomeadas entre controles, resultados e tabelas

**GitHub:** https://github.com/hodeliun/Morrow/issues/79

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Selecionar referências identificáveis e encadear cálculos sem perder vínculos ao renomear.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Picker oferece objetos da página e referências explícitas entre páginas, com nome, tipo e origem; persistência por IDs.
- [ ] Nomes duplicados exigem desambiguação; renomear mantém vínculo e excluir produz diagnóstico, sem escolher correspondência aproximada.
- [ ] Controles alimentam resultados, resultados alimentam outros resultados, tabelas e filtros; atualizações chegam sem edição manual adicional.
- [ ] Detectar ciclos locais e entre páginas/tabelas, com avaliação limitada e mensagem estável.
- [ ] Copiar objetos remapeia IDs internos da cópia e preserva referências externas; nunca executar eval, rede ou ações.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/74
- https://github.com/hodeliun/Morrow/issues/78

## Verification

Rede sintética controle→resultado→tabela/filtro, rename/delete, duplicação, ambiguidade, ciclos e volume limitado de recálculos.

## Traceability and delivery

Origem: S2-30. Grupo de publicação D8 — Resultados inline e rede de referências. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T28 -->
