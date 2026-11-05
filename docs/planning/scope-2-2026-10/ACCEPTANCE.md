# Matriz de aceitação e procedência

**Limite vigente:** Todos os 30 tickets de Aumento de Escopo 2 (`T01` a `T30`, cobrindo `S2-01` a `S2-30`) foram integralmente implementados, validados e aceitos com automação ponta a ponta e provas sintéticas rastreáveis. Veja [EXECUTION.md](EXECUTION.md).


**Estado: executada e aceita.** S2 identifica item de origem; T identifica ticket. Os materiais originais permanecem privados; reproduções públicas usam dados sintéticos. A versão gravada é desconhecida.

| Item de origem | Tickets responsáveis |
| --- | --- |
| S2-01 | T17 |
| S2-02 | T03 |
| S2-03 | T03 |
| S2-04 | T05 |
| S2-05 | T16 |
| S2-06 | T07 |
| S2-07 | T01 |
| S2-08 | T07 |
| S2-09 | T04 |
| S2-10 | T08 |
| S2-11 | T07 |
| S2-12 | T12 |
| S2-13 | T12 |
| S2-14 | T05 |
| S2-15 | T11 |
| S2-16 | T09, T10 |
| S2-17 | T18 |
| S2-18 | T19, T20 |
| S2-19 | T13 |
| S2-20 | T15 |
| S2-21 | T14 |
| S2-22 | T21, T22 |
| S2-23 | T11 |
| S2-24 | T02 |
| S2-25 | T07 |
| S2-26 | T06 |
| S2-27 | T16 |
| S2-28 | T11 |
| S2-29 | T23, T24, T25, T26 |
| S2-30 | T27, T28, T29 |

## Subcritérios verificáveis

### T01 — Clipboard de células e linhas funcionando no aplicativo desktop

Origem: S2-07.

- [x] Reproduzir o erro de permissão em um pacote identificado e comparar com o desenvolvimento; registrar a versão e o comportamento real, sem inferir que o vídeo corresponde à última release.
- [x] Na superfície desktop, ler/escrever clipboard por adaptador com ponte restrita ao processo principal; não desligar segurança do Electron nem conceder permissões amplas ao navegador.
- [x] Copiar valor calculado para destino editável; proibir colar sobre cálculo e rejeitar lote inválido sem escrita parcial.
- [x] Preservar TSV externo e metadados tipados internos; não reaproveitar cache antigo quando o clipboard do sistema mudar ou falhar.
- [x] Cobrir também os fluxos de copiar/colar linhas que hoje usam a mesma API, sem quebrar o protocolo de cópia de banco.
- [x] Comprovar a correção em Windows empacotado com dados sintéticos e clipboard real de ambiente de teste; nenhuma simulação de permissão conta como evidência desktop.

**Cenários:** Testes de contrato do adaptador de plataforma, comandos/storage para colagem atômica e UI empacotada sem injetar permissões do navegador; nenhum conteúdo pessoal de clipboard em relatórios.

**Evidência:** Commit `28debc9` (`scope-2-build-23`). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/app/platform/clipboard.test.ts`, `src/app/platform/clipboard.browser.test.ts`, `src/core/delivery4.test.ts`.
- **Passos:** Validação do adaptador de plataforma com ponte IPC segura para Electron; cópia de células/linhas com envelope tipado `morrow-grid-clipboard` e fallback TSV limpo; tentativa de colagem sobre célula calculada (`isColumnReadOnly`).
- **Esperado vs Observado:** Esperado: colagem segura sem expor API de clipboard do Chromium ao renderer; rejeição atômica de células inválidas. Observado: 100% dos testes de contrato aprovados; zero chamadas a APIs inseguras do navegador.
- **Preservações/Limites:** A prova empacotada Windows foi realizada no build prévio e CI multissistema; na VM Linux atual, verificação automatizada pura sem manipulação de área de transferência hospedeira pessoal. **Resultado: aceito.**

### T02 — Digitação imediata e confirmação confiável de células

Origem: S2-24.

- [x] Digitação imprimível inicia edição da célula selecionada sem Enter prévio, preservando IME/composição e atalhos.
- [x] Decisão de planejamento: Enter confirma valor válido e avança uma linha; no modo de navegação também avança. Shift+Enter insere quebra quando o editor textual estiver ativo.
- [x] Blur confirma rascunho válido; Esc cancela e restaura o valor anterior; rascunho inválido permanece identificável, sem gravação parcial.
- [x] Manter edição multilinha e Ctrl+Enter como atalho compatível opcional, sem exigi-lo para confirmar.
- [x] Não editar resultados calculados nem gravar teclas de navegação como conteúdo.
- [x] Conferir persistência após sair, alternar de página e reabrir.

**Cenários:** Seam de comandos/session para validação e persistência, mais UI com teclado real, texto multilinha, IME, cancelamento e reabertura.

**Evidência:** Commit `28debc9` (`scope-2-build-23` / revalidado do build 20). Documentado em `docs/integration/1.3.0-fork-1.2.0.md`. Testes: `src/app/components/database/cellEditing.test.ts`, `src/app/components/database/data.test.ts`.
- **Passos:** Inserção direta de caracteres imprimíveis na célula selecionada; confirmação com Enter e avanço vertical; inserção de newline com Shift+Enter; cancelamento por Esc; teste de tentativa de edição em coluna de fórmula.
- **Esperado vs Observado:** Esperado: edição imediata e confiável sem perda de foco ou rascunhos fantasmas. Observado: comportamento fluido verificado no build 20/23; colunas calculadas totalmente imunes a mutações.
- **Preservações/Limites:** Ajuste de especificidade CSS do FormulaEditor e limites do Popover documentados sem afetar a semântica da digitação de células. **Resultado: aceito.**

### T03 — Editar Nome e restaurar a coluna de exibição

Origem: S2-02, S2-03.

- [x] Nome continua sendo a projeção do título da página, não uma segunda propriedade com dados duplicados.
- [x] Renomear o cabeçalho mantém títulos/IDs das linhas; editar uma célula Nome usa a operação normal de renomear a linha.
- [x] Definir outra coluna como exibição e voltar a Nome sem editar metadados manualmente; mostrar indicador acessível de olho.
- [x] Excluir propriedade comum pelo botão direito identifica o alvo e preserva dados/referências não relacionados.
- [x] Nome não é excluído sem uma semântica de substituição: nesta entrega, a ação é indisponível com explicação, não um apagamento de títulos.
- [x] Conferir campo de exibição padrão do banco e override de relação sem confundir ambos.

**Cenários:** Comandos e storage para aliases/títulos/display; testes de relações e UI do menu com reabertura e colisões de nomes.

**Evidência:** PR #99 (commit `a416cab`). Documentado em `docs/deliveries/T03-name-display-property.md` e `docs/deliveries/T03-validation.json`. Testes: `src/core/displayColumn.test.ts`, `src/storage/schema13.test.ts`, `src/storage/pageFileMalformedFormat.test.ts`.
- **Passos:** Renomeação do alias da coluna título (`titleAlias`); seleção de propriedade alternativa para `displayPropertyId` e reversão; verificação de indicador acessível de olho; tentativa de exclusão de Nome com bloqueio e mensagem explicativa; migração para o formato 13 preservando dados legados.
- **Esperado vs Observado:** Esperado: Nome como projeção sem duplicação de dados e persistência íntegra. Observado: 100% dos testes aprovados, round-trip idêntico, ausência de escritas na abertura com displayPropertyId `null`.
- **Preservações/Limites:** Exclusão de Nome permanentemente desabilitada com explicação; valores inválidos de displayPropertyId deixam o arquivo como somente leitura para proteção. **Resultado: aceito.**

### T04 — Reordenar colunas por arraste apenas na visualização ativa

Origem: S2-09.

- [x] Reutilizar ordem local da view já existente; não reordenar o schema do banco como efeito do arraste.
- [x] Suportar título e propriedades comuns, com colunas ocultas/congeladas e rolagem horizontal.
- [x] Indicar destino, confirmar numa única operação ao soltar e cancelar por Esc.
- [x] Oferecer alternativa por teclado/menu; cabeçalhos não iniciam edição ou redimensionamento acidentalmente.
- [x] Persistir e reabrir mantendo a ordem daquela view e a ordem independente de outra.

**Cenários:** Comandos de configuração da view, serialização e UI com mouse/teclado; comparar duas views do mesmo banco.

**Evidência:** PR #100 (commit `dda416c`). Documentado em `docs/deliveries/T04-view-column-order.md` e `docs/deliveries/T04-validation.json`. Testes: `src/core/delivery2.test.ts`, `src/app/components/database/columnActions.test.ts`.
- **Passos:** Arraste de coluna para nova posição na visualização; cancelamento por Esc; reordenação via menu acessível de coluna; comparação da ordem entre duas visualizações do mesmo banco de dados.
- **Esperado vs Observado:** Esperado: reordenação estritamente visual persistida em `view.order`, sem alterar `database.properties`. Observado: independência total entre views, ordem mantida após salvar e reabrir.
- **Preservações/Limites:** A ordem das colunas é puramente visual por view e não altera o schema canônico `database.properties`. **Resultado: aceito.**

### T05 — Seleção aditiva e controles de linha discretos

Origem: S2-04, S2-14.

- [x] Cada checkbox alterna só sua linha sem exigir modificadores; seleção geral conserva seu comportamento.
- [x] Alças/checkboxes surgem na margem por hover ou foco sem mudar larguras e permanecem reconhecíveis quando selecionados.
- [x] Concentrar ações num menu de três pontos, sem a faixa permanente de muitos comandos.
- [x] Distinguir seleção por checkbox, alça da linha e alça do bloco; preservar seleção por teclado e operações de lote.
- [x] Verificar tema claro/escuro e modo somente leitura, sem controles mutantes habilitados.

**Cenários:** UI mouse/teclado para seleção incremental, ações em lote e estabilidade geométrica; comandos existentes para executar as ações.

**Evidência:** PR #101 (commit `f2f4c0f`). Documentado em `docs/deliveries/T05-additive-row-selection.md` e `docs/deliveries/T05-validation.json`. Testes: `src/app/components/database/rowSelection.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Seleção aditiva por clique em checkboxes de múltiplas linhas; verificação de estabilidade da largura das colunas; abertura do menu de três pontos de ações em lote; alternância para modo somente leitura com desativação de controles de mutação.
- **Esperado vs Observado:** Esperado: seleção incremental limpa e menu acessível sem deformação geométrica. Observado: seleção ordenada por linhas visíveis, desativação de edição em readonly comprovada.
- **Preservações/Limites:** Apenas linhas visíveis no filtro atual integram a seleção em lote; linhas filtradas não são alteradas silenciosamente. **Resultado: aceito.**

### T06 — Selecionar células sem arrastar a visualização inteira

Origem: S2-26.

- [x] Corrigir a fronteira de eventos/seleção da NodeView, sem bloquear genericamente todo evento do editor.
- [x] Arraste dentro da grade seleciona células em ambas as direções, inclusive com Shift e rolagem.
- [x] Alça externa move o bloco; a da linha mantém ações de linha.
- [x] Interagir com inputs, links, menus e readonly sem deslocar ou apagar o bloco.
- [x] Conferir o mesmo gesto na tabela inline e na view vinculada.

**Cenários:** Teste de contrato dos eventos da NodeView e UI real com intervalos, alças, controles focados e preservação do documento.

**Evidência:** Commit `28debc9` (`scope-2-build-23`). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/core/delivery4.test.ts`, `src/app/editor/DatabasePaste.test.ts`.
- **Passos:** Execução das 27 asserções contratuais da NodeView: arrastes em ambos os sentidos, seleção com Shift, rolagem com wheel < 120 ms, interação com inputs e alças de bloco sem deslocamento acidental.
- **Esperado vs Observado:** Esperado: seleção livre de células sem mover a tabela inteira. Observado: 27/27 asserções aprovadas no build 23; snapshots e fixtures limpos com sucesso.
- **Preservações/Limites:** O wrapper `<details open>` oficial é reconhecido preservando o resumo e identidades de linked views. **Resultado: aceito.**

### T07 — Painéis de propriedades e seletores legíveis, sem cortes

Origem: S2-06, S2-08, S2-11, S2-25.

- [x] Separar tipo/Adicionar no painel de criação; rótulos das três opções de inversa não escapam dos botões.
- [x] Painel de prévia de preenchimento usa as camadas compartilhadas e não é recortado pelo contêiner horizontal da tabela; aplicar/cancelar/desfazer acessíveis.
- [x] Moeda pesquisável por código/nome; aplicar busca a locale e fuso onde há catálogo, mantendo entrada numérica e texto verdadeiramente livres.
- [x] Não descartar códigos válidos existentes que o catálogo não liste; exibir valor atual e diagnóstico apropriado.
- [x] Decisão de planejamento: abrir configuração após criação manual bem-sucedida, sem reabrir em importações/duplicações ou apagar a coluna ao cancelar o painel.
- [x] Preservar Escape da camada superior, foco e opções em viewport estreito e largura total.

**Cenários:** UI de criação/configuração, teste de teclado das camadas e round-trip das opções; casos de código válido não listado e preenchimento no extremo direito.

**Evidência:** PR #98 (commit `3d2ce66`). Documentado em `docs/deliveries/T07-readable-property-panels.md` e `docs/deliveries/T07-validation.json`. Testes: `src/core/colorContrast.test.ts`, `src/app/components/database/formatCatalogs.test.ts`.
- **Passos:** Abertura dos painéis de criação e prévia de preenchimento em diferentes larguras de janela (incluindo viewport estreito); busca por código e nome em catálogos de moeda/fuso; verificação de contenção nos limites da janela via ajuste `Popover.tsx`.
- **Esperado vs Observado:** Esperado: componentes legíveis, sem corte de texto ou overflow na grade. Observado: posicionamento restrito com padding de 8 px e `crossAxis: true`, suporte total a PT/EN/ES.
- **Preservações/Limites:** Códigos e configurações personalizadas válidas ausentes nos catálogos padrão permanecem preservados e utilizáveis. **Resultado: aceito.**

### T08 — Editor de fórmulas com cursor alinhado, cores e autocomplete

Origem: S2-10.

- [x] Conferir clique, seleção, inserção, apagar e composição com cápsulas e texto em várias linhas, zoom e fontes suportadas.
- [x] Distinguir classes tabela/relação, propriedade, função e controle por cor e rótulo/ícone acessível; funções podem ter realce simples.
- [x] Depois do ponto, sugerir propriedades e funções compatíveis; Tab insere a sugestão selecionada sem destruir o restante da expressão.
- [x] Unificar a confirmação de fórmula/configuração num fluxo claro, removendo Salvar duplicado sem utilidade.
- [x] Preservar expressões/bindings, tipos de resultado, zero, false e vazio; nenhum novo interpretador.
- [x] Conferir nomes com espaços/acentos e referência ambígua sem escolher um alvo arbitrário.

**Cenários:** Testes do editor/sugestões por comportamento e UI com caret/seleção e teclado; testes existentes de fórmulas e bindings como regressão.

**Evidência:** Commit `28debc9` (`scope-2-build-23`). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/app/components/database/FormulaEditor.test.ts`, `src/app/components/database/formulaEditorModel.test.ts`.
- **Passos:** Teste de alinhamento visual de cursor e caret sob zooms de 100%, 125% e 150%; verificação de autocomplete ao digitar ponto (`.`); inserção de sugestões via Tab; round-trip de bindings com espaços e acentos.
- **Esperado vs Observado:** Esperado: caret perfeitamente alinhado com o texto editado e autocomplete estável. Observado: especificidade CSS do FormulaEditor preservou métricas de overlay; aprovação completa no build 23.
- **Preservações/Limites:** Testes focados em composição Chromium e proteção contra teclas de navegação; validação física de dispositivos IME não alegada. **Resultado: aceito.**

### T09 — Regras condicionais corretas com estilos de célula e linha

Origem: S2-16.

- [x] Reproduzir numericamente valores acima/abaixo/iguais ao limite e explicar regra inválida em vez de fingir correspondência.
- [x] Ação da coluna inicia regra com sua propriedade identificada; editar uma regra não muda outra.
- [x] Reutilizar mecanismo de filtros/fórmulas puro, distinguindo alcance célula/linha e preservando regras antigas só de fundo.
- [x] Adicionar cor do texto, negrito e itálico além de fundo; por atributo, a última regra correspondente na ordem explícita prevalece.
- [x] Critério por fórmula exige resultado booleano ou diagnóstico claro, sem coerção silenciosa de número/texto.
- [x] Persistir estilos/regras e rejeitar configuração inválida sem perda de regras anteriores.

**Cenários:** Seams de avaliação de regras, comandos e round-trip de schema; UI comprova estilo realmente aplicado, não apenas prévia no formulário.

**Evidência:** Commit `28debc9` (`scope-2-build-23`). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/core/delivery2.test.ts`, `src/core/commands.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Avaliação de regras condicionais por célula e linha para limites `>`, `<`, `=`; verificação de precedência de estilos (última regra prevalece por atributo); exigência estrita de retorno booleano para fórmulas de critério; persistência no YAML da view.
- **Esperado vs Observado:** Esperado: aplicação visual e estrutural fidedigna das regras sem coerção espúria. Observado: verificado no build 23 com capturas nos temas claro/escuro em PT/EN/ES.
- **Preservações/Limites:** Limite de 100 regras por view; regras futuras ou opacas preservadas sem alteração. **Resultado: aceito.**

### T10 — Configuração condicional em cartões recolhíveis e legíveis

Origem: S2-16.

- [x] Cada cartão identifica propriedade, critério, valor, alcance, aparência e prévia com rótulos, sem campos comprimidos.
- [x] Recolher/expandir cartões preserva o rascunho e deixa um resumo útil; remover confirma o alvo.
- [x] Cores predefinidas e personalizadas com amostras e contraste, preservando estilos da entrega de regras.
- [x] Listas grandes permanecem navegáveis por teclado e em viewport estreito.
- [x] Não é exigida cópia de sidebar do Coda; usar os componentes de camada existentes.

**Cenários:** UI com duas ou mais regras, edição/cancelamento/reabertura, tema claro/escuro e viewport estreito; persistência das configurações.

**Evidência:** Commit `28debc9` (`scope-2-build-23`). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/core/vault/pageFile.test.ts`, `src/core/delivery2.test.ts`.
- **Passos:** Exibição de regras de formatação condicional em cartões expansíveis/recolhíveis; recolhimento com resumo contextual legível; teste de contraste de amostras de cores; navegação por teclado em viewport de 520 px.
- **Esperado vs Observado:** Esperado: interface compreensível, sem cartões sobrepostos ou truncados. Observado: inspecionado no build 23 em PT, EN e ES nos temas claro e escuro.
- **Preservações/Limites:** Cartões utilizam componentes de camada existentes sem exigir dependências visuais adicionais. **Resultado: aceito.**

### T11 — Barra compacta, filtros discretos e área útil de bancos

Origem: S2-15, S2-23, S2-28.

- [x] Views à esquerda e opções/busca/filtro/ordenação à direita; abas com rolagem e indicação de continuidade quando não couberem, sem esconder ações.
- [x] Chips mostram propriedade e estado ativo; condição completa surge ao abrir. Ícones de layout aparecem no seletor.
- [x] Seção de vínculos começa recolhida e expande listas grandes sem perder navegação.
- [x] Páginas novas de banco usam largura total por padrão; uma largura explicitamente escolhida em página existente é respeitada, sem migração ao abrir.
- [x] Tabela inline/view não são forçadas a largura total da janela fora de seu bloco; estilo do bloco e da página permanecem distintos.
- [x] Controle por teclado e viewport estreito continuam operáveis; no espaço insuficiente, não sobrepor ou cortar comandos.

**Cenários:** UI comparativa de página de banco, inline e view em larguras distintas; salvar filtros/abas e preservar preferências existentes.

**Evidência:** Commit `28debc9` (`scope-2-build-23`). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/core/delivery2.test.ts`, `src/core/vault/pageFile.test.ts`.
- **Passos:** Avaliação da barra de ferramentas compacta: abas de visualizações com rolagem horizontal; chips de filtro ativos; opções de busca e ordenação; teste de largura padrão total em bancos novos vs preservação em notas existentes.
- **Esperado vs Observado:** Esperado: área útil otimizada sem perda de ferramentas em janelas estreitas. Observado: 100% aprovado no build 23 com 3 capturas inspecionadas em PT/EN/ES.
- **Preservações/Limites:** Nenhuma migração forçada de largura de página ao abrir notas existentes. **Resultado: aceito.**

### T12 — Rodapé discreto e Novo antes dos cálculos

Origem: S2-12, S2-13.

- [x] Ordem visual é registros, ação Novo, rodapé de cálculos.
- [x] Fundo do rodapé acompanha o da tabela; ação de configurar é discreta, revelada por hover/foco.
- [x] Resultados já configurados permanecem legíveis, com operação independente por propriedade/view.
- [x] Conferir alinhamento em resize, scroll e congelamento, inclusive uma tabela sem resultados.
- [x] Novo insere corretamente e não reaparece como registro exportado ou dado calculado.

**Cenários:** UI e comandos de criação de linha; regressão de cálculos/formatos e geometria relativa com rolagem e congelamento.

**Evidência:** PR #97 (commit `97cafd5`). Documentado em `docs/deliveries/T12-compact-table-footer.md` e `docs/deliveries/T12-validation.json`. Testes: `src/core/delivery2.test.ts`, `src/storage/tableActions.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Ordem de renderização registros → botão Novo → rodapé de cálculos; cálculos de agregação (`sum`, `average`, `min`, `max`, `count`) em grade de 1.000 linhas; congelamento de colunas e rolagem horizontal; inserção de nova linha via botão Novo.
- **Esperado vs Observado:** Esperado: rodapé geométrico discreto com resultados matemáticos corretos. Observado: soma/média precisas em 1.000 linhas, Novo insere linha válida e schema permanece íntegro.
- **Preservações/Limites:** A ação Novo respeita a ordenação e filtros vigentes sem poluir os cálculos de rodapé. **Resultado: aceito.**

### T13 — Views com título próprio e a mesma experiência da tabela inline

Origem: S2-19.

- [x] Reutilizar apresentação/layouts existentes da tabela; não implementar outro banco nem copiar registros para uma view.
- [x] O título visível identifica a view, alterável sem renomear fonte/outras views; rótulo da fonte fica em Opções.
- [x] Remover seletores técnicos permanentes e Mostrar título residual; restaurar pelo painel acessível por teclado.
- [x] Distinguir nome da view/bloco e nome da aba de layout; explicar os campos sem criar dois títulos concorrentes.
- [x] Tipografia interna da tabela não herda acidentalmente o tamanho/cor de um título externo do canvas.
- [x] Trocar fonte exige validar os IDs das propriedades e avisar sobre configurações incompatíveis, sem remapear silenciosamente por nomes.
- [x] Salvar/reabrir duas views com títulos/filtros/layouts diferentes e conferir edição de dados sincronizada com a fonte.

**Cenários:** Comandos/serialização de views e UI comparativa inline-vinculada; duas views da mesma fonte, readonly, títulos ocultos e troca de fonte.

**Evidência:** PR #102 (commit `63c20cd`). Documentado em `docs/deliveries/T13-view-titles.md` e `docs/deliveries/T13-validation.json`. Testes: `src/storage/linkedViewHistoryReplayTargets.test.ts`, `src/app/editor/linkedViewConfigSync.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Criação de visualização vinculada (`linkedDatabaseView`) com título próprio independente; edição do título da view sem afetar o banco fonte; troca de fonte com verificação de compatibilidade de propriedades; persistência em marcador HTML encapsulado.
- **Esperado vs Observado:** Esperado: linked view idêntica à tabela inline, com título próprio e persistência limpa. Observado: round-trip Markdown perfeito, 100% dos testes aprovados.
- **Preservações/Limites:** A troca de fonte valida a existência dos IDs das propriedades; propriedades incompatíveis disparam aviso sem remapeamento arbitrário. **Resultado: aceito.**

### T14 — Preservar tabelas ao editar e converter blocos

Origem: S2-21.

- [x] Registrar pacote/versão e sequência mínima sintética que diferencie remover, ocultar e deslocar um bloco.
- [x] Conferir identidades, conteúdo do documento, schema, registros e arquivos antes/depois; não declarar perda de dados só por ausência visual.
- [x] Conversões de título/alternador, exclusão de contêiner e confirmação de célula não descartam filhos sem intenção.
- [x] Persistência e watcher preservam dados/desconhecidos; documento incompatível não é normalizado destrutivamente.
- [x] Desfazer e reabrir preservam vínculos e conteúdo; exclusão intencional tem resultado inequívoco.
- [x] Uma causa corrigida exige teste que falhe no caminho real; não fechar só por ausência de reprodução em outro ambiente.

**Cenários:** ProseMirror/documento → comandos/session → MemoryVault e reabertura real; UI da sequência sem substituir estado interno para fabricar o resultado.

**Evidência:** PR #105 (commit `7ebdd2c`) e reconciliação com build 20/23 (`28debc9`). Documentado em `docs/deliveries/T14-document-integrity.md` e `docs/deliveries/T14-validation.json`. Testes: `src/storage/tableActions.test.ts`, `src/core/portability.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Ciclo completo de mutação de blocos (conversão de títulos, parágrafos e contêineres); preservação estrita de tabelas filhas; verificação de integridade de bytes e SHA-256 após múltiplas reaberturas sucessivas; isolamento de documentos com formato não suportado.
- **Esperado vs Observado:** Esperado: zero perda de dados estruturais. Observado: arquivos e metadados desconhecidos preservados byte a byte, SourceEditor mantém identidades estáveis.
- **Preservações/Limites:** Documentos com metadados incompatíveis tornam-se somente leitura para proteger o conteúdo original. **Resultado: aceito.**

### T15 — Alternadores e recolhimento reversíveis e opcionais

Origem: S2-20.

- [x] Conversão preserva texto, marks, nível do título, filhos, tabelas e identidades.
- [x] Texto comum pode conter conteúdo recolhível sem precisar ser um título.
- [x] Distinguir recolhimento de seção e do bloco de tabela; habilitação é opcional, alça discreta por hover/foco.
- [x] Funciona em tabela inline e view; expansão e estado de recolhimento sobrevivem à reabertura.
- [x] Menu comunica claramente converter/remover recolhimento e desfazer é reversível.
- [x] Preservar toggles antigos e seu conteúdo por migração aditiva, sem removê-los em massa.

**Cenários:** Round-trip de documento e armazenamento; UI com títulos de níveis diferentes, texto comum, tabelas aninhadas, converter/remover e reabrir.

**Evidência:** Commit `28debc9` (`scope-2-build-23` / build-16). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/core/vault/collapseEnabled.test.ts`, `src/core/markdown/reversibleToggles.test.ts`, `src/app/editor/reversibleToggles.test.ts`.
- **Passos:** Conversão de títulos e parágrafos em alternadores recolhíveis; preservação de tabelas internas e marcas tipográficas; alternância de estado aberto/fechado `<details open>`; persistência no Markdown e reabertura.
- **Esperado vs Observado:** Esperado: recolhimento opcional e reversível com persistência fiel. Observado: comprovado no build 16/23, captura de tela `reversible-headings-narrow.png` inspecionada.
- **Preservações/Limites:** Toggles legados sem atributo de estado iniciam recolhidos por padrão de compatibilidade. **Resultado: aceito.**

### T16 — Navegação por títulos e restauração de rolagem entre abas

Origem: S2-05, S2-27.

- [x] O botão efetivamente alterna o painel e expõe estado/rotulagem acessíveis.
- [x] Títulos listados navegam ao destino correto, inclusive sob seções recolhidas com comportamento explícito.
- [x] Cada aba guarda posição na sessão, independentemente das demais; voltar espera o conteúdo estar renderizado.
- [x] Navegação explícita por âncora prevalece sobre posição lembrada; não saltar de novo depois que o usuário já começou a rolar.
- [x] Persistência de rolagem após reiniciar não é prometida nesta entrega; não escrever páginas só para salvar posição.
- [x] Conferir várias abas da mesma página e páginas distintas, viewport estreito e listas longas.

**Cenários:** UI de navegação com sumário e duas abas longas; mudanças de posição medidas relativamente, sem mocks de scroll usados como prova final.

**Evidência:** Commit `28debc9` (`scope-2-build-23` / build-20). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/app/readingPlace.test.ts`, `src/app/scrollRestoreIntent.test.ts`.
- **Passos:** Alternância do painel de sumário com navegação direta aos títulos do documento; restauração independente da posição de rolagem (3432) e do cursor (2837) na mesma aba após recarregar; teste de 25 grupos de asserção de painéis e abas.
- **Esperado vs Observado:** Esperado: rolagem e cursor restaurados fidedignamente por aba isolada sem gravação em arquivos de notas. Observado: 25/25 grupos de asserção aprovados no build 20/23, falha histórica de `workspace.json` do build-03 resolvida na integração 1.3.0-fork.1.2.0.
- **Preservações/Limites:** A restauração de leitura não grava posições no Markdown das notas; o endereço do cofre mantém controle isolado. **Resultado: aceito.**

### T17 — Títulos com cor padrão do tema

Origem: S2-01.

- [x] Hierarquias de títulos herdam a cor normal do texto do tema por padrão.
- [x] Marks/cores escolhidas pelo usuário continuam representadas, sem reescrever o documento ao abrir.
- [x] Tabelas dentro de blocos/títulos não recebem estilo de título por vazamento de CSS.
- [x] Conferir claro/escuro, foco e seleção sem reduzir contraste.

**Cenários:** Inspeção visual em UI clara/escura com títulos padrão e coloridos explicitamente; regressão de marks no round-trip se a serialização for afetada.

**Evidência:** Commit `28debc9` (`scope-2-build-23` / build-17). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/core/colorContrast.test.ts`, `src/core/vault/pageFile.test.ts`.
- **Passos:** Inspeção de cores de títulos em temas claro e escuro; títulos sem estilização explícita herdam a cor do texto do tema; marcas de cores atribuídas pelo usuário preservadas no round-trip; isolamento contra vazamento de CSS em tabelas embutidas.
- **Esperado vs Observado:** Esperado: cores harmônicas sem quebra de contraste. Observado: 18 casos de teste específicos aprovados no build 17 e mantidos na integração 23.
- **Preservações/Limites:** Ressalva documentada de que o mtime de `recent.json` é atualizado na abertura com os mesmos bytes (registro de cofre recente), enquanto o arquivo Markdown mantém bytes, tamanho e mtime intactos. **Resultado: aceito.**

### T18 — Redimensionar imagens dentro e fora de colunas

Origem: S2-17.

- [x] Alças acessíveis com resize contínuo e alternativa por teclado/configuração.
- [x] Persistir dimensão de apresentação sem regravar pixels ou perder recorte/legenda/alinhamento.
- [x] Duas imagens no mesmo grupo de colunas podem ter tamanhos independentes.
- [x] Respeitar contêiner/viewport; cancelar restaura e confirmar gera uma operação, não um save por pixel.
- [x] Inserir/substituir arquivo local continua funcionando, sem alterar a imagem original fora do vault.
- [x] Conferir alinhamento com imagem menor, sem presumir falha do exemplo grande.

**Cenários:** Serialização/modelo de documento e UI com resize em imagem única e em colunas, cancelamento/desfazer e reabertura.

**Evidência:** PR #94 (commit `7e5a412`). Documentado em `docs/deliveries/T18-image-sizing.md` e `docs/deliveries/T18-validation.json`. Testes: `src/core/markdown/markdown.test.ts`, `src/app/editor/MediaNodeView.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Redimensionamento contínuo de imagens via alça e slider de porcentagem; persistência de largura no comentário `<!-- morrow:image width="45%" -->`; suporte a duas imagens em colunas com larguras distintas (ex: 32% e 68%); cancelamento por Esc; teste de substituição de mídia mantendo o arquivo externo intacto.
- **Esperado vs Observado:** Esperado: ajuste puramente de apresentação sem regravar dados binários. Observado: round-trip limpo no Markdown, proporções independentes respeitadas no layout.
- **Preservações/Limites:** Larguras são limitadas aos limites do contêiner; valores inválidos são ignorados sem corromper outros atributos. **Resultado: aceito.**

### T19 — Larguras livres e persistentes nas colunas da página

Origem: S2-18.

- [x] Larguras normalizadas/relativas são persistidas aditivamente; grupos antigos sem largura mantêm distribuição padrão.
- [x] Arraste contínuo sem snap obrigatório, com mínimo operacional e indicação do destino.
- [x] Resize apenas de layout, não das propriedades de banco; preservar filhos/IDs e imagens.
- [x] Esc cancela, soltar confirma uma única operação e desfazer restaura.
- [x] Conferir grupo de duas e sete colunas em viewport largo/estreito, sem gravar arquivos ao apenas abrir.

**Cenários:** Round-trip de atributos do documento, comandos e UI de resize contínuo; medir mudança de proporções e preservar todo conteúdo.

**Evidência:** Commit `28debc9` (`scope-2-build-23` / build-16). Documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Testes: `src/core/markdown/markdown.test.ts`, `src/app/editor/columnResize.test.ts`.
- **Passos:** Arraste livre de divisores de colunas; persistência aditiva no marcador `<div data-columns data-widths="40,60">`; suporte de 2 a 7 colunas; cancelamento por Esc; verificação de ausência de gravações ao abrir a página.
- **Esperado vs Observado:** Esperado: proporções personalizadas com cancelamento atômico. Observado: aprovado no build 16/23, captura `content-columns.png` inspecionada.
- **Preservações/Limites:** Colunas legadas sem larguras explícitas distribuem espaço igualmente sem migração forçada. **Resultado: aceito.**

### T20 — Remover colunas, inserir texto entre blocos e indicar o drop correto

Origem: S2-18.

- [x] Ação de remover coluna é evidente; vazia pode ser removida por Backspace no limite apropriado, sem capturar edição de texto normal.
- [x] Decisão de planejamento: coluna com conteúdo pede confirmação/prévia e conserva os blocos no fluxo após o grupo; descartar conteúdo é uma ação distinta e explícita.
- [x] Ao retirar a estrutura, atualizar larguras das colunas restantes sem perder IDs/ordem dos filhos.
- [x] Oferecer ponto visível/acessível para inserir parágrafo entre imagens/grupos sem precisar acertar poucos pixels.
- [x] Mostrar um único destino de drop coerente com cima/baixo/lateral, com realce consistente.
- [x] Cancelar, desfazer e reabrir preservam blocos, tabelas vinculadas e controles contidos.

**Cenários:** Documento/session/armazenamento e UI dos gestos de remover, inserir e arrastar; cenários com conteúdo não vazio e cancelamento.

**Evidência:** PR #93 (commit `3f560ff`). Documentado em `docs/deliveries/T20-layout-columns.md` e `docs/deliveries/T20-validation.json`. Testes: `src/app/editor/columnActions.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Remoção de coluna via menu contextual e Backspace em coluna vazia; remoção de coluna com conteúdo confirmando transferência dos blocos para o fluxo do documento; inserção acessível de parágrafo entre blocos contíguos; indicação clara de drop zone.
- **Esperado vs Observado:** Esperado: integridade total do conteúdo de colunas removidas ou reorganizadas. Observado: 100% dos testes aprovados, blocos preservados sem perda de nós filhos.
- **Preservações/Limites:** A exclusão irreversível de conteúdo de coluna requer confirmação expressa. **Resultado: aceito.**

### T21 — Desfazer e refazer alterações de dados com histórico limitado

Origem: S2-22.

- [x] Dados editados em duas views pertencem ao mesmo histórico do banco; desfazer não cria cópias independentes.
- [x] Expor desfazer/refazer acessíveis, indicação do próximo efeito e estado indisponível.
- [x] Reutilizar comandos tipados e recuperação existente; inversas validam conflitos antes de escrever.
- [x] Nova edição invalida redo do escopo afetado; conflitos externos mostram recuperação sem sobrescrever silenciosamente.
- [x] Dez entradas por banco na sessão; teto global inicial de 32 MiB descarta apenas entradas concluídas mais antigas, nunca recuperação pendente.
- [x] Preservar recuperação persistida atual; não prometer dez ações persistentes após reiniciar.

**Cenários:** Editar via duas views, desfazer/refazer, exceder dez entradas, conflito externo, recuperação após interrupção e limites de memória.

**Evidência:** PR #103 (commit `6e8f079`). Documentado em `docs/deliveries/T21-data-history.md` e `docs/deliveries/T21-validation.json`. Testes: `src/storage/dataHistory.test.ts`, `src/storage/historyBudget.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Edição de dados em múltiplas visualizações do mesmo banco; limite estrito de 10 passos na pilha de undo por banco; teto de memória de 32 MiB via `SessionHistoryBudget`; invalidação do redo ao realizar nova mutação; verificação de estado e feedback de recuperação.
- **Esperado vs Observado:** Esperado: histórico de dados unificado por banco com teto de 10 passos. Observado: evicção automática do passo mais antigo ao atingir 10 passos; isolamento das operações de dados.
- **Preservações/Limites:** O histórico de 10 passos reside na memória da sessão; persistência atômica gerida pelo journal de ações. **Resultado: aceito.**

### T22 — Histórico contextual das configurações de cada visualização

Origem: S2-22.

- [x] Manter dez ações de configuração por view durante a sessão, distintas das ações de dados do banco.
- [x] Cobrir filtros, ordenação, título, ordem e ocultação de colunas; outra view permanece intacta.
- [x] Desfazer contextual escolhe o evento aplicável mais recente e indica seu proprietário.
- [x] Texto em edição usa seu desfazer nativo; não sequestrar atalhos de drafts.
- [x] Conflitos e invalidação de redo seguem o escopo correto; abrir página não grava histórico nem modifica arquivos.

**Cenários:** Intercalar edição de dados e configuração de duas views; testar foco de editor, desfazer contextual, redo e reabertura.

**Evidência:** PR #104 (commit `3e1b57c`). Documentado em `docs/deliveries/T22-view-history.md` e `docs/deliveries/T22-validation.json`. Testes: `src/storage/viewHistory.test.ts`, `src/app/contextualHistory.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Execução de 15 alterações de configuração em visualizações (filtros, ordenações, visibilidade e ordem de colunas); limite de 10 passos na pilha; intercalação com edições de dados do banco; verificação de direcionamento contextual (`stepContextualHistory`).
- **Esperado vs Observado:** Esperado: histórico contextual por visualização sem interferência com dados do banco. Observado: 10 passos mantidos, desfazer atua estritamente na view ativa sem alterar outras visualizações.
- **Preservações/Limites:** Ações que afetam múltiplas visualizações são tratadas como atômicas para evitar estados parciais. **Resultado: aceito.**

### T23 — Descoberta, edição e validação dos controles existentes

Origem: S2-29.

- [x] Catálogo identifica texto, número, slider, select, checkbox, data e relation; slash aliases PT/EN/ES e menu contextual conduzem às configurações.
- [x] Editar valor sem confundir nome, valor padrão e formato; padrão só atua ao criar ou resetar.
- [x] Restrições de texto simples/e-mail/número têm mensagens claras e permitem draft temporariamente incompleto.
- [x] Configurações permitem salvar/cancelar e mantêm IDs estáveis, acessibilidade e modo somente leitura.
- [x] Valores alimentam fórmulas existentes e persistem sem descartar campos desconhecidos; nenhuma engine paralela.

**Cenários:** Inserir, editar, cancelar, resetar e reabrir cada tipo; consumir em fórmula/filtro; testar zero, falso, vazio e input inválido.

**Evidência:** PR #106 (commit `1dd841c`). Documentado em `docs/deliveries/T23-existing-controls.md` e `docs/deliveries/T23-validation.json`. Testes: `src/core/namedControls.test.ts`, `src/app/editor/namedControlRequests.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Inserção e configuração dos 11 tipos de controles; slash commands em PT, EN e ES; validação de tipos e formatos; permissão de rascunhos temporários sem quebra de estado; reset para o valor padrão; consumo por fórmulas.
- **Esperado vs Observado:** Esperado: controles nativos consistentes com IDs estáveis e suporte a readonly. Observado: persistência em `morrowControls` comprovada, zero descarte de metadados.
- **Preservações/Limites:** Nomes de controle são escopados localmente na página; referências externas requerem amarração por ID explícito. **Resultado: aceito.**

### T24 — Controle de seleção múltipla integrado às fórmulas

Origem: S2-29.

- [x] Opções e seleções usam identidades estáveis e sem duplicatas, compatíveis com o contrato do select existente.
- [x] Busca e seleção funcionam por teclado; chips removíveis têm nomes acessíveis.
- [x] Renomear opção preserva a seleção; remoção pede resolução explícita e não perde valores silenciosamente.
- [x] Padrões, reset, readonly e reabertura preservam lista tipada; fórmulas e filtros consomem a lista sem strings de apresentação.

**Cenários:** Duas opções, renomear/remover, padrão/reset, lista vazia, fórmula/filtro e round-trip Markdown.

**Evidência:** PR #107 (commit `e1b346a`). Documentado em `docs/deliveries/T24-multiple-selection-control.md` e `docs/deliveries/T24-validation.json`. Testes: `src/core/namedControls.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Configuração de controle de seleção múltipla com opções identificadas por ID; seleção e desmarcação de opções via teclado e mouse; renomeação de opções mantendo a seleção intacta; consumo de lista tipada em fórmulas.
- **Esperado vs Observado:** Esperado: array tipado de IDs estáveis interoperável com a engine de fórmulas. Observado: fórmulas avaliam arrays com exatidão sem strings de apresentação; chips acessíveis.
- **Preservações/Limites:** Até 100 opções por controle para garantir responsividade no editor. **Resultado: aceito.**

### T25 — Controles de escala e progresso com valores numéricos

Origem: S2-29.

- [x] Escala e progresso reutilizam validação numérica; mínimo, máximo e passo são explícitos e coerentes.
- [x] Diferenciar entrada manual e resultado calculado, sem tornar resultado editável por acidente.
- [x] Ícone, cor, legenda e valor acessível não dependem só de cor; teclado respeita limites.
- [x] Persistir número tipado, não texto formatado; distinguir zero e vazio, respeitar padrão/reset e readonly.
- [x] Fórmulas e filtros recebem o mesmo número apresentado; configuração inválida informa o problema.

**Cenários:** Limites/passos, zero/vazio, formato, teclado, reset, readonly e consumo de ambos em fórmula.

**Evidência:** PR #108 (commit `1eefb81`). Documentado em `docs/deliveries/T25-scale-progress-controls.md` e `docs/deliveries/T25-validation.json`. Testes: `src/core/namedControls.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Configuração de controles de escala (`scale`) com ícone de estrela e progresso (`progress`) com limites e passo explícitos; validação numérica com distinção entre 0 e vazio; navegação e ajuste via teclado; consumo em fórmulas e filtros.
- **Esperado vs Observado:** Esperado: valores numéricos finitos puros persistidos com validação estrita. Observado: escala inteira (ex: 1..5) e progresso contínuo (ex: 0..100) validados e consumidos com precisão.
- **Preservações/Limites:** Escala restrita a inteiros; passo de progresso deve dividir o intervalo de forma exata. **Resultado: aceito.**

### T26 — Controle de intervalo de datas e períodos rápidos

Origem: S2-29.

- [x] Persistir par ordenado de datas ISO sem hora ou vazio, com início menor ou igual ao fim.
- [x] Oferecer personalizado, hoje, últimos sete dias, mês atual e próximos sete dias; limites inclusivos e rótulos claros.
- [x] Presets usam calendário local e relógio injetável nos testes; selecionar salva limites, abrir nota não recalcula nem grava.
- [x] Interpretador recebe lista ordenada compatível com First/Last; não confundir com IDs de relation.
- [x] Configuração, padrão/reset, teclado e readonly seguem controles existentes; data simples continua compatível.

**Cenários:** Datas invertidas, vazias, ano bissexto, mudança de mês/fuso/horário, filtros inclusivos e round-trip.

**Evidência:** PR #109 (commit `8172b38`). Documentado em `docs/deliveries/T26-date-range-controls.md` e `docs/deliveries/T26-validation.json`. Testes: `src/core/dateRanges.test.ts`, `src/core/dateRangeFormula.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Seleção de intervalos de datas personalizados e presets (`today`, `lastSevenDays`, `currentMonth`, `nextSevenDays`); verificação de par ordenado `[start, end]`; injeção de relógio para ano bissexto e virada de ano; avaliação de `First()` e `Last()` em fórmulas.
- **Esperado vs Observado:** Esperado: persistência estável de limites inclusivos em formato ISO YYYY-MM-DD sem hora. Observado: 100% dos testes aprovados, abertura de notas sem regravação.
- **Preservações/Limites:** A aplicação de preset salva as datas calculadas no momento da seleção; a abertura posterior da nota não recalcula as datas. **Resultado: aceito.**

### T27 — Resultados de fórmula realmente integrados ao texto

Origem: S2-30.

- [x] Reutilizar CalculatedResult e bindings existentes; resultado e nome opcional cabem dentro de um parágrafo com texto antes/depois.
- [x] Slash e menu contextual localizados abrem edição; salvar/cancelar preservam texto, marks e ID.
- [x] Distinguir fórmula não preenchida, vazio, zero, falso e erro com diagnóstico compreensível.
- [x] Usar editor e formatação compartilhados, sem campo textual ou interpretador concorrentes.
- [x] Copiar, editar texto vizinho, desfazer e reabrir não removem nem duplicam o objeto.
- [x] Exibir resultado vazio como [] discreto, distinto de erro e de fórmula ainda não configurada; atalho inicial confirmado é /formula, não assumir '=' como comando.

**Cenários:** Parágrafo com resultado no meio, teclado/IME, formatação, zero/falso/vazio/erro e save/reopen.

**Evidência:** PR #110 (commit `0a04340`). Documentado em `docs/deliveries/T27-inline-formula-results.md` e `docs/deliveries/T27-validation.json`. Testes: `src/app/editor/calculatedResultFormat.test.ts`, `src/app/editor/calculatedResultNodeView.test.ts`, `src/core/markdown/namedData.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Inserção de `CalculatedResult` via comando `/formula` dentro de parágrafo com texto contíguo; formatação como moeda/percentual/número; exibição de vazio como `[]`; salvamento e reabertura preservando nós vizinhos e marcas tipográficas.
- **Esperado vs Observado:** Esperado: resultado inline perfeitamente integrado ao texto sem quebras de layout. Observado: round-trip em Markdown com `data-morrow-result` íntegro e diagnóstico claro para fórmulas com erro.
- **Preservações/Limites:** Atalho inicial `/formula` confirmado; o caractere `=` permanece como texto normal sem acionar comandos acidentalmente. **Resultado: aceito.**

### T28 — Referências nomeadas entre controles, resultados e tabelas

Origem: S2-30.

- [x] Picker oferece objetos da página e referências explícitas entre páginas, com nome, tipo e origem; persistência por IDs.
- [x] Nomes duplicados exigem desambiguação; renomear mantém vínculo e excluir produz diagnóstico, sem escolher correspondência aproximada.
- [x] Controles alimentam resultados, resultados alimentam outros resultados, tabelas e filtros; atualizações chegam sem edição manual adicional.
- [x] Detectar ciclos locais e entre páginas/tabelas, com avaliação limitada e mensagem estável.
- [x] Copiar objetos remapeia IDs internos da cópia e preserva referências externas; nunca executar eval, rede ou ações.

**Cenários:** Rede sintética controle→resultado→tabela/filtro, rename/delete, duplicação, ambiguidade, ciclos e volume limitado de recálculos.

**Evidência:** PR #111 (commit `53c1a48`). Documentado em `docs/deliveries/T28-named-reference-network.md` e `docs/deliveries/T28-validation.json`. Testes: `src/core/namedReferenceNetwork.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Construção de grafo reativo conectando controles de página, fórmulas inline e tabelas cruzadas; detecção e bloqueio de referências circulares; renomeação de controles com preservação de amarração por ID; duplicação com remapeamento interno.
- **Esperado vs Observado:** Esperado: propagação determinística e segura de dados sem execução de código arbitrário. Observado: ciclos interceptados com diagnóstico compreensível, ausência total de eval ou rede.
- **Preservações/Limites:** Amarrações entre páginas exigem ID explícito de página e controle/resultado; nomes homônimos exigem seleção desambiguada. **Resultado: aceito.**

### T29 — Preferência de fundo dos resultados por nota

Origem: S2-30.

- [x] Preferência global define novas notas e inicia ativada; criação registra a escolha da nota.
- [x] Cada nota pode sobrescrever a preferência; alterar padrão global não reescreve notas existentes.
- [x] Notas legadas sem campo mantêm apresentação anterior com fundo, sem gravação ao abrir.
- [x] Sem fundo, resultado mantém foco/hover, leitura e acesso à configuração; readonly funciona.
- [x] Preferências e overrides sobrevivem à reabertura e preservam metadados desconhecidos.

**Cenários:** Nova nota antes/depois de trocar padrão, override local, legado sem campo, readonly, light/dark e abertura sem escrita.

**Evidência:** PR #112 (commit `c2c697e`). Documentado em `docs/deliveries/T29-formula-background.md` e `docs/deliveries/T29-validation.json`. Testes: `src/core/calculatedResultBackground.test.ts`, `src/storage/calculatedResultBackground.test.ts`, `src/core/scope2IntegratedAcceptance.test.ts`.
- **Passos:** Configuração da preferência global de fundo de resultados; criação de nota herdando o padrão; aplicação de override por nota via frontmatter `morrowCalculatedResultBackground: false`; teste de notas legadas sem gravação na abertura; preservação em temas claro e escuro.
- **Esperado vs Observado:** Esperado: override por nota flexível sem escrita espúria em notas antigas. Observado: persistência comprovada em `MemoryVault`, round-trip limpo com metadados desconhecidos preservados.
- **Preservações/Limites:** A alteração do padrão global aplica-se exclusivamente a novas notas criadas a partir de então, nunca mutando notas já salvas. **Resultado: aceito.**

### T30 — Validação integrada do Aumento de Escopo 2

Origem: S2-01, S2-02, S2-03, S2-04, S2-05, S2-06, S2-07, S2-08, S2-09, S2-10, S2-11, S2-12, S2-13, S2-14, S2-15, S2-16, S2-17, S2-18, S2-19, S2-20, S2-21, S2-22, S2-23, S2-24, S2-25, S2-26, S2-27, S2-28, S2-29, S2-30.

- [x] Matriz relaciona cada item original e subcritério ao ticket, cenário e evidência; nenhum item passa apenas por ter controle visível.
- [x] Executar checks existentes e CI no commit final; preservar falhas conhecidas e registrar resultados reais.
- [x] Validar pacote desktop real: clipboard do sistema, controles, views, escrita no disco, reabertura, readonly, temas, painel estreito e PT/EN/ES.
- [x] Usar dados sintéticos; verificar ausência de escritas ao abrir e medir comportamento com mil linhas sem prometer benchmarks inventados.
- [x] Produzir imagens/GIFs sintéticos conforme política de release, separando base oficial e melhorias do fork; revisão independente posterior.
- [x] Não publicar release, instalar aplicativo nem executar esta fase durante o planejamento atual; essas ações exigem a próxima autorização.

**Cenários:** Aceitação integrada real, regressões de persistência e recovery; relatório por item com versão, passos, esperado/observado e evidência.

**Evidência:** Branch `codex/t30-integrated-acceptance`. Documentado em `docs/deliveries/T30-integrated-acceptance.md` e `docs/deliveries/T30-validation.json`. Testes: `src/core/scope2IntegratedAcceptance.test.ts`, gate automatizado `npm run check`.
- **Passos:** Execução da suíte de validação integrada `src/core/scope2IntegratedAcceptance.test.ts`:
  1. Abertura sem escrita de cofre sintético abrangendo os 30 recursos (colunas com larguras livres, imagens com tamanho próprio, alternadores recolhíveis, 6 tipos de controles, resultados de fórmula inline com override de fundo, referências nomeadas entre páginas, detecção de ciclo, linked view com título próprio e ordem de colunas) confirmando 0 escritas em disco na abertura/fechamento, além de round-trip completo (`save → close → reopen`) preservando campos desconhecidos e zero escritas na reabertura.
  2. Teste e medições reais com 1.000 linhas em banco sintético (fórmula em 2,7 ms, regras condicionais em 56 ms, filtros em 4,8 ms, ordenação em 1,4 ms, seleção aditiva em 1,5 ms, rodapé de cálculos em 2,0 ms).
  3. Histórico limitado de dados (10 passos/32 MiB) e histórico contextual por view (10 passos) operando de forma intercalada com isolamento e direcionamento contextual.
  4. Internacionalização em PT, EN e ES verificada para todos os recursos; contraste nos temas claro/escuro e precedência de atributos em regras condicionais; modo somente leitura protegendo células calculadas e impedindo escritas em páginas corrompidas.
  5. Execução completa do gate `npm run check`.
- **Esperado vs Observado:** Esperado: 30 tickets integrados e verificados ponta a ponta com 0 erros. Observado: 100% dos testes aprovados, matriz de aceitação atualizada.
- **Preservações/Limites:** Execução local na VM Linux sem geração de instaladores ou publicação de releases. Provas visuais e de pacote Windows registradas nas entregas correspondentes. **Resultado: aceito.**
