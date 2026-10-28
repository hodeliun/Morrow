# Verificação da UI das entregas anteriores

**Estado: completo.** Os três grupos passaram. Os grupos 1 e 2 cobriram o bundle integrado com a correção de mídia; o grupo 3 passou no bundle final com as correções de seleção de fórmula e checkbox `false`. Cada rodada manteve o fingerprint estável, permaneceu oculta e não registrou erro de renderer.

## Método

- Cada ticket usou um perfil e vault sintéticos isolados. Nenhum vault pessoal foi aberto.
- A aplicação foi iniciada com `MORROW_HIDDEN=1`; as verificações confirmaram zero janelas Electron visíveis durante os fluxos e reaberturas.
- Os fluxos exercitaram controles reais da interface e, quando previsto, conferiram Markdown e o estado após reabrir.
- Os scripts não alteraram código de produto. Esta verificação não executou build, `npm run check`, commit ou push.
- O bundle foi identificado antes e depois de cada lançamento; uma rodada só conta como estável quando os arquivos permanecem iguais durante todos os lançamentos.
- Os JSONs e fixtures permanecem isolados em diretórios temporários locais (`Temp/morrow-delivery*-ui-*`). Este documento não registra caminhos absolutos de perfil nem de vault pessoal.

## Identidade dos bundles integrados verificados

- **Grupos 1 e 2:** `dist-electron/main.cjs` mtime `2026-10-28T07:07:01.423Z`; renderer com 197 assets; SHA-256 do manifesto `7992fac4fdf1a8cb18fe706bcab53f01bcbd692b6919da181aa28f0d8bff7344`. Inclui a correção de eventos da barra de corte que foi exercitada por #30.
- **Grupo 3 final:** `dist-electron/main.cjs` mtime `2026-10-28T07:14:00.185Z`; renderer com 197 assets; SHA-256 do manifesto `17021348571483cb0c93f0e002ea32ac2350de1ffe830c88eecbf6b95575f6de`.
- Cada rodada registrou identidade igual antes e depois dos lançamentos.
- Os registros JSON têm nomes `evidence-delivery*.json` e ficam junto das fixtures sintéticas nos diretórios temporários acima.

## Resultado por ticket

| Ticket | Resultado atual | Evidência observada |
| --- | --- | --- |
| #26 | Passou | Menus e painéis permaneceram dentro da viewport em 1600×1000 e 800×600. |
| #27 | Passou | Cor personalizada `#13579B` apareceu e sobreviveu ao salvamento e à reabertura. |
| #28 | Passou | Filtro rápido reduziu as linhas e o reset restaurou os resultados; permaneceu temporário. |
| #29 | Passou | Duas visualizações vinculadas mantiveram buscas e recolhimentos independentes após reabrir. |
| #30 | Passou | No bundle do grupo 1, corte e Markdown foram aplicados; cancelar uma substituição preservou o corte; uma substituta com proporção diferente atualizou a imagem na sessão, limpou o corte incompatível e preservou legenda/alinhamento. A imagem substituta (200×400) e o estado sobreviveram à reabertura; o arquivo original permaneceu intacto. Sem erros de renderer. |
| #31 | Passou | Recolher e expandir a seção preservou o conteúdo e o estado recolhido após reabrir. |
| #37 | Passou | No grupo 3 final, o seletor de emoji abriu; o ícone “grinning face” foi salvo e continuou visível depois de mudar o tipo para moeda e reabrir. As buscas por `moeda` e `currency` encontraram “Moeda”. |
| #38 | Passou | A formatação condicional coloriu somente os valores correspondentes e manteve o resultado após reabrir. |
| #39 | Passou | Soma, contagem e máximo foram exibidos por visualização e permaneceram independentes após reabrir. |
| #40 | Passou | Arrastar um bloco criou a sétima coluna; tentar a oitava foi recusado. As sete colunas couberam em 800×600 e conteúdo e estrutura sobreviveram à reabertura. |
| #41 | Passou | `ArrowDown` ativou a segunda sugestão (`Livros escritos`). Tab e Enter inseriram ``Autor.`Livros escritos``, mantiveram o caret no índice 23 e consumiram os eventos. O binding `propertyId: books` foi salvo e o token reapareceu após reabrir. |
| #42 | Passou | A moeda BRL/pt-BR com duas casas mostrou `R$ 150,50`; zero permaneceu `0`. `false` apareceu como checkbox acessível desmarcado (`aria-checked=false`), com ícone de 12×12 px e contraste medido de 6,76:1. A fórmula `null` mostrou “Vazio” sem checkbox, distinta do falso; todos os estados persistiram após reabrir. |
| #43 | Passou | A união da relação inversa mostrou os pares existentes e os novos; metadados e projeção de livros permaneceram corretos após reabrir. |

## Execuções

- **Grupo 1 — 2026-10-28 07:08:29 UTC**, HEAD `6c79867`, bundle com mtime `07:07:01.423 UTC` e manifesto SHA-256 `7992fac4…f7344`: #26, #27, #30, #31 e #40 passaram, incluindo reaberturas aplicáveis. Janelas ocultas, zero erros de página e identidade estável. Evidência: `Temp/morrow-delivery1-ui-tekEyR/evidence-delivery1.json`.
- **Grupo 2 — 2026-10-28 07:09:39 UTC**, HEAD `6c79867`, mesmo bundle e fingerprint: #28, #29, #38 e #39 passaram, incluindo reaberturas aplicáveis. Janelas ocultas, zero erros de página e identidade estável. Evidência: `Temp/morrow-delivery2-ui-21Xy4Z/evidence-delivery2.json`.
- **Grupo 3 final — 2026-10-28 07:17:57 UTC**, HEAD `6c79867`, bundle com mtime `07:14:00.185 UTC` e manifesto SHA-256 `17021348…f6de`: #37, #41, #42 e #43 passaram, incluindo reaberturas. Janelas ocultas, zero erros de página e identidade estável. Evidência: `Temp/morrow-delivery3-ui-bFX36g/evidence-delivery3.json`.
- A execução anterior do grupo 3 no bundle antigo registrou falhas em #37/#41/#42; ela foi substituída pela execução final acima. O diagnóstico da primeira repetição final também confirmou que o checkbox falso já estava renderizado; o verificador foi ajustado para medir estado ARIA, visibilidade, dimensões, contraste e distinção em relação ao resultado nulo.
- Os relatórios completos preservam a identidade dos arquivos compilados antes/depois de cada lançamento e guardam stack e etapa do fluxo para erros de renderer. Uma execução que atravesse uma reconstrução não conta como estável.

## Encerramento

Os três grupos foram verificados e todos os tickets listados passaram. O fingerprint final do grupo 3 e os relatórios individuais permitem revisar os fluxos, os estados reabertos e a ausência de erros de renderer. Não foi executado build nem `npm run check` nesta tarefa.

Scripts da verificação: `scripts/verify-delivery1-ui.cjs`, `scripts/verify-delivery2-ui.cjs`, `scripts/verify-delivery3-ui.cjs` e `scripts/verify-prior-deliveries-ui.cjs`.
