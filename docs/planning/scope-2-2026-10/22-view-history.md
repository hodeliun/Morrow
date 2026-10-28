# T22 — Histórico contextual das configurações de cada visualização

**GitHub:** https://github.com/hodeliun/Morrow/issues/73

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Desfazer mudanças locais de apresentação sem alterar as outras visualizações.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Manter dez ações de configuração por view durante a sessão, distintas das ações de dados do banco.
- [ ] Cobrir filtros, ordenação, título, ordem e ocultação de colunas; outra view permanece intacta.
- [ ] Desfazer contextual escolhe o evento aplicável mais recente e indica seu proprietário.
- [ ] Texto em edição usa seu desfazer nativo; não sequestrar atalhos de drafts.
- [ ] Conflitos e invalidação de redo seguem o escopo correto; abrir página não grava histórico nem modifica arquivos.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/72
- https://github.com/hodeliun/Morrow/issues/64

## Verification

Intercalar edição de dados e configuração de duas views; testar foco de editor, desfazer contextual, redo e reabertura.

## Traceability and delivery

Origem: S2-22. Grupo de publicação D6 — Histórico contextual de dados e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T22 -->
