# T16 — Navegação por títulos e restauração de rolagem entre abas

**GitHub:** https://github.com/hodeliun/Morrow/issues/67

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Abrir/fechar o sumário, ir a um título e trocar abas sem perder o ponto de leitura.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] O botão efetivamente alterna o painel e expõe estado/rotulagem acessíveis.
- [ ] Títulos listados navegam ao destino correto, inclusive sob seções recolhidas com comportamento explícito.
- [ ] Cada aba guarda posição na sessão, independentemente das demais; voltar espera o conteúdo estar renderizado.
- [ ] Navegação explícita por âncora prevalece sobre posição lembrada; não saltar de novo depois que o usuário já começou a rolar.
- [ ] Persistência de rolagem após reiniciar não é prometida nesta entrega; não escrever páginas só para salvar posição.
- [ ] Conferir várias abas da mesma página e páginas distintas, viewport estreito e listas longas.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

UI de navegação com sumário e duas abas longas; mudanças de posição medidas relativamente, sem mocks de scroll usados como prova final.

## Traceability and delivery

Origem: S2-05, S2-27. Grupo de publicação D4 — Navegação e recolhimento de documentos. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T16 -->
