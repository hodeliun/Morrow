# Execução e validação — expansão de interação

**Checkpoint documental:** validação local pré-publicação em 28/10/2026. O
resultado da revisão Sol foi aprovado sem bloqueios para a validação local de
#44. O estado posterior da CI e o encerramento atual de #25/#44 são os registrados
no GitHub; as issues #25 e #44 são a fonte autoritativa e prevalecem sobre este
snapshot.

## Autorização e estado do tracker

Em 28/10/2026, Carlos autorizou a continuação da execução com GPT-6 Luna max como
executor e GPT-6.1 Sol medium como revisor. A autorização substitui a pausa de
planejamento registrada nos tickets; não recriar spec ou tickets. Na consulta de
estado ao GitHub deste checkpoint, #26–#43 estavam encerrados; #25 e #44 estavam
abertos. A revisão Sol aprovou a validação local final de #44 sem bloqueios. Este
registro não determina o estado posterior das issues.

O branch observado é `work/interaction-expansion-2026-10`, HEAD
`d3ee63ecdfbb8f345e8bd4b81354ecec0af7855c` (`d3ee63e`). Esse é o commit da
entrega 5, também apontado por `origin/main`. Não houve commit, push, publicação
ou instalação ao fim desta execução. O bump local preparatório é
`1.2.1-fork.1.1.0`, sobre a base oficial `1.2.1` no commit
`5e6392bb6425924abd30eec8a99b42aa8c953577`.

## Entregas publicadas

| Entrega | Issues | Commit | Escopo |
|---|---|---|---|
| 1 | #26, #27, #30, #31, #40 | `f0a8146` | Menus dentro da viewport, fundos de bloco, imagens, seções recolhíveis e até sete colunas de conteúdo. |
| 2 | #28, #29, #38, #39 | `c359e19` | Opções e filtros compactos, visualizações vinculadas, formatação condicional e cálculos por coluna. |
| 3 | #37, #41, #42, #43 | `443f3db` | Tipos/ícones de propriedades, tokens e sugestões de fórmula, formato de resultados e relações inversas. |
| Correções de revisão | — | `049de4d` | Controles de imagem, ícones de propriedade, autocomplete, editor de fórmulas e apresentação de `false`; verificação de UI das entregas 1–3. |
| 4 | #32–#34 | `6c79867` | Foco e edição de células, seleção/clipboard de intervalos e preenchimento. |
| 5 | #35–#36 | `d3ee63e` | Seleção/operações de linhas, transferência com mapeamento e journal recuperável. |

Os estados do GitHub são autoridade. O snapshot `docs/issues.json` não substitui
uma consulta atualizada.

## `npm run check` e CI

`npm run check` passou localmente após a correção do teste de locale: 57 arquivos
de teste, 440 testes, typecheck, lint e builds do renderer, Electron e MCP. A
correção local de `DatabaseView.test.ts` evita assumir rótulos portugueses no
ambiente inglês.

O workflow CI `40655699585` no HEAD `d3ee63e` falhou em
`DatabaseView.test.ts:103` porque o teste esperava texto PT enquanto o ambiente
estava em EN. No checkpoint pré-publicação, a correção local ainda não havia sido
submetida nem executada pelo CI; a aprovação Sol cobre a validação local, não CI.
Consulte as issues #25/#44 no GitHub para o estado posterior da CI.

## Execução unificada final

O harness `scripts/verify-interaction-final-ui.cjs` executou os cinco grupos em
em série e depois a integração, com fonte e bundle estáveis durante toda a
rodada. Concluiu em `2026-10-28T08:57:25.223Z`, no HEAD `d3ee63e`; hash da fonte
`26042ea846af5adddd5c6f1ca0877b71d54561fcfac549c968eaff0ecd10797e`, com 261
arquivos. O bundle teve SHA-256
`797e55782b2c7d2fb0a9a0bbaf4ed0986b2577bdb5222a6a094dd323a0889dfb`, com 3.599
arquivos. O relatório completo é
[`docs/evidence/interaction-expansion-final-ui.json`](../../evidence/interaction-expansion-final-ui.json).

| Grupo | Resultado nesta rodada | Observação |
|---|---|---|
| 1 | Passou, 22.517 ms | #26, #27, #30, #31, #40; janela oculta, zero erros do renderer, bundle estável. Fixtures sintéticas retidas em `%TEMP%`, conforme o harness. |
| 2 | Passou, 17.476 ms | #28, #29, #38, #39; janela oculta, zero erros do renderer, bundle estável. Fixtures sintéticas retidas em `%TEMP%`. |
| 3 | Passou, 18.684 ms | #37, #41, #42, #43; janela oculta, zero erros do renderer, bundle estável. Fixtures sintéticas retidas em `%TEMP%`. |
| 4 | Passou, 17.358 ms | #32–#34; seletores atualizados para `data-col-id`, janela oculta, zero erros do renderer, bundle estável e perfil temporário removido. |
| 5 | Passou, 16.476 ms | #35/#36; todas as asserções, janela oculta, zero erros do renderer, bundle estável e perfil temporário removido. |

A falha histórica de timeout no grupo 5 foi seguida por uma execução diagnóstica
standalone e esta rodada completa, ambas aprovadas. A causa do timeout anterior
permanece indeterminada; ele não se reproduziu. A evidência atual dos tickets
#35/#36 foi gravada em
[`docs/evidence/interaction-expansion-delivery5-ui.json`](../../evidence/interaction-expansion-delivery5-ui.json).

## Investigação de encerramento nativo no grupo 2

Uma tentativa unificada anterior encerrou o processo Node com `0xC0000409`
(`3221226505`) após `PASS reopen #38`, antes de #39. O `stderr` era vazio e a
causa permanece indeterminada. A execução standalone posterior de
`node scripts/verify-delivery2-ui.cjs` passou #28, #29, #38 e #39, com zero erros
do renderer e bundle idêntico antes/depois. A falha não se reproduziu nessa
execução; não atribuir causa ao produto. O diagnóstico, incluindo a limpeza dos
processos órfãos exatos, está em
[`docs/evidence/interaction-expansion-harness-native-exit-2026-10-28.md`](../../evidence/interaction-expansion-harness-native-exit-2026-10-28.md).

Na execução unificada final, o grupo 2 também passou normalmente.

## Integração isolada e escala sintética

A etapa integrada passou no modo isolado e também passou dentro da execução
unificada mais recente. Não abriu vault pessoal, manteve todas as janelas ocultas,
registrou zero erros do renderer e removeu o perfil/cofre/PDF temporários. O
About mostrou base `1.2.1`, fork `1.1.0`, pacote
`1.2.1-fork.1.1.0` e revisão oficial `5e6392b` em EN/ES/PT.

A nota sintética foi editada, desfeita e reaberta com sete colunas, imagem,
legenda, seção recolhível persistida e duas visualizações vinculadas com filtros
independentes. O PDF sintético teve 3 páginas, 211.390 bytes, uma imagem
incorporada e passou as 7 sentinelas de extração de texto. Os previews Poppler
de todas as páginas estão em `docs/evidence/interaction-expansion-final-page1.png`,
`...-page2.png` e `...-page3.png`. As páginas foram inspecionadas: a imagem e a
legenda, além da primeira visualização, aparecem na página 2; a segunda
visualização continua na página 3. O PDF imprime controles da interface e divide
visualizações entre páginas; essa limitação visual foi registrada, sem alteração
de produto nesta tarefa.

| Operação na tabela de 1.000 linhas | Resultado observado |
|---|---:|
| Renderizar 1.000 linhas | 659 ms |
| Filtrar para uma linha | 494 ms |
| Selecionar 1.000 células | 536 ms |
| Colar 1.000 valores pela interface | 212 ms |
| Persistir primeira colagem | 13.008 ms (13,01 s) |
| Desfazer após persistir | 223 ms; persistência do undo: 11.856 ms (11,86 s) |
| Refazer | 256 ms; persistência: 11.864 ms (11,86 s) |
| Recusar colagem de 1.001 células | 233 ms, sem alteração parcial |
| Reabrir e conferir valores 1, 500 e 1.000 | 1.434 ms (1,43 s) |

As latências de persistência de aproximadamente 11,8–13,0 s são observadas, não
estimativas nem alegações de gravação instantânea. A rodada verificou os 1.000
valores no arquivo e depois da reabertura.

## Documentação e estado de conclusão

- A spec foi atualizada para registrar a autorização de 28/10 e a permanência dos
  limites de publicação/instalação e alteração de vaults.
- O changelog registra as entregas e a versão local ainda não lançada.
- `docs/evidence/interaction-expansion-final.md` contém a matriz de 20 itens,
  tickets, commits e asserções observadas.
- Nenhum instalador foi executado; não houve commit, push ou alteração de issues.
- Neste checkpoint, #25 e #44 estavam abertas; a revisão Sol aprovou a validação
  local de #44 sem bloqueios. O harness unificado final passou. O workflow
  `40655699585` havia falhado antes da correção local de locale, sem execução após
  a correção registrada neste snapshot. Consulte as issues #25/#44 no GitHub para
  os estados atuais de revisão, CI e encerramento.
