# T08 — Editor de fórmulas com cursor alinhado, cores e autocomplete

**GitHub:** https://github.com/hodeliun/Morrow/issues/59

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Editar fórmulas com cursor fiel ao texto, distinção visual das referências, sugestões de funções e confirmação inequívoca.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Conferir clique, seleção, inserção, apagar e composição com cápsulas e texto em várias linhas, zoom e fontes suportadas.
- [ ] Distinguir classes tabela/relação, propriedade, função e controle por cor e rótulo/ícone acessível; funções podem ter realce simples.
- [ ] Depois do ponto, sugerir propriedades e funções compatíveis; Tab insere a sugestão selecionada sem destruir o restante da expressão.
- [ ] Unificar a confirmação de fórmula/configuração num fluxo claro, removendo Salvar duplicado sem utilidade.
- [ ] Preservar expressões/bindings, tipos de resultado, zero, false e vazio; nenhum novo interpretador.
- [ ] Conferir nomes com espaços/acentos e referência ambígua sem escolher um alvo arbitrário.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Testes do editor/sugestões por comportamento e UI com caret/seleção e teclado; testes existentes de fórmulas e bindings como regressão.

## Traceability and delivery

Origem: S2-10. Grupo de publicação D3 — Editor de fórmulas e formatação condicional. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T08 -->
