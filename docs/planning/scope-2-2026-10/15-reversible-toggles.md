# T15 — Alternadores e recolhimento reversíveis e opcionais

**GitHub:** https://github.com/hodeliun/Morrow/issues/66

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Transformar títulos/textos em conteúdo recolhível e voltar, sem perder estilo nem deixar alças duplicadas sem função.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Conversão preserva texto, marks, nível do título, filhos, tabelas e identidades.
- [ ] Texto comum pode conter conteúdo recolhível sem precisar ser um título.
- [ ] Distinguir recolhimento de seção e do bloco de tabela; habilitação é opcional, alça discreta por hover/foco.
- [ ] Funciona em tabela inline e view; expansão e estado de recolhimento sobrevivem à reabertura.
- [ ] Menu comunica claramente converter/remover recolhimento e desfazer é reversível.
- [ ] Preservar toggles antigos e seu conteúdo por migração aditiva, sem removê-los em massa.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/65

## Verification

Round-trip de documento e armazenamento; UI com títulos de níveis diferentes, texto comum, tabelas aninhadas, converter/remover e reabrir.

## Traceability and delivery

Origem: S2-20. Grupo de publicação D4 — Navegação e recolhimento de documentos. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T15 -->
