# T03 — Editar Nome e restaurar a coluna de exibição

**GitHub:** https://github.com/hodeliun/Morrow/issues/54

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Oferecer menu de coluna consistente, renomear o cabeçalho Nome e editar títulos de linha, além de trocar/restaurar o campo de exibição.

**Implementado e verificado no recorte isolado T03; publicação sequencial autorizada por Carlos.**

## Acceptance criteria

- [x] Nome continua sendo a projeção do título da página, não uma segunda propriedade com dados duplicados.
- [x] Renomear o cabeçalho mantém títulos/IDs das linhas; editar uma célula Nome usa a operação normal de renomear a linha.
- [x] Definir outra coluna como exibição e voltar a Nome sem editar metadados manualmente; mostrar indicador acessível de olho.
- [x] Excluir propriedade comum pelo botão direito identifica o alvo e preserva dados/referências não relacionados.
- [x] Nome não é excluído sem uma semântica de substituição: nesta entrega, a ação é indisponível com explicação, não um apagamento de títulos.
- [x] Conferir campo de exibição padrão do banco e override de relação sem confundir ambos.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Comandos e storage para aliases/títulos/display; testes de relações e UI do menu com reabertura e colisões de nomes.

## Traceability and delivery

Origem: S2-02, S2-03. Grupo de publicação D2 — Apresentação e configuração de tabelas e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Implementação autorizada por Carlos e concluída.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T03 -->

## Evidência da entrega isolada

965 testes em 119 arquivos, tipos, lint e compilação aprovados; pacote 3597/3597. UI principal e complementar aprovadas nos seis critérios, com relações/override, idiomas/temas, 520 px, readonly e reabertura. Primeiro formato 13 inclui os contratos completos de leitura/normalização/persistência/migração, sem declarar entregues as interfaces dos outros tickets. [Comportamento e limites](../../deliveries/T03-name-display-property.md), [registro verificável](../../deliveries/T03-validation.json) e [formato 13](../../SCHEMA-13.md). Negativos de testes e compatibilidade preservados e corrigidos antes do primeiro envio.
