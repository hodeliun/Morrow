# T18 — Redimensionar imagens dentro e fora de colunas

**GitHub:** https://github.com/hodeliun/Morrow/issues/69

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Ajustar tamanho individual de imagens mantendo recorte, alinhamento e importação local.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Alças acessíveis com resize contínuo e alternativa por teclado/configuração.
- [ ] Persistir dimensão de apresentação sem regravar pixels ou perder recorte/legenda/alinhamento.
- [ ] Duas imagens no mesmo grupo de colunas podem ter tamanhos independentes.
- [ ] Respeitar contêiner/viewport; cancelar restaura e confirmar gera uma operação, não um save por pixel.
- [ ] Inserir/substituir arquivo local continua funcionando, sem alterar a imagem original fora do vault.
- [ ] Conferir alinhamento com imagem menor, sem presumir falha do exemplo grande.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/65

## Verification

Serialização/modelo de documento e UI com resize em imagem única e em colunas, cancelamento/desfazer e reabertura.

## Traceability and delivery

Origem: S2-17. Grupo de publicação D5 — Imagens e colunas de layout. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T18 -->
