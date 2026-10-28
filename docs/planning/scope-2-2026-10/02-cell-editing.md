# T02 — Digitação imediata e confirmação confiável de células

**GitHub:** https://github.com/hodeliun/Morrow/issues/53

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Selecionar uma célula editável, digitar diretamente, confirmar e avançar; tratar texto multilinha sem perda do rascunho.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Digitação imprimível inicia edição da célula selecionada sem Enter prévio, preservando IME/composição e atalhos.
- [ ] Decisão de planejamento: Enter confirma valor válido e avança uma linha; no modo de navegação também avança. Shift+Enter insere quebra quando o editor textual estiver ativo.
- [ ] Blur confirma rascunho válido; Esc cancela e restaura o valor anterior; rascunho inválido permanece identificável, sem gravação parcial.
- [ ] Manter edição multilinha e Ctrl+Enter como atalho compatível opcional, sem exigi-lo para confirmar.
- [ ] Não editar resultados calculados nem gravar teclas de navegação como conteúdo.
- [ ] Conferir persistência após sair, alternar de página e reabrir.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Seam de comandos/session para validação e persistência, mais UI com teclado real, texto multilinha, IME, cancelamento e reabertura.

## Traceability and delivery

Origem: S2-24. Grupo de publicação D1 — Confiabilidade: clipboard, edição, gestos e integridade. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T02 -->
