# Matriz de aceitação e procedência

**Limite vigente:** somente os 15 tickets aceitos entram na integração 1.3; os outros 24 permanecem pausados. Veja [EXECUTION.md](EXECUTION.md).


**Estado: não executada.** S2 identifica item de origem; T identifica ticket. Os materiais originais permanecem privados; reproduções públicas usam dados sintéticos. A versão gravada é desconhecida.

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

- [ ] Reproduzir o erro de permissão em um pacote identificado e comparar com o desenvolvimento; registrar a versão e o comportamento real, sem inferir que o vídeo corresponde à última release.
- [ ] Na superfície desktop, ler/escrever clipboard por adaptador com ponte restrita ao processo principal; não desligar segurança do Electron nem conceder permissões amplas ao navegador.
- [ ] Copiar valor calculado para destino editável; proibir colar sobre cálculo e rejeitar lote inválido sem escrita parcial.
- [ ] Preservar TSV externo e metadados tipados internos; não reaproveitar cache antigo quando o clipboard do sistema mudar ou falhar.
- [ ] Cobrir também os fluxos de copiar/colar linhas que hoje usam a mesma API, sem quebrar o protocolo de cópia de banco.
- [ ] Comprovar a correção em Windows empacotado com dados sintéticos e clipboard real de ambiente de teste; nenhuma simulação de permissão conta como evidência desktop.

**Cenários:** Testes de contrato do adaptador de plataforma, comandos/storage para colagem atômica e UI empacotada sem injetar permissões do navegador; nenhum conteúdo pessoal de clipboard em relatórios.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T02 — Digitação imediata e confirmação confiável de células

Origem: S2-24.

- [ ] Digitação imprimível inicia edição da célula selecionada sem Enter prévio, preservando IME/composição e atalhos.
- [ ] Decisão de planejamento: Enter confirma valor válido e avança uma linha; no modo de navegação também avança. Shift+Enter insere quebra quando o editor textual estiver ativo.
- [ ] Blur confirma rascunho válido; Esc cancela e restaura o valor anterior; rascunho inválido permanece identificável, sem gravação parcial.
- [ ] Manter edição multilinha e Ctrl+Enter como atalho compatível opcional, sem exigi-lo para confirmar.
- [ ] Não editar resultados calculados nem gravar teclas de navegação como conteúdo.
- [ ] Conferir persistência após sair, alternar de página e reabrir.

**Cenários:** Seam de comandos/session para validação e persistência, mais UI com teclado real, texto multilinha, IME, cancelamento e reabertura.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T03 — Editar Nome e restaurar a coluna de exibição

Origem: S2-02, S2-03.

- [ ] Nome continua sendo a projeção do título da página, não uma segunda propriedade com dados duplicados.
- [ ] Renomear o cabeçalho mantém títulos/IDs das linhas; editar uma célula Nome usa a operação normal de renomear a linha.
- [ ] Definir outra coluna como exibição e voltar a Nome sem editar metadados manualmente; mostrar indicador acessível de olho.
- [ ] Excluir propriedade comum pelo botão direito identifica o alvo e preserva dados/referências não relacionados.
- [ ] Nome não é excluído sem uma semântica de substituição: nesta entrega, a ação é indisponível com explicação, não um apagamento de títulos.
- [ ] Conferir campo de exibição padrão do banco e override de relação sem confundir ambos.

**Cenários:** Comandos e storage para aliases/títulos/display; testes de relações e UI do menu com reabertura e colisões de nomes.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T04 — Reordenar colunas por arraste apenas na visualização ativa

Origem: S2-09.

- [ ] Reutilizar ordem local da view já existente; não reordenar o schema do banco como efeito do arraste.
- [ ] Suportar título e propriedades comuns, com colunas ocultas/congeladas e rolagem horizontal.
- [ ] Indicar destino, confirmar numa única operação ao soltar e cancelar por Esc.
- [ ] Oferecer alternativa por teclado/menu; cabeçalhos não iniciam edição ou redimensionamento acidentalmente.
- [ ] Persistir e reabrir mantendo a ordem daquela view e a ordem independente de outra.

**Cenários:** Comandos de configuração da view, serialização e UI com mouse/teclado; comparar duas views do mesmo banco.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T05 — Seleção aditiva e controles de linha discretos

Origem: S2-04, S2-14.

- [ ] Cada checkbox alterna só sua linha sem exigir modificadores; seleção geral conserva seu comportamento.
- [ ] Alças/checkboxes surgem na margem por hover ou foco sem mudar larguras e permanecem reconhecíveis quando selecionados.
- [ ] Concentrar ações num menu de três pontos, sem a faixa permanente de muitos comandos.
- [ ] Distinguir seleção por checkbox, alça da linha e alça do bloco; preservar seleção por teclado e operações de lote.
- [ ] Verificar tema claro/escuro e modo somente leitura, sem controles mutantes habilitados.

**Cenários:** UI mouse/teclado para seleção incremental, ações em lote e estabilidade geométrica; comandos existentes para executar as ações.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T06 — Selecionar células sem arrastar a visualização inteira

Origem: S2-26.

- [ ] Corrigir a fronteira de eventos/seleção da NodeView, sem bloquear genericamente todo evento do editor.
- [ ] Arraste dentro da grade seleciona células em ambas as direções, inclusive com Shift e rolagem.
- [ ] Alça externa move o bloco; a da linha mantém ações de linha.
- [ ] Interagir com inputs, links, menus e readonly sem deslocar ou apagar o bloco.
- [ ] Conferir o mesmo gesto na tabela inline e na view vinculada.

**Cenários:** Teste de contrato dos eventos da NodeView e UI real com intervalos, alças, controles focados e preservação do documento.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T07 — Painéis de propriedades e seletores legíveis, sem cortes

Origem: S2-06, S2-08, S2-11, S2-25.

- [ ] Separar tipo/Adicionar no painel de criação; rótulos das três opções de inversa não escapam dos botões.
- [ ] Painel de prévia de preenchimento usa as camadas compartilhadas e não é recortado pelo contêiner horizontal da tabela; aplicar/cancelar/desfazer acessíveis.
- [ ] Moeda pesquisável por código/nome; aplicar busca a locale e fuso onde há catálogo, mantendo entrada numérica e texto verdadeiramente livres.
- [ ] Não descartar códigos válidos existentes que o catálogo não liste; exibir valor atual e diagnóstico apropriado.
- [ ] Decisão de planejamento: abrir configuração após criação manual bem-sucedida, sem reabrir em importações/duplicações ou apagar a coluna ao cancelar o painel.
- [ ] Preservar Escape da camada superior, foco e opções em viewport estreito e largura total.

**Cenários:** UI de criação/configuração, teste de teclado das camadas e round-trip das opções; casos de código válido não listado e preenchimento no extremo direito.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T08 — Editor de fórmulas com cursor alinhado, cores e autocomplete

Origem: S2-10.

- [ ] Conferir clique, seleção, inserção, apagar e composição com cápsulas e texto em várias linhas, zoom e fontes suportadas.
- [ ] Distinguir classes tabela/relação, propriedade, função e controle por cor e rótulo/ícone acessível; funções podem ter realce simples.
- [ ] Depois do ponto, sugerir propriedades e funções compatíveis; Tab insere a sugestão selecionada sem destruir o restante da expressão.
- [ ] Unificar a confirmação de fórmula/configuração num fluxo claro, removendo Salvar duplicado sem utilidade.
- [ ] Preservar expressões/bindings, tipos de resultado, zero, false e vazio; nenhum novo interpretador.
- [ ] Conferir nomes com espaços/acentos e referência ambígua sem escolher um alvo arbitrário.

**Cenários:** Testes do editor/sugestões por comportamento e UI com caret/seleção e teclado; testes existentes de fórmulas e bindings como regressão.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T09 — Regras condicionais corretas com estilos de célula e linha

Origem: S2-16.

- [ ] Reproduzir numericamente valores acima/abaixo/iguais ao limite e explicar regra inválida em vez de fingir correspondência.
- [ ] Ação da coluna inicia regra com sua propriedade identificada; editar uma regra não muda outra.
- [ ] Reutilizar mecanismo de filtros/fórmulas puro, distinguindo alcance célula/linha e preservando regras antigas só de fundo.
- [ ] Adicionar cor do texto, negrito e itálico além de fundo; por atributo, a última regra correspondente na ordem explícita prevalece.
- [ ] Critério por fórmula exige resultado booleano ou diagnóstico claro, sem coerção silenciosa de número/texto.
- [ ] Persistir estilos/regras e rejeitar configuração inválida sem perda de regras anteriores.

**Cenários:** Seams de avaliação de regras, comandos e round-trip de schema; UI comprova estilo realmente aplicado, não apenas prévia no formulário.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T10 — Configuração condicional em cartões recolhíveis e legíveis

Origem: S2-16.

- [ ] Cada cartão identifica propriedade, critério, valor, alcance, aparência e prévia com rótulos, sem campos comprimidos.
- [ ] Recolher/expandir cartões preserva o rascunho e deixa um resumo útil; remover confirma o alvo.
- [ ] Cores predefinidas e personalizadas com amostras e contraste, preservando estilos da entrega de regras.
- [ ] Listas grandes permanecem navegáveis por teclado e em viewport estreito.
- [ ] Não é exigida cópia de sidebar do Coda; usar os componentes de camada existentes.

**Cenários:** UI com duas ou mais regras, edição/cancelamento/reabertura, tema claro/escuro e viewport estreito; persistência das configurações.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T11 — Barra compacta, filtros discretos e área útil de bancos

Origem: S2-15, S2-23, S2-28.

- [ ] Views à esquerda e opções/busca/filtro/ordenação à direita; abas com rolagem e indicação de continuidade quando não couberem, sem esconder ações.
- [ ] Chips mostram propriedade e estado ativo; condição completa surge ao abrir. Ícones de layout aparecem no seletor.
- [ ] Seção de vínculos começa recolhida e expande listas grandes sem perder navegação.
- [ ] Páginas novas de banco usam largura total por padrão; uma largura explicitamente escolhida em página existente é respeitada, sem migração ao abrir.
- [ ] Tabela inline/view não são forçadas a largura total da janela fora de seu bloco; estilo do bloco e da página permanecem distintos.
- [ ] Controle por teclado e viewport estreito continuam operáveis; no espaço insuficiente, não sobrepor ou cortar comandos.

**Cenários:** UI comparativa de página de banco, inline e view em larguras distintas; salvar filtros/abas e preservar preferências existentes.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T12 — Rodapé discreto e Novo antes dos cálculos

Origem: S2-12, S2-13.

- [ ] Ordem visual é registros, ação Novo, rodapé de cálculos.
- [ ] Fundo do rodapé acompanha o da tabela; ação de configurar é discreta, revelada por hover/foco.
- [ ] Resultados já configurados permanecem legíveis, com operação independente por propriedade/view.
- [ ] Conferir alinhamento em resize, scroll e congelamento, inclusive uma tabela sem resultados.
- [ ] Novo insere corretamente e não reaparece como registro exportado ou dado calculado.

**Cenários:** UI e comandos de criação de linha; regressão de cálculos/formatos e geometria relativa com rolagem e congelamento.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T13 — Views com título próprio e a mesma experiência da tabela inline

Origem: S2-19.

- [ ] Reutilizar apresentação/layouts existentes da tabela; não implementar outro banco nem copiar registros para uma view.
- [ ] O título visível identifica a view, alterável sem renomear fonte/outras views; rótulo da fonte fica em Opções.
- [ ] Remover seletores técnicos permanentes e Mostrar título residual; restaurar pelo painel acessível por teclado.
- [ ] Distinguir nome da view/bloco e nome da aba de layout; explicar os campos sem criar dois títulos concorrentes.
- [ ] Tipografia interna da tabela não herda acidentalmente o tamanho/cor de um título externo do canvas.
- [ ] Trocar fonte exige validar os IDs das propriedades e avisar sobre configurações incompatíveis, sem remapear silenciosamente por nomes.
- [ ] Salvar/reabrir duas views com títulos/filtros/layouts diferentes e conferir edição de dados sincronizada com a fonte.

**Cenários:** Comandos/serialização de views e UI comparativa inline-vinculada; duas views da mesma fonte, readonly, títulos ocultos e troca de fonte.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T14 — Preservar tabelas ao editar e converter blocos

Origem: S2-21.

- [ ] Registrar pacote/versão e sequência mínima sintética que diferencie remover, ocultar e deslocar um bloco.
- [ ] Conferir identidades, conteúdo do documento, schema, registros e arquivos antes/depois; não declarar perda de dados só por ausência visual.
- [ ] Conversões de título/alternador, exclusão de contêiner e confirmação de célula não descartam filhos sem intenção.
- [ ] Persistência e watcher preservam dados/desconhecidos; documento incompatível não é normalizado destrutivamente.
- [ ] Desfazer e reabrir preservam vínculos e conteúdo; exclusão intencional tem resultado inequívoco.
- [ ] Uma causa corrigida exige teste que falhe no caminho real; não fechar só por ausência de reprodução em outro ambiente.

**Cenários:** ProseMirror/documento → comandos/session → MemoryVault e reabertura real; UI da sequência sem substituir estado interno para fabricar o resultado.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T15 — Alternadores e recolhimento reversíveis e opcionais

Origem: S2-20.

- [ ] Conversão preserva texto, marks, nível do título, filhos, tabelas e identidades.
- [ ] Texto comum pode conter conteúdo recolhível sem precisar ser um título.
- [ ] Distinguir recolhimento de seção e do bloco de tabela; habilitação é opcional, alça discreta por hover/foco.
- [ ] Funciona em tabela inline e view; expansão e estado de recolhimento sobrevivem à reabertura.
- [ ] Menu comunica claramente converter/remover recolhimento e desfazer é reversível.
- [ ] Preservar toggles antigos e seu conteúdo por migração aditiva, sem removê-los em massa.

**Cenários:** Round-trip de documento e armazenamento; UI com títulos de níveis diferentes, texto comum, tabelas aninhadas, converter/remover e reabrir.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T16 — Navegação por títulos e restauração de rolagem entre abas

Origem: S2-05, S2-27.

- [ ] O botão efetivamente alterna o painel e expõe estado/rotulagem acessíveis.
- [ ] Títulos listados navegam ao destino correto, inclusive sob seções recolhidas com comportamento explícito.
- [ ] Cada aba guarda posição na sessão, independentemente das demais; voltar espera o conteúdo estar renderizado.
- [ ] Navegação explícita por âncora prevalece sobre posição lembrada; não saltar de novo depois que o usuário já começou a rolar.
- [ ] Persistência de rolagem após reiniciar não é prometida nesta entrega; não escrever páginas só para salvar posição.
- [ ] Conferir várias abas da mesma página e páginas distintas, viewport estreito e listas longas.

**Cenários:** UI de navegação com sumário e duas abas longas; mudanças de posição medidas relativamente, sem mocks de scroll usados como prova final.

**Evidência:** [`docs/evidence/scope-2/t16/REPORT.md`](../../evidence/scope-2/t16/REPORT.md) registra o UI build-03 completo. Navegação e restauração passaram. A variação diária de `recent.json` (+1) aponta para a edição explícita do fold (`batch.docs`), mas build-03 não gravou checkpoints de fase; o harness foi instrumentado para confirmar se a contagem ficou estável durante abertura/navegação e mudou na edição. A classificação histórica permanece preservada. O gate build-03 continua falhando pela regravação de bytes de `workspace.json`. O follow-up de intenção de usuário está somente na fonte e aguarda o UI04 de build-04. **Resultado: falhou; ticket não aceito.**

### T17 — Títulos com cor padrão do tema

Origem: S2-01.

- [ ] Hierarquias de títulos herdam a cor normal do texto do tema por padrão.
- [ ] Marks/cores escolhidas pelo usuário continuam representadas, sem reescrever o documento ao abrir.
- [ ] Tabelas dentro de blocos/títulos não recebem estilo de título por vazamento de CSS.
- [ ] Conferir claro/escuro, foco e seleção sem reduzir contraste.

**Cenários:** Inspeção visual em UI clara/escura com títulos padrão e coloridos explicitamente; regressão de marks no round-trip se a serialização for afetada.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T18 — Redimensionar imagens dentro e fora de colunas

Origem: S2-17.

- [ ] Alças acessíveis com resize contínuo e alternativa por teclado/configuração.
- [ ] Persistir dimensão de apresentação sem regravar pixels ou perder recorte/legenda/alinhamento.
- [ ] Duas imagens no mesmo grupo de colunas podem ter tamanhos independentes.
- [ ] Respeitar contêiner/viewport; cancelar restaura e confirmar gera uma operação, não um save por pixel.
- [ ] Inserir/substituir arquivo local continua funcionando, sem alterar a imagem original fora do vault.
- [ ] Conferir alinhamento com imagem menor, sem presumir falha do exemplo grande.

**Cenários:** Serialização/modelo de documento e UI com resize em imagem única e em colunas, cancelamento/desfazer e reabertura.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T19 — Larguras livres e persistentes nas colunas da página

Origem: S2-18.

- [ ] Larguras normalizadas/relativas são persistidas aditivamente; grupos antigos sem largura mantêm distribuição padrão.
- [ ] Arraste contínuo sem snap obrigatório, com mínimo operacional e indicação do destino.
- [ ] Resize apenas de layout, não das propriedades de banco; preservar filhos/IDs e imagens.
- [ ] Esc cancela, soltar confirma uma única operação e desfazer restaura.
- [ ] Conferir grupo de duas e sete colunas em viewport largo/estreito, sem gravar arquivos ao apenas abrir.

**Cenários:** Round-trip de atributos do documento, comandos e UI de resize contínuo; medir mudança de proporções e preservar todo conteúdo.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T20 — Remover colunas, inserir texto entre blocos e indicar o drop correto

Origem: S2-18.

- [ ] Ação de remover coluna é evidente; vazia pode ser removida por Backspace no limite apropriado, sem capturar edição de texto normal.
- [ ] Decisão de planejamento: coluna com conteúdo pede confirmação/prévia e conserva os blocos no fluxo após o grupo; descartar conteúdo é uma ação distinta e explícita.
- [ ] Ao retirar a estrutura, atualizar larguras das colunas restantes sem perder IDs/ordem dos filhos.
- [ ] Oferecer ponto visível/acessível para inserir parágrafo entre imagens/grupos sem precisar acertar poucos pixels.
- [ ] Mostrar um único destino de drop coerente com cima/baixo/lateral, com realce consistente.
- [ ] Cancelar, desfazer e reabrir preservam blocos, tabelas vinculadas e controles contidos.

**Cenários:** Documento/session/armazenamento e UI dos gestos de remover, inserir e arrastar; cenários com conteúdo não vazio e cancelamento.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T21 — Desfazer e refazer alterações de dados com histórico limitado

Origem: S2-22.

- [ ] Dados editados em duas views pertencem ao mesmo histórico do banco; desfazer não cria cópias independentes.
- [ ] Expor desfazer/refazer acessíveis, indicação do próximo efeito e estado indisponível.
- [ ] Reutilizar comandos tipados e recuperação existente; inversas validam conflitos antes de escrever.
- [ ] Nova edição invalida redo do escopo afetado; conflitos externos mostram recuperação sem sobrescrever silenciosamente.
- [ ] Dez entradas por banco na sessão; teto global inicial de 32 MiB descarta apenas entradas concluídas mais antigas, nunca recuperação pendente.
- [ ] Preservar recuperação persistida atual; não prometer dez ações persistentes após reiniciar.

**Cenários:** Editar via duas views, desfazer/refazer, exceder dez entradas, conflito externo, recuperação após interrupção e limites de memória.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T22 — Histórico contextual das configurações de cada visualização

Origem: S2-22.

- [ ] Manter dez ações de configuração por view durante a sessão, distintas das ações de dados do banco.
- [ ] Cobrir filtros, ordenação, título, ordem e ocultação de colunas; outra view permanece intacta.
- [ ] Desfazer contextual escolhe o evento aplicável mais recente e indica seu proprietário.
- [ ] Texto em edição usa seu desfazer nativo; não sequestrar atalhos de drafts.
- [ ] Conflitos e invalidação de redo seguem o escopo correto; abrir página não grava histórico nem modifica arquivos.

**Cenários:** Intercalar edição de dados e configuração de duas views; testar foco de editor, desfazer contextual, redo e reabertura.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T23 — Descoberta, edição e validação dos controles existentes

Origem: S2-29.

- [ ] Catálogo identifica texto, número, slider, select, checkbox, data e relation; slash aliases PT/EN/ES e menu contextual conduzem às configurações.
- [ ] Editar valor sem confundir nome, valor padrão e formato; padrão só atua ao criar ou resetar.
- [ ] Restrições de texto simples/e-mail/número têm mensagens claras e permitem draft temporariamente incompleto.
- [ ] Configurações permitem salvar/cancelar e mantêm IDs estáveis, acessibilidade e modo somente leitura.
- [ ] Valores alimentam fórmulas existentes e persistem sem descartar campos desconhecidos; nenhuma engine paralela.

**Cenários:** Inserir, editar, cancelar, resetar e reabrir cada tipo; consumir em fórmula/filtro; testar zero, falso, vazio e input inválido.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T24 — Controle de seleção múltipla integrado às fórmulas

Origem: S2-29.

- [ ] Opções e seleções usam identidades estáveis e sem duplicatas, compatíveis com o contrato do select existente.
- [ ] Busca e seleção funcionam por teclado; chips removíveis têm nomes acessíveis.
- [ ] Renomear opção preserva a seleção; remoção pede resolução explícita e não perde valores silenciosamente.
- [ ] Padrões, reset, readonly e reabertura preservam lista tipada; fórmulas e filtros consomem a lista sem strings de apresentação.

**Cenários:** Duas opções, renomear/remover, padrão/reset, lista vazia, fórmula/filtro e round-trip Markdown.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T25 — Controles de escala e progresso com valores numéricos

Origem: S2-29.

- [ ] Escala e progresso reutilizam validação numérica; mínimo, máximo e passo são explícitos e coerentes.
- [ ] Diferenciar entrada manual e resultado calculado, sem tornar resultado editável por acidente.
- [ ] Ícone, cor, legenda e valor acessível não dependem só de cor; teclado respeita limites.
- [ ] Persistir número tipado, não texto formatado; distinguir zero e vazio, respeitar padrão/reset e readonly.
- [ ] Fórmulas e filtros recebem o mesmo número apresentado; configuração inválida informa o problema.

**Cenários:** Limites/passos, zero/vazio, formato, teclado, reset, readonly e consumo de ambos em fórmula.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T26 — Controle de intervalo de datas e períodos rápidos

Origem: S2-29.

- [ ] Persistir par ordenado de datas ISO sem hora ou vazio, com início menor ou igual ao fim.
- [ ] Oferecer personalizado, hoje, últimos sete dias, mês atual e próximos sete dias; limites inclusivos e rótulos claros.
- [ ] Presets usam calendário local e relógio injetável nos testes; selecionar salva limites, abrir nota não recalcula nem grava.
- [ ] Interpretador recebe lista ordenada compatível com First/Last; não confundir com IDs de relation.
- [ ] Configuração, padrão/reset, teclado e readonly seguem controles existentes; data simples continua compatível.

**Cenários:** Datas invertidas, vazias, ano bissexto, mudança de mês/fuso/horário, filtros inclusivos e round-trip.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T27 — Resultados de fórmula realmente integrados ao texto

Origem: S2-30.

- [ ] Reutilizar CalculatedResult e bindings existentes; resultado e nome opcional cabem dentro de um parágrafo com texto antes/depois.
- [ ] Slash e menu contextual localizados abrem edição; salvar/cancelar preservam texto, marks e ID.
- [ ] Distinguir fórmula não preenchida, vazio, zero, falso e erro com diagnóstico compreensível.
- [ ] Usar editor e formatação compartilhados, sem campo textual ou interpretador concorrentes.
- [ ] Copiar, editar texto vizinho, desfazer e reabrir não removem nem duplicam o objeto.
- [ ] Exibir resultado vazio como [] discreto, distinto de erro e de fórmula ainda não configurada; atalho inicial confirmado é /formula, não assumir '=' como comando.

**Cenários:** Parágrafo com resultado no meio, teclado/IME, formatação, zero/falso/vazio/erro e save/reopen.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T28 — Referências nomeadas entre controles, resultados e tabelas

Origem: S2-30.

- [ ] Picker oferece objetos da página e referências explícitas entre páginas, com nome, tipo e origem; persistência por IDs.
- [ ] Nomes duplicados exigem desambiguação; renomear mantém vínculo e excluir produz diagnóstico, sem escolher correspondência aproximada.
- [ ] Controles alimentam resultados, resultados alimentam outros resultados, tabelas e filtros; atualizações chegam sem edição manual adicional.
- [ ] Detectar ciclos locais e entre páginas/tabelas, com avaliação limitada e mensagem estável.
- [ ] Copiar objetos remapeia IDs internos da cópia e preserva referências externas; nunca executar eval, rede ou ações.

**Cenários:** Rede sintética controle→resultado→tabela/filtro, rename/delete, duplicação, ambiguidade, ciclos e volume limitado de recálculos.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T29 — Preferência de fundo dos resultados por nota

Origem: S2-30.

- [ ] Preferência global define novas notas e inicia ativada; criação registra a escolha da nota.
- [ ] Cada nota pode sobrescrever a preferência; alterar padrão global não reescreve notas existentes.
- [ ] Notas legadas sem campo mantêm apresentação anterior com fundo, sem gravação ao abrir.
- [ ] Sem fundo, resultado mantém foco/hover, leitura e acesso à configuração; readonly funciona.
- [ ] Preferências e overrides sobrevivem à reabertura e preservam metadados desconhecidos.

**Cenários:** Nova nota antes/depois de trocar padrão, override local, legado sem campo, readonly, light/dark e abertura sem escrita.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**

### T30 — Validação integrada do Aumento de Escopo 2

Origem: S2-01, S2-02, S2-03, S2-04, S2-05, S2-06, S2-07, S2-08, S2-09, S2-10, S2-11, S2-12, S2-13, S2-14, S2-15, S2-16, S2-17, S2-18, S2-19, S2-20, S2-21, S2-22, S2-23, S2-24, S2-25, S2-26, S2-27, S2-28, S2-29, S2-30.

- [ ] Matriz relaciona cada item original e subcritério ao ticket, cenário e evidência; nenhum item passa apenas por ter controle visível.
- [ ] Executar checks existentes e CI no commit final; preservar falhas conhecidas e registrar resultados reais.
- [ ] Validar pacote desktop real: clipboard do sistema, controles, views, escrita no disco, reabertura, readonly, temas, painel estreito e PT/EN/ES.
- [ ] Usar dados sintéticos; verificar ausência de escritas ao abrir e medir comportamento com mil linhas sem prometer benchmarks inventados.
- [ ] Produzir imagens/GIFs sintéticos conforme política de release, separando base oficial e melhorias do fork; revisão independente posterior.
- [ ] Não publicar release, instalar aplicativo nem executar esta fase durante o planejamento atual; essas ações exigem a próxima autorização.

**Cenários:** Aceitação integrada real, regressões de persistência e recovery; relatório por item com versão, passos, esperado/observado e evidência.

**Evidência futura:** versão/commit, passos, esperado, observado, arquivo sintético/medição e resultado dos testes. **Resultado: não executado.**
