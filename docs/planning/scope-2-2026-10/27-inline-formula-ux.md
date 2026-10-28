# T27 — Resultados de fórmula realmente integrados ao texto

**GitHub:** https://github.com/hodeliun/Morrow/issues/78

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Apresentar o resultado calculado no fluxo do documento, com edição acessível.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Reutilizar CalculatedResult e bindings existentes; resultado e nome opcional cabem dentro de um parágrafo com texto antes/depois.
- [ ] Slash e menu contextual localizados abrem edição; salvar/cancelar preservam texto, marks e ID.
- [ ] Distinguir fórmula não preenchida, vazio, zero, falso e erro com diagnóstico compreensível.
- [ ] Usar editor e formatação compartilhados, sem campo textual ou interpretador concorrentes.
- [ ] Copiar, editar texto vizinho, desfazer e reabrir não removem nem duplicam o objeto.
- [ ] Exibir resultado vazio como [] discreto, distinto de erro e de fórmula ainda não configurada; atalho inicial confirmado é /formula, não assumir '=' como comando.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/59
- https://github.com/hodeliun/Morrow/issues/65

## Verification

Parágrafo com resultado no meio, teclado/IME, formatação, zero/falso/vazio/erro e save/reopen.

## Traceability and delivery

Origem: S2-30. Grupo de publicação D8 — Resultados inline e rede de referências. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T27 -->
