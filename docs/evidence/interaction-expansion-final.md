# Matriz de evidências — expansão de interação

**Estado:** a execução unificada final passou: cinco grupos, integração PDF e
escala sintética.

**Checkpoint local pré-publicação de 28/10/2026:** a revisão Sol aprovou a
validação local de #44 sem bloqueios. Nesse checkpoint, #25/#44 estavam abertas
e a CI após a correção de locale ainda estava pendente. O estado posterior da CI
e o encerramento atual de #25/#44 são os registrados no GitHub; essas issues são
a fonte autoritativa e prevalecem sobre este snapshot.

Fonte do relatório unificado:
[`interaction-expansion-final-ui.json`](interaction-expansion-final-ui.json),
timestamp `2026-10-28T08:57:25.223Z`, HEAD
`d3ee63ecdfbb8f345e8bd4b81354ecec0af7855c`, hash de fonte
`26042ea846af5adddd5c6f1ca0877b71d54561fcfac549c968eaff0ecd10797e` e hash do
bundle `797e55782b2c7d2fb0a9a0bbaf4ed0986b2577bdb5222a6a094dd323a0889dfb`.
A fonte e o bundle permaneceram estáveis durante os cinco grupos e o cenário
integrado.

## Matriz dos vinte itens

| Item | Cobertura e tickets | Commit(s) | Verificações observadas | Estado na última rodada unificada |
|---:|---|---|---|---|
| 1 | Fundo personalizado — #27 | `f0a8146` | Paleta oferece amostras; `#13579B` renderizado, gravado no marcador Markdown e lido após reabrir (`markdownMarkerSaved`, `markdownRoundTrip`). | Passou — grupo 1. |
| 2 | Controles compactos e filtros temporários — #28 | `c359e19` | Filtro mostrou Alfa/Gama sem Beta; reset restaurou três linhas; seção de filtros abriu pelo menu de opções e o filtro rápido não foi salvo como configuração (`resetRestoredThreeRows`, `filterSectionOpened`, `quickFilterRemainsTemporary`). | Passou — grupo 2. |
| 3 | Imagem, recorte e substituição — #30 | `f0a8146`, `049de4d` | Recorte inicial aplicado e cancelamento preservado; troca por imagem de outra proporção reiniciou o corte, manteve legenda/alinhamento e mudou a imagem renderizada; hash do original permaneceu igual. A ausência de recorte depois da troca foi conferida como estado esperado. | Passou — grupo 1. |
| 4 | Menus e painéis dentro da viewport — #26 | `f0a8146` | Menu de bloco, painel de opções e menu do cálculo foram medidos dentro das viewports 1600×1000 e 800×600. | Passou — grupo 1. |
| 5 | Recolhimento de seção com persistência — #31 | `f0a8146` | Conteúdo oculto permaneceu no documento; seção seguinte continuou visível; expandir restaurou o conteúdo; marcador e estado recolhido sobreviveram à reabertura (`siblingRemainsVisible`, `expandRestoresContent`, `markerSaved`, `reopenedStillCollapsed`, `contentStillPresent`). | Passou — grupo 1. |
| 6 | Foco, navegação, intervalos, clipboard e preenchimento — #32–#34 | `6c79867` | Roving focus, setas/Tab/Enter/Escape, editores e seletores; seleção retangular, limpar/desfazer, clipboard tipado e proteção de colunas somente leitura; prévia, sequência, cancelamento, coluna congelada e revalidação com filtro/ordenação (`rovingFocusVerified`, `rectangularSelectionVerified`, `batchUndoVerified`, `typedClipboardAcrossViewsVerified`, `fillPreviewVerified`, `arithmeticSequenceVerified`, entre outras). | Passou — grupo 4. |
| 7 | Tipos pesquisáveis e ícones de propriedade — #37 | `443f3db`, `049de4d` | Busca por `moeda` e `currency` retornou somente moeda; ícone personalizado foi salvo e continuou visível depois de alterar o tipo e reabrir (`schemaSaved`, `markdownHasTypeAndIcon`, `typeIsCurrencyAfterReopen`, `iconRendersAfterReopen`). | Passou — grupo 3. |
| 8 | Formatação condicional — #38 | `c359e19` | Regra `Valor >= 200`, cor `#3157C8`, diagnóstico vazio; valores 200/300 coloridos e 100 sem cor; regra persistida e observada após reabrir (`markdownStoresRule`, `reopenedRuleStillColorsOnlyMatches`). | Passou — grupo 2. |
| 9 | Visualizações vinculadas — #29 | `c359e19` | Nomes, filtros Alfa/Beta e recolhimento independente foram salvos; origem listou os dois locais de vínculo; navegação e reabertura mantiveram os estados (`searchProducedOneRowPerView`, `collapsedStateIndependent`, `sourceLinkMapSaved`). | Passou — grupo 2. |
| 10 | Filtros e mapa de visualizações — #28/#29 | `c359e19` | Filtro rápido temporário, reset e menu de opções verificados; buscas, nomes e recolhimentos independentes persistidos. | Passou — grupos 2. |
| 11 | Localização e backlinks de views — #29 | `c359e19` | Banco de origem enumerou ambos os blocos vinculados; abrir o vínculo levou à página `Painel sintético`; mapa persistido foi conferido após reabrir. | Passou — grupo 2. |
| 12 | Cálculos independentes no rodapé — #39 | `c359e19` | Soma 600, contagem 3 e máximo 300 exibidos em views distintas; configurações independentes salvas e lidas após reabrir (`distinctViewSummariesSaved`, `configurationsIndependent`). | Passou — grupo 2. |
| 13 | Até sete colunas de conteúdo — #40 | `f0a8146` | Arraste criou a sétima coluna; tentativa de oitava foi recusada; estrutura e conteúdo sobreviveram à reabertura (`createdSeventhByDrag`, `rejectedEighthByDrag`, `markdownHasSevenColumns`, `reopenedSevenColumns`, `contentsPreserved`). | Passou — grupo 1. |
| 14 | Limpar e desfazer intervalo de células — #33 | `6c79867` | Seleção retangular, limpeza em lote, desfazer, copiar/colar e rejeição de mutação em coluna protegida (`rectangularSelectionVerified`, `batchClearVerified`, `batchUndoVerified`, `readOnlyMutationProtectionVerified`). | Passou — grupo 4. |
| 15 | Seleção, menu, copiar/mover linhas — #35/#36 | `d3ee63e` | Seleção filtrada/triestado, teclado, ações do menu, journal, duplicação, clipboard completo, mapeamentos, destino vazio, novos IDs, undo e persistência (`filteredSelectionClearsWhenVisibleRowsChange`, `visibleSelectAllAndTriStateVerified`, `recoveryJournalReadyBeforeNextActionVerified`, `fullRowClipboardVerified`, `destinationChangeRecomputesMappings`, `copyToEmptyAndPersistenceVerified`, `movePreservesSourceAndUndoVerified`). | Passou — grupo 5, 16.476 ms; evidência nova em `interaction-expansion-delivery5-ui.json`. |
| 16 | Ícones de propriedade e seleção de tipo — #37 | `443f3db`, `049de4d` | Escolha do ícone e salvamento Markdown; busca PT/EN restrita a moeda; ícone preservado na troca e reabertura (`iconRendersAfterReopen`, `markdownHasTypeAndIcon`). | Passou — grupo 3. |
| 17 | Menus e sugestões de campos relacionados — #26/#41 | `f0a8146`, `443f3db`, `049de4d` | Menus testados em duas larguras; `ArrowDown` ativou `Livros escritos`; Tab/Enter inseriram a referência, mantiveram o caret no fim e persistiram o binding `propertyId: books` (`caretVerifiedForTabAndEnter`, `selectedPropertyBindingPersisted`, `formulaSaved`, `relationPropertyBindingReopened`). | Passou — grupos 1 e 3. |
| 18 | Formatação de resultado de fórmula — #42 | `443f3db`, `049de4d` | Resultado monetário BRL/pt-BR mostrou `R$ 150,50`; zero permaneceu visível; checkbox `false` acessível/desmarcado foi distinto do resultado nulo “Vazio” (`formulaExpressionPreserved`, `zeroAndFalseRemainDistinct`). | Passou — grupo 3. |
| 19 | Relação inversa com prévia de união — #43 | `443f3db` | Prévia contou pares existentes e novos; relação proprietária e metadados inversos foram salvos; livros projetados e metadados sobreviveram à reabertura (`previewCountedExistingPairs`, `ownerRelationPersisted`, `targetMarkedAsInverse`, `relationMetadataReopened`). | Passou — grupo 3. |
| 20 | Seletor pesquisável e ícone de propriedade — #37 | `443f3db`, `049de4d` | Busca por alias PT/EN, seleção de moeda, ícone personalizado e round-trip de tipo/ícone verificados. | Passou — grupo 3. |

## Integração de #44

A etapa integrada passou na rodada de `2026-10-28T08:57:25.223Z`: About em EN/ES/PT,
nota sintética editada/desfeita/reaberta, sete colunas, imagem, seção recolhível,
duas views filtradas de modo independente, PDF e tabela de escala. PDF: 3 páginas,
211.390 bytes, uma imagem incorporada e sete sentinelas de texto verdadeiras.
Previews renderizados e inspecionados: [página 1](interaction-expansion-final-page1.png),
[página 2](interaction-expansion-final-page2.png) e
[página 3](interaction-expansion-final-page3.png). O PDF inclui controles da
interface e divide as duas views entre páginas 2 e 3; não houve mudança de produto
para alterar a impressão.

Escala sintética: 1.000 linhas renderizadas em 659 ms; filtro em 494 ms; seleção
de 1.000 células em 536 ms; colagem de 1.000 valores pela interface em 212 ms;
gravações iniciais/undo/redo levaram 13.008/11.856/11.864 ms (13,01/11,86/11,86 s);
desfazer e refazer na UI levaram 223/256 ms; tentativa de 1.001 células foi
recusada em 233 ms sem alteração parcial; reabertura e conferência dos valores
1, 500 e 1.000 levaram 1.434 ms (1,43 s). Janela oculta, zero erros do renderer
e cleanup do perfil temporário foram verificados.

## Limitações e próximos passos

- O harness final passou em todos os grupos e na integração, e Sol aprovou a
  validação local de #44 sem bloqueios. Neste checkpoint, ainda não havia CI após
  a correção local de locale; consulte as issues #25/#44 no GitHub para o estado
  posterior.
- A ocorrência histórica do grupo 2 com `0xC0000409` não foi reproduzida na
  execução standalone nem nas rodadas unificadas subsequentes; sua causa segue
  desconhecida. O timeout histórico do grupo 5 também não se reproduziu na
  execução diagnóstica standalone ou na rodada final, mas sua causa continua
  indeterminada. Ver
  [`interaction-expansion-harness-native-exit-2026-10-28.md`](interaction-expansion-harness-native-exit-2026-10-28.md).
- Neste checkpoint, CI não havia sido executado após a correção local de locale;
  o workflow observado falhou antes dela. Consulte as issues #25/#44 no GitHub
  para o estado posterior de CI.
- As latências de gravação de aproximadamente 12 s são observações reais e devem
  ser interpretadas como tais.
- Neste checkpoint, #25 e #44 estavam abertas. O estado atual do encerramento
  deve ser consultado nas issues #25/#44 no GitHub.
