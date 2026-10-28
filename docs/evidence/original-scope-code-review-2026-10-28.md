# Auditoria independente do escopo original — revisão de código

Data: 28/10/2026. Base lida: HEAD `46784d6`.

## Fonte, método e limites

A fonte de requisitos foi a nota original privada indicada por Carlos, lida integralmente, com consulta a referências visuais pertinentes. Este documento contém uma síntese dos comportamentos, sem copiar a nota integral, seus dados ou anexos. A matriz anterior foi usada apenas como índice de evidências, não como autoridade dos requisitos.

Revisão somente de leitura de código, testes e harnesses existentes. Nenhuma UI, build ou teste foi executado nesta auditoria. A escrita deste relatório foi autorizada separadamente. Não houve alteração de produto, commit ou ação no tracker.

As evidências anteriores pertencem às execuções já registradas. Elas ajudam a identificar cobertura, mas não substituem a auditoria funcional independente em andamento. “Falta comprovar” não significa “função ausente” nem “bug reproduzido”.

## Pontos prioritários para confronto com a UI

1. **Item 9, título de view vinculada:** o ramo `hideTitle` de `LinkedDatabaseView.tsx` renderiza um botão menor contendo `displayTitle(source)`. O CSS desse botão não oculta o texto. Na tabela inline, o ramo equivalente mostra a ação “Mostrar título”. É uma divergência estática: confirmar visualmente se o título continua exposto quando a opção é ativada.
2. **Item 15, handle de seis pontos:** o botão `.db-row-drag` possui eventos de arraste, mas não de clique ou menu de contexto. Checkbox e menu de três pontos oferecem seleção e operações em controles separados. A nota atribui seleção e botão direito ao próprio handle. Confirmar na UI e considerar handlers ancestrais antes de concluir ausência funcional.
3. **Não presumir ausência de menu de imagem:** `PageEditor.tsx` tem tratamento global de contexto; a ausência de um handler local na imagem não demonstra falha. A auditoria funcional deve abrir o menu com botão direito e verificar as ações.

## Checklist dos vinte itens

| Item | Comportamentos mínimos a conferir | Implementação ou evidência anterior localizada | Comprovação adicional necessária |
|---:|---|---|---|
| 1 | Fundo de bloco com HEX personalizado e amostras das cores padrão. | Harness #27 verifica amostras, HEX, aplicação e reabertura. | Correspondência visual das amostras com as opções, sem tratar existência de controles como prova de aparência completa. |
| 2 | Filter bar compacta, sem área excessiva ou poluição visual. | Chips compactos no código; #28 exercita filtro e reset. | Comparação visual com vários filtros e janela estreita. Filtrar corretamente não comprova compactação. |
| 3 | Pelo botão direito da imagem: substituir, legenda, esquerda/centro/direita e recortar. | #30 testa crop, cancelamento, legenda, esquerda, substituição e reabertura; existe tratamento global de contexto no editor. | Abrir efetivamente com botão direito e verificar todas as ações e os três alinhamentos. O roteiro anterior usa principalmente a toolbar de hover. |
| 4 | Evitar menus sobrepostos/problemáticos com página em largura total. | #26 mede menus em duas resoluções. | Ativar largura total explicitamente e verificar interação entre menus/submenus, não apenas coordenadas dentro da viewport. |
| 5 | Habilitar/desabilitar recolhimento por título, seguir hierarquia, mostrar seta somente se habilitado e persistir estado. | #31 verifica recolher/expandir, limite da próxima seção e reabertura; existem testes de hierarquia. | Desabilitar novamente, verificar retirada da seta e hierarquia aninhada na UI. |
| 6 | Tab sem maximizar, Enter editar/confirmar e descer, setas, clique seleciona célula, Ctrl+C/V e preenchimento lateral/vertical. | Entrega4 cobre amplamente navegação, editores, clipboard e preenchimento com cópia/sequência. | Não foi localizada ausência estática clara; confrontar os caminhos completos na execução atual. |
| 7 | Ação de edição com nome curto: “Editar coluna” ou equivalente autorizado. | Menu usa `database.editColumn`; tradução PT é “Editar coluna”. | Verificar o texto renderizado. Busca de tipos não é evidência deste item. |
| 8 | Amostras/prévia da cor, cor personalizada e critério por fórmula. | #38 seleciona modo `formula`, digita `Valor >= 200`, verifica diagnóstico, células atingidas e persistência. | A fórmula já tem comprovação anterior; falta documentar amostras/prévia visual e eventual caminho de fórmula inválida. Não confundir a expressão testada com modo de condição simples. |
| 9 | Recolher visualização e ocultar seu título. | #29 comprova recolhimento independente e persistido; `hideTitle` existe no código. | Ocultação não é exercitada pelo roteiro anterior. Priorizar inline e vinculada, inclusive o texto exposto no ramo `hideTitle` descrito acima. |
| 10 | Botão à direita com configurações reunidas e lista das views vinculadas à tabela. | Menu de opções e listagem existem; #28/#29 exercitam opções, lista e navegação. | Posição visual e conjunto completo de seções. Filter bar isolada não cobre o item inteiro. |
| 11 | Aparência de tabela inline, sem fundo destacado; renomeação independente da origem e das demais views. | CSS da vinculada é transparente e sem borda; nome reside em atributos locais; #29 altera dois nomes e verifica persistência independente. | Comparar visualmente inline e vinculada e registrar explicitamente que o nome da origem não mudou. Backlinks não substituem esses critérios. |
| 12 | Rodapé alinhado às colunas, discreto, diferente de linha de dados, chamado “Calcular”, com cálculos independentes em várias colunas. | Footer próprio e opções por coluna/view; #39 comprova operações simultâneas e independentes. | Medir alinhamento com valores, congelamento e scroll; avaliar discrição visual. O roteiro anterior confere números e configurações, não a geometria. |
| 13 | Até sete colunas; criar arrastando para a lateral, com barra indicadora. | #40 comprova sétima coluna por arraste, recusa da oitava e reabertura. | Visibilidade da barra durante o arraste. Resultado final não comprova o indicador. |
| 14 | Seleção múltipla com mouse e Shift+setas; limpar por Backspace e Delete. | Código implementa os dois métodos e ambas as teclas; entrega4 cobre retângulos e limpeza. | Registrar separadamente os métodos e teclas realmente executados; uma limpeza genérica não prova todos os caminhos. |
| 15 | Handle ao hover com seleção/menu, copiar linha completa na mesma/outra tabela, operações de linha, checkboxes e selecionar/desmarcar todas. | Entrega5 cobre seleção, triestado, conteúdo/propriedades ocultas, colagem, mapeamento, operações e undo. | Clique e botão direito no próprio handle, conforme ponto prioritário. Delimitar a lista de operações comparada à referência, sem alegar paridade indefinida com Coda. |
| 16 | Busca de tipos em PT/EN, painel melhorado e ícones representativos à esquerda. | `PropertyTypeSelect` tem aliases e ícones; #37 testa `moeda`/`currency`. | Testar também o exemplo `número`/`number` e registrar a posição dos ícones. Não foi identificada ausência no código. |
| 17 | Tokens com contorno arredondado, referências relacionadas reconhecidas/coloridas, Tab para completar e painel inteiro na tela. | #41 comprova segunda sugestão relacionada, Tab/Enter, caret e binding reaberto; #26 mede painéis. | Aparência/cor dos tokens e o painel específico de fórmula na posição problemática. Menu de bloco visível não comprova sozinho o painel de fórmula. |
| 18 | Configurações de resultado de fórmula equivalentes ao tipo normal, especialmente Número/casas decimais e outros formatos oferecidos. | `PropertyFormatSettings` é compartilhado por tipo efetivo. #42 comprova moeda/precisão, zero e checkbox falso. | Comparar Número normal com Fórmula→Número, opção por opção, e os demais resultados oferecidos. Moeda com duas casas não prova toda a paridade. |
| 19 | Sugestão/criação de relação bidirecional e vínculo posterior a uma coluna existente que aponta de volta. | Há modos criar/vincular. #43 testa explicitamente vínculo existente, prévia de união e persistência; core cobre conflitos. | Caminho de sugestão/criação de inversa nova pela UI. Vínculo existente não deve ser classificado como totalmente sem teste. |
| 20 | Ícones padrão por tipo e personalizados nas configurações; incluir upload na auditoria solicitada. | `PropertyGlyph` oferece ícone padrão; picker aceita emoji, Lucide e upload validado/armazenado. #37 comprova emoji personalizado persistido. | Upload real na coluna, renderização e reabertura; Lucide/cor e restauração do padrão. Upload existe no código, mas não é executado pelo harness anterior. |

## Referências de implementação e verificação

- `src/app/components/database/DatabaseView.tsx`: menu “Editar coluna”, opções da tabela, formatação condicional, grade, rodapé e controles de linhas.
- `src/app/components/database/LinkedDatabaseView.tsx` e `EmbeddedDatabase.tsx`: título, recolhimento e renomeação local.
- `src/app/styles/features.css`: fundo transparente das views vinculadas, affordances de hover e estilo do rodapé.
- `src/app/components/database/PropertySettings.tsx`: configuração compartilhada por tipo efetivo e relação inversa.
- `src/app/components/database/PropertyTypeSelect.tsx`: aliases PT/EN, ícones padrão e busca.
- `src/app/components/EmojiPicker.tsx`: upload, sanitização/validação e callback de personalização de ícones.
- `src/app/editor/PageEditor.tsx`: verificar o tratamento global de contexto de imagem, sem inferir ausência pelo componente local.
- `scripts/verify-prior-deliveries-ui.cjs`: #27, #28, #29, #30, #31, #37, #38, #39, #40, #41, #42 e #43.
- `scripts/verify-delivery4-ui.cjs` e `scripts/verify-delivery5-ui.cjs`: interação de células e linhas.
- `src/core/delivery1.test.ts`, `src/app/editor/delivery1-editor.test.ts`, `src/core/delivery3.test.ts`, `src/core/relations.test.ts`, `src/core/typedValues.test.ts` e `src/app/components/EmojiPicker.test.ts`: evidência de implementação/testes existentes; não executados nesta rodada.

## Conclusão desta etapa

Não há aprovação funcional dos vinte itens apenas por esta revisão estática. A execução independente deve confrontar o checklist, resolver as divergências dos itens 9 e 15 e registrar resultados por subitem. As lacunas de evidência acima não devem ser publicadas como defeitos reproduzidos. A nota privada e seus anexos permanecem fora dos artefatos públicos.
