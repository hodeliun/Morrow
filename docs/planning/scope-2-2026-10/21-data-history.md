# T21 — Desfazer e refazer alterações de dados com histórico limitado

**GitHub:** https://github.com/hodeliun/Morrow/issues/72

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Manter dez ações recentes por banco de origem durante a sessão, compartilhadas entre suas views.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Dados editados em duas views pertencem ao mesmo histórico do banco; desfazer não cria cópias independentes.
- [ ] Expor desfazer/refazer acessíveis, indicação do próximo efeito e estado indisponível.
- [ ] Reutilizar comandos tipados e recuperação existente; inversas validam conflitos antes de escrever.
- [ ] Nova edição invalida redo do escopo afetado; conflitos externos mostram recuperação sem sobrescrever silenciosamente.
- [ ] Dez entradas por banco na sessão; teto global inicial de 32 MiB descarta apenas entradas concluídas mais antigas, nunca recuperação pendente.
- [ ] Preservar recuperação persistida atual; não prometer dez ações persistentes após reiniciar.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Editar via duas views, desfazer/refazer, exceder dez entradas, conflito externo, recuperação após interrupção e limites de memória.

## Traceability and delivery

Origem: S2-22. Grupo de publicação D6 — Histórico contextual de dados e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T21 -->
