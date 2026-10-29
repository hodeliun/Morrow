# T23 — Descoberta, edição e validação dos controles existentes

**GitHub:** https://github.com/hodeliun/Morrow/issues/74

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Tornar utilizáveis os sete controles já presentes, com configurações e valores compreensíveis.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Catálogo identifica texto, número, slider, select, checkbox, data e relation; slash aliases PT/EN/ES e menu contextual conduzem às configurações.
- [ ] Editar valor sem confundir nome, valor padrão e formato; padrão só atua ao criar ou resetar.
- [ ] Restrições de texto simples/e-mail/número têm mensagens claras e permitem draft temporariamente incompleto.
- [ ] Configurações permitem salvar/cancelar e mantêm IDs estáveis, acessibilidade e modo somente leitura.
- [ ] Valores alimentam fórmulas existentes e persistem sem descartar campos desconhecidos; nenhuma engine paralela.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/65

## Verification

Inserir, editar, cancelar, resetar e reabrir cada tipo; consumir em fórmula/filtro; testar zero, falso, vazio e input inválido.

## Traceability and delivery

Origem: S2-29. Grupo de publicação D7 — Catálogo e configuração de controles. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T23 -->
