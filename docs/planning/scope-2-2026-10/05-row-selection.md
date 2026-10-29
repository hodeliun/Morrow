# T05 — Seleção aditiva e controles de linha discretos

**GitHub:** https://github.com/hodeliun/Morrow/issues/56

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Selecionar várias linhas pelos checkboxes, usar a margem por hover/foco e acessar ações em menu compacto.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Cada checkbox alterna só sua linha sem exigir modificadores; seleção geral conserva seu comportamento.
- [ ] Alças/checkboxes surgem na margem por hover ou foco sem mudar larguras e permanecem reconhecíveis quando selecionados.
- [ ] Concentrar ações num menu de três pontos, sem a faixa permanente de muitos comandos.
- [ ] Distinguir seleção por checkbox, alça da linha e alça do bloco; preservar seleção por teclado e operações de lote.
- [ ] Verificar tema claro/escuro e modo somente leitura, sem controles mutantes habilitados.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

UI mouse/teclado para seleção incremental, ações em lote e estabilidade geométrica; comandos existentes para executar as ações.

## Traceability and delivery

Origem: S2-04, S2-14. Grupo de publicação D2 — Apresentação e configuração de tabelas e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T05 -->
