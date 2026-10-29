# T12 — Rodapé discreto e Novo antes dos cálculos

**GitHub:** https://github.com/hodeliun/Morrow/issues/63

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Adicionar registros antes dos cálculos e usar resumo sem uma faixa de dados artificial.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Ordem visual é registros, ação Novo, rodapé de cálculos.
- [ ] Fundo do rodapé acompanha o da tabela; ação de configurar é discreta, revelada por hover/foco.
- [ ] Resultados já configurados permanecem legíveis, com operação independente por propriedade/view.
- [ ] Conferir alinhamento em resize, scroll e congelamento, inclusive uma tabela sem resultados.
- [ ] Novo insere corretamente e não reaparece como registro exportado ou dado calculado.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

UI e comandos de criação de linha; regressão de cálculos/formatos e geometria relativa com rolagem e congelamento.

## Traceability and delivery

Origem: S2-12, S2-13. Grupo de publicação D2 — Apresentação e configuração de tabelas e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T12 -->
