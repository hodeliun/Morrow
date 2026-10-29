# T17 — Títulos com cor padrão do tema

**GitHub:** https://github.com/hodeliun/Morrow/issues/68

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Criar e visualizar títulos sem receber azul automaticamente, preservando escolhas explícitas de cor.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Hierarquias de títulos herdam a cor normal do texto do tema por padrão.
- [ ] Marks/cores escolhidas pelo usuário continuam representadas, sem reescrever o documento ao abrir.
- [ ] Tabelas dentro de blocos/títulos não recebem estilo de título por vazamento de CSS.
- [ ] Conferir claro/escuro, foco e seleção sem reduzir contraste.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Inspeção visual em UI clara/escura com títulos padrão e coloridos explicitamente; regressão de marks no round-trip se a serialização for afetada.

## Traceability and delivery

Origem: S2-01. Grupo de publicação D4 — Navegação e recolhimento de documentos. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T17 -->
