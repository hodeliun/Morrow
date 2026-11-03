# T18 — Redimensionar imagens dentro e fora de colunas

**GitHub:** https://github.com/hodeliun/Morrow/issues/69

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Ajustar tamanho individual de imagens mantendo recorte, alinhamento e importação local.

**Execução autorizada:** entrega sequencial isolada após a publicação do T20.
Reutilizar as correções e evidências existentes, verificando o recorte extraído
contra a base publicada antes de encerrar esta issue. As demais frentes permanecem
pausadas enquanto esta entrega estiver ativa.

## Acceptance criteria

- [x] Alças acessíveis com resize contínuo e alternativa por teclado/configuração.
- [x] Persistir dimensão de apresentação sem regravar pixels ou perder recorte/legenda/alinhamento.
- [x] Duas imagens no mesmo grupo de colunas podem ter tamanhos independentes.
- [x] Respeitar contêiner/viewport; cancelar restaura e confirmar gera uma operação, não um save por pixel.
- [x] Inserir/substituir arquivo local continua funcionando, sem alterar a imagem original fora do vault.
- [x] Conferir alinhamento com imagem menor, sem presumir falha do exemplo grande.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/65

## Verification

Serialização/modelo de documento e UI com resize em imagem única e em colunas, cancelamento/desfazer e reabertura.

## Traceability and delivery

Origem: S2-17. Grupo de publicação D5 — Imagens e colunas de layout. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T18 -->

Validação isolada 02: 823 testes/99 arquivos, tipos, lint e build; pacote 3597/3597; UI principal e complementares padrão/MAX completas. Ver [guia e limites](../../deliveries/T18-image-sizing.md).
