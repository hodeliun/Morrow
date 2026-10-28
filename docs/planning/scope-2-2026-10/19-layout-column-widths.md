# T19 — Larguras livres e persistentes nas colunas da página

**GitHub:** https://github.com/hodeliun/Morrow/issues/70

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Arrastar separadores de até sete colunas de conteúdo, com proporções próprias e ajuste fino.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Larguras normalizadas/relativas são persistidas aditivamente; grupos antigos sem largura mantêm distribuição padrão.
- [ ] Arraste contínuo sem snap obrigatório, com mínimo operacional e indicação do destino.
- [ ] Resize apenas de layout, não das propriedades de banco; preservar filhos/IDs e imagens.
- [ ] Esc cancela, soltar confirma uma única operação e desfazer restaura.
- [ ] Conferir grupo de duas e sete colunas em viewport largo/estreito, sem gravar arquivos ao apenas abrir.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/65

## Verification

Round-trip de atributos do documento, comandos e UI de resize contínuo; medir mudança de proporções e preservar todo conteúdo.

## Traceability and delivery

Origem: S2-18. Grupo de publicação D5 — Imagens e colunas de layout. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T19 -->
