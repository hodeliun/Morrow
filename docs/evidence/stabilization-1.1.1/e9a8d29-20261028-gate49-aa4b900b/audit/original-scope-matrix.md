# Gate #49 — matriz dos 20 critérios originais

**Resultado da auditoria de UI:** 20 passaram, 0 parciais, 0 falharam, 0 não verificados. Esta matriz registra somente a auditoria funcional do candidato; o gate de release ainda depende da validação empacotada e dos artefatos finais.

## Identidade e condições da execução

- Candidato: `e9a8d29cabd1356645eb871f62304c249526034f`, versão `1.2.1-fork.1.1.1`.
- O relatório do snapshot compilado registra que havia edições locais ainda não incorporadas. Portanto, os resultados são evidência de validação e não identificam o build final de release.
- Fixtures sintéticas; janelas Electron ocultas; máximo de janelas visíveis: 0; erros de renderer: 0.
- Fingerprint da árvore de fontes validada por `npm run check`: SHA-256 `c3aa1d4ae55438b084a24cdb4a63bb641a2126c872ea30b84047b120402d0257`, 258 arquivos, idêntica antes e depois ([relatório](../../check-candidate.json)).
- Identidade do snapshot compilado `dist` + `dist-electron`: fingerprint de bundle `3580c8ac3ce5cfe74924a2abf6979923cca5a93231316597053dabb8c7b8f541`; hash de conteúdo `0db322d906a61e149a0e5c59aac33f4ee7e4b02c40a4afe1e8a062010066b93b`; 3.596 arquivos ([relatório](delivery2-ui-final.json)). São fingerprints com métodos distintos; o valor `3580...` aparece no JSON de delivery2 sob o campo `sourceInputsSha256`, mas não é o hash da árvore-fonte de 258 arquivos. As verificações registraram a identidade compilada sem alterações durante as execuções.
- `npm run check`: passou, com 61 arquivos de teste e 473 testes ([relatório](../../check-candidate.json)).
- Evidências detalhadas por execução estão nos JSONs abaixo. A lista de tentativas e erros de agregação dos harnesses permanece em `attempts/`; não foi usada como evidência de falha do produto.

## Matriz

| # | Status | Resultado verificado | Evidência da execução |
|---:|---|---|---|
| 1 | Passou | Amostras de cor padrão e HEX personalizado aplicam-se ao bloco e persistem. | [relatório de páginas](original-scope-pages.json); [paleta](../screenshots/original-scope-pages/page-item01-palette-menu.png), [HEX](../screenshots/original-scope-pages/page-item01-custom-hex-applied.png) |
| 2 | Passou | Filtros rápidos mostram as linhas esperadas e o reset restaura a tabela; dois filtros simultâneos e seus controles cabem em 800×600. | [delivery2](delivery2-ui-final.json); [amostra estreita com múltiplos filtros](narrow-multiple-filters-smoke.json) |
| 3 | Passou | Menu real da imagem, legenda, alinhamentos, recorte de uma imagem já recortada, cancelamento da troca e substituição persistente passaram; o arquivo de origem sintético permaneceu intacto. | [relatório de páginas](original-scope-pages.json); [menu](../screenshots/original-scope-pages/page-item03-right-click-menu.png), [recorte](../screenshots/original-scope-pages/page-item03-crop-overlay.png), [troca](../screenshots/original-scope-pages/page-item03-replacement-applied.png) |
| 4 | Passou | Largura total e menus cabem em 1600×1000 e 800×600; o seletor de ícones fica sobre o painel, Escape fecha a camada superior e restaura foco. | [páginas](original-scope-pages.json); [delivery3, ticket #37](delivery3-ui.json); [painel 800×600](../screenshots/original-scope-pages/page-item04-style-panel-800x600.png) |
| 5 | Passou | Recolhimento hierárquico opcional, desativação, restauração do conteúdo e persistência após reabrir passaram. | [relatório de páginas](original-scope-pages.json); [título recolhido](../screenshots/original-scope-pages/page-item05-collapsed-heading.png) |
| 6 | Passou | Navegação, edição e commit por teclado, clipboard, preenchimento vertical e horizontal, preservação das demais células e undo passaram. | [teclado e clipboard](item6-cell-keyboard-clipboard.json); [preenchimentos](original-scope-items6-14.json); [delivery4, tickets #32–34](delivery4-ui.json) |
| 7 | Passou | O menu da coluna apresenta “Editar coluna” e abre as configurações corretas. | [banco de dados](original-scope-database.json) |
| 8 | Passou | Paleta e HEX da formatação condicional aparecem; a regra `Valor >= 200` colore somente as linhas correspondentes após reabrir. | [banco de dados](original-scope-database.json); [delivery2](delivery2-ui-final.json) |
| 9 | Passou | View vinculada recolhe/expande e oculta o título sem perder acesso à origem; o estado persiste após reabrir sem erros de renderer. | [banco de dados](original-scope-database.json) |
| 10 | Passou | Opções compactas expõem seções, estado de filtros/ordenação e views vinculadas. Em Opções → Propriedades de um banco na lixeira, o campo protegido permanece visível, cinco controles de mutação ficam desativados, controles de linha não aparecem e o Markdown não muda. | [banco de dados](original-scope-database.json); [prova atual de somente leitura](stabilization-tables-ui-current-e9-item10-readonly.json) |
| 11 | Passou | O embed inline canônico e a view vinculada, com mesma origem, configuração, viewport e largura, têm estilos de tabela, cabeçalho e células iguais; nomes independentes persistem. | [comparação inline](original-scope-inline.json); [banco de dados](original-scope-database.json) |
| 12 | Passou | Cálculos independentes por coluna/view persistem; alinhamento do corpo e rodapé é mantido com alinhamentos padrão e explícitos, redimensionamento, rolagem e colunas congeladas. | [banco de dados](original-scope-database.json); [delivery2](delivery2-ui-final.json) |
| 13 | Passou | Arraste real para grupo existente de seis colunas mostra indicador, move o bloco para a sétima, persiste após reabrir e recusa a oitava. | [páginas](original-scope-pages.json); [arraste focado](item13-existing-column-drag.json) |
| 14 | Passou | Seleção por mouse e teclado, Delete e Backspace limpam somente o intervalo, preservam as linhas e desfazem corretamente. | [mouse](original-scope-item14-mouse-range.json); [Backspace e preenchimento](original-scope-items6-14.json) |
| 15 | Passou | Clique na alça seleciona a linha e botão direito abre as ações; seleção por filtro/intervalo/teclado, ações de linha, undo e recuperação passaram. | [banco de dados](original-scope-database.json); [delivery5, tickets #35–36](delivery5-ui-2026-10-28T17-17-10-052Z-38064.json) |
| 16 | Passou | Os 25 tipos têm ícones; busca por nomes e aliases em português e inglês retorna os tipos esperados. | [verificações de tipos](original-scope-delivery3.json); [delivery3](delivery3-ui.json) |
| 17 | Passou | Tokens e sugestões de relação aparecem; inserção por teclado e vínculo de fórmula persistem após reabrir. | [verificações de fórmula](original-scope-delivery3.json); [delivery3](delivery3-ui.json) |
| 18 | Passou | Opções de exibição aplicáveis a resultados de fórmula coincidem com as de Número; zero e `false` permanecem distintos de vazio. | [formato de resultado](original-scope-delivery3.json) |
| 19 | Passou | Criar relação inversa e vincular/mesclar relações preenchidas persistem; os testes do candidato passaram junto com a execução de UI. | [verificações de relação](original-scope-delivery3.json); [delivery3, ticket #43](delivery3-ui.json); [suíte do candidato](../../check-candidate.json) |
| 20 | Passou | Upload raster e SVG renderiza a 14 px nos slots de cabeçalho e configurações, persiste conforme troca/reset/reabertura e preserva o ícone da página. | [verificações de ícones](original-scope-delivery3.json); [delivery3, ticket #37](delivery3-ui.json) |

## Validação integrada complementar

Este run adicional, separado da contagem dos vinte itens, passou na versão `1.2.1-fork.1.1.1` em inglês, espanhol e português. Os fingerprints de fonte e build permaneceram estáveis; todas as janelas ficaram ocultas, sem erros de renderer, e a fixture temporária foi limpa. A página sintética persistiu e reabriu; o PDF exportado tinha assinatura válida, 3 páginas, 1 imagem e todos os sete textos exigidos. A revisão visual confirmou a página renderizada; a segunda view vinculada continua da página 2 para a página 3.

A escala exibiu 1.000 linhas e selecionou 1.000 células. A colagem levou 444 ms; sua persistência, 18,96 s. Undo levou 595 ms e sua persistência, 17,92 s; redo levou 655 ms e sua persistência, 21,21 s. A tentativa de 1.001 células foi rejeitada sem alterar dados ou linhas; undo, redo e reabertura mantiveram os valores esperados. São tempos observados no harness, sem um limite de latência declarado.

- [relatório integrado](interaction-final-integrated.json)
- [página 1 do PDF](../screenshots/interaction-final-page1.png), [página 2](../screenshots/interaction-expansion-final-page2.png), [página 3](../screenshots/interaction-expansion-final-page3.png)
## Prova focada de somente leitura do item 10

No snapshot de validação atual, abri Opções → Propriedades para um banco sintético na lixeira. A ação de Propriedades permaneceu acessível e mostrou “Protected field”; os cinco controles de alteração estavam desativados, os controles de mutação de linhas estavam ausentes, e o Markdown antes/depois permaneceu idêntico. Janelas ocultas, zero erros de renderer e identidade compilada estável durante a execução.

- [Relatório focado no snapshot atual](stabilization-tables-ui-current-e9-item10-readonly.json)

## Limites do resultado

- O resultado 20/20 se refere à auditoria de UI e aos testes locais do candidato. Nenhum `win-unpacked/Morrow.exe` nem instalador foi iniciado; não há smoke empacotado registrado aqui.
- Build Windows final, inspeção do payload NSIS, assinatura, hashes de artefatos, CI no commit de publicação e publicação continuam pendentes. Esta matriz não conclui o issue #49 nem autoriza publicação.
- O snapshot usado para a auditoria incluía edições de worktree ainda não incorporadas, conforme o relatório do run; a validação precisa ser repetida no build final integrado.
- No item 11, o comparativo agregado entre banco de página inteira e view vinculada ficou marcado como “not verified” porque não é o embed inline canônico. A verificação focada do embed inline contra a view vinculada é a evidência usada e passou.
- A amostra estreita do item 2 confirma que os dois chips de filtro rápido e o popover cabem em 800×600. O indicador “1 ativos” é a contagem da regra salva da view, não dos chips temporários; o relatório registra essa distinção.
- Nota de proveniência do item 19: O relatório `delivery5-ui-2026-10-28T17-17-10-052Z-38064.json` registra
  `maxPropertyGuardIncludedInTestedBuild: false`, campo opt-in lido de
  `MORROW_DELIVERY5_PROPERTY_LIMIT_GUARD_BUILT` e cujo padrão é `false`. Isso é
  metadado do harness, não uma asserção do aplicativo, e não determina o status
  do item 19. O código do candidato contém o limite de 200 propriedades; os
  testes cobrem conflito de cardinalidade, limite, ID inválido e ID duplicado
  sem alteração parcial. `npm run check` passou. Consulte
  [verify-delivery5-ui.cjs](../../../../../scripts/verify-delivery5-ui.cjs),
  [commands.ts](../../../../../src/core/commands.ts),
  [delivery3.test.ts](../../../../../src/core/delivery3.test.ts) e
  [check-candidate.json](../../check-candidate.json).
