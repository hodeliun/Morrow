# T06 — Selecionar células sem arrastar a visualização inteira

**GitHub:** https://github.com/hodeliun/Morrow/issues/57

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Dentro de uma view vinculada, arrastar células seleciona intervalos; somente a alça do bloco move a view.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Corrigir a fronteira de eventos/seleção da NodeView, sem bloquear genericamente todo evento do editor.
- [ ] Arraste dentro da grade seleciona células em ambas as direções, inclusive com Shift e rolagem.
- [ ] Alça externa move o bloco; a da linha mantém ações de linha.
- [ ] Interagir com inputs, links, menus e readonly sem deslocar ou apagar o bloco.
- [ ] Conferir o mesmo gesto na tabela inline e na view vinculada.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Teste de contrato dos eventos da NodeView e UI real com intervalos, alças, controles focados e preservação do documento.

## Traceability and delivery

Origem: S2-26. Grupo de publicação D1 — Confiabilidade: clipboard, edição, gestos e integridade. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T06 -->
