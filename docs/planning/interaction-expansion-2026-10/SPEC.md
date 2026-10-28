# Morrow — expansão de edição, tabelas e apresentação

Status (checkpoint de validação local pré-publicação, 28/10/2026): implementação autorizada no handoff de 28/10/2026; tickets #26–#43 estavam encerrados no GitHub. A execução unificada final passou nos cinco grupos e na integração de #44; Sol aprovou a validação local de #44 sem bloqueios. Nesse checkpoint, #25/#44 estavam abertas e não havia execução de CI após a correção local do teste de locale (o workflow observado falhou antes dela). O estado posterior da CI e o encerramento atual de #25/#44 são os registrados nas issues #25/#44 no GitHub, fonte autoritativa que prevalece sobre este snapshot. A proposta original foi examinada no commit 796496a, pacote 1.2.1-fork.1.0.1 sobre Morrow oficial 1.2.1. Esta especificação complementa as anteriores, sem substituir contratos de dados. O histórico da autorização e das verificações fica em [EXECUTION-2026-10-28.md](EXECUTION-2026-10-28.md).

## Problem Statement

Editar páginas e bancos exige muitos controles permanentes e passos inconsistentes. A grade ainda não oferece a seleção e manipulação por teclado/mouse esperadas de uma planilha. Alguns recursos já modelados — cores, relações inversas, resultados de fórmula e configurações por visualização — não aparecem de maneira completa ou previsível na interface. Há também sobreposição de menus e painéis fora da área visível.

## Solution

Entregar os vinte grupos de melhorias descritos na nota de escopo por comportamentos verificáveis: páginas com imagens e seções ajustáveis; tabelas com controles compactos e configurações descobríveis; grade com seleção, clipboard e preenchimento; fórmulas com referências reconhecidas e formatos equivalentes; relações inversas configuráveis com segurança. A documentação pública usa exemplos sintéticos. A nota, imagens e vídeos originais permanecem no vault pessoal.

## User Stories

1. Como autora, vejo uma amostra da cor de cada fundo predefinido e posso escolher uma cor personalizada.
2. Como autora, salvo e reabro esse fundo no Markdown sem perder sua cor nem o conteúdo.
3. Como autora, uso filtros rápidos em uma barra compacta acima da tabela, sem um formulário grande permanentemente aberto.
4. Como autora, vejo quais filtros estão ativos, edito-os em popovers e restauro seus valores iniciais.
5. Como autora, encontro as configurações de filtro, ordenação, layout, propriedades, cálculos e formatação em um botão de opções à direita.
6. Como autora, substituo uma imagem, escrevo sua legenda, alinho à esquerda/centro/direita e ajusto seu recorte.
7. Como autora, posso cancelar o recorte ou desfazê-lo preservando o arquivo original.
8. Como autora, acesso menus sem sobreposição com o sumário e sem opções cortadas, inclusive em página de largura total.
9. Como autora, habilito recolhimento em um título específico e recolho seu conteúdo até o próximo título de nível igual ou superior.
10. Como autora, reabro uma página com as mesmas seções recolhidas e posso desabilitar esse comportamento sem apagar texto.
11. Como editora de dados, clico uma vez para selecionar uma célula inteira e entro em edição explicitamente.
12. Como editora, Tab e Shift+Tab passam entre células visíveis, sem parar no botão de expandir linha.
13. Como editora, Enter inicia edição; Enter novamente confirma e segue para a próxima linha; Escape cancela o rascunho.
14. Como editora, setas navegam na grade e continuam editando texto/seletores quando esses editores estiverem ativos.
15. Como editora, seleciono um retângulo por arraste ou Shift+setas e copio/colo os valores com Ctrl+C/Ctrl+V.
16. Como editora, apago os valores de um intervalo com Delete/Backspace sem apagar as linhas.
17. Como editora, arrasto a alça de preenchimento para baixo ou lateralmente com prévia dos valores afetados.
18. Como editora, reconheço a seleção e continuo trabalhando após filtros, ordenação, colunas ocultas e congelamento.
19. Como editora, seleciono linhas pelo handle de seis pontos ou checkbox e seleciono/desmarco todas as linhas da visualização.
20. Como editora, abro o menu da linha para expandir, inserir antes/depois, copiar, duplicar, mover ou excluir.
21. Como editora, copio linhas inteiras incluindo propriedades ocultas e colo em outra tabela com mapeamento explícito e validação.
22. Como editora, reorganizo linhas manualmente quando não há ordenação e entendo por que o arraste fica indisponível com ordenação ativa.
23. Como autora, encontro “Editar coluna” no menu, procuro tipos por nomes em português ou inglês e reconheço seus ícones.
24. Como autora, personalizo o ícone de uma coluna, incluindo upload seguro, e posso voltar ao ícone padrão do tipo.
25. Como autora, vejo amostras e prévia de cores condicionais e posso usar uma fórmula booleana como critério.
26. Como autora, recolho uma tabela inserida e oculto seu título sem perder acesso a opções ou à origem.
27. Como autora, uma visualização vinculada tem o mesmo desenho de uma tabela inline e um nome próprio independente.
28. Como autora, vejo todas as visualizações vinculadas a um banco e navego até a página/bloco de cada uma.
29. Como editora, escolho “Calcular” em cada coluna de forma independente e vejo o rodapé discreto, alinhado à coluna.
30. Como editora, encontro cálculos de soma, média, mediana, mínimo, máximo, intervalo, contagens, vazios e percentuais compatíveis com cada tipo.
31. Como autora, crio até sete colunas de conteúdo arrastando um bloco para uma borda indicada visualmente.
32. Como autora de fórmulas, vejo referências resolvidas em contornos arredondados e completo campos relacionados após ponto com Tab.
33. Como autora, configuro um resultado de fórmula numérico com as mesmas opções de uma coluna numérica calculada, e o mesmo vale para outros formatos suportados.
34. Como autora, sou convidada a criar a relação inversa ao escolher a tabela destino, ou posso vinculá-la a uma coluna compatível existente depois.
35. Como mantenedora, reabro os arquivos com IDs estáveis, atributos desconhecidos preservados e erros de migração reportados sem perda silenciosa.

## Implementation Decisions

### Reuso e fronteiras

Preservar a arquitetura core → comandos → sessão/save queue → componentes. Não criar um segundo modelo de tabela, linguagem de fórmulas, resolvedor de relações ou sistema de estilos. O código já contém cores personalizadas, filtros rápidos, cálculos por coluna, relações inversas, nomes locais de views e sugestões após ponto; esta rodada corrige lacunas, apresentação e integração. Persistência adicional é aditiva, com defaults de leitura para arquivos antigos, validação e round trip Markdown/YAML. Alterações em massa usam comandos com validação completa antes de mutar e uma unidade de desfazer; falha de gravação é informada, preservando a recuperação existente. Não alegar atomicidade de filesystem entre vários arquivos.

### Layout, imagens e seções

- Cores personalizadas aceitam #RRGGBB; paleta mostra amostras, nome acessível, campo hexadecimal, limpar/cancelar e foco legível. Reusar o seletor já existente em vez de duplicar armazenamento.
- Substituição de imagem conserva alinhamento e legenda; ao trocar proporção, reinicia o recorte com prévia. Recorte é não destrutivo, com enquadramento normalizado persistido, aplicado no editor e PDF. Cancelar não altera nada; exportação Markdown conserva metadados legíveis e a referência original.
- Recolher título é opt-in por título H1–H6 do conteúdo, não pelo título da página. Faixa: irmãos seguintes no mesmo contêiner até título igual/superior. Títulos dentro de colunas/listas não recolhem fora do contêiner. Aninhamento conserva estados internos. Persistir habilitado/recolhido no documento; não transformar a seção em outro tipo de bloco nem apagar conteúdo. Busca, sumário e link para conteúdo oculto revelam os ancestrais necessários. PDF e exportação de texto incluem conteúdo completo.
- Até sete colunas de conteúdo por grupo, proporções positivas normalizadas e mínimo de largura; não confundir com colunas da tabela. Drop lateral indica posição e recusa o oitavo; mover entre grupos remove contêiner vazio sem perder blocos. Em telas pequenas, empilhar/refluir sem tornar conteúdo inalcançável. Desfazer e Markdown preservam ordem e larguras.
- Menus e painéis usam posicionamento ancorado com flip/shift, limite de altura com rolagem e camadas coerentes. Sumário deve reservar espaço ou recolher quando necessário. Preservar foco, Escape e retorno ao acionador; não elevar z-index arbitrariamente como única correção.

### Grade: foco, seleção, edição e mutação

- Estados distintos: célula ativa, intervalo selecionado e editor de célula. Um único ponto de Tab na grade (roving focus); botões de linha continuam alcançáveis pelo menu/atalho e tecnologias assistivas.
- Clique seleciona, duplo clique/Enter/F2 edita. Tab confirma e avança, Shift+Tab retrocede; Enter em edição confirma e vai abaixo; Shift+Enter confirma e vai acima; Escape cancela o rascunho e volta à seleção. Nas bordas, não criar linhas implicitamente; oferecer ação explícita. Em texto multilinha, Ctrl+Enter confirma, Enter insere linha. Setas de texto e menus pertencem ao editor enquanto ele está ativo. Colagem de imagem/Markdown no editor da página não é capturada pela grade sem foco.
- Retângulos seguem ordem visível de linhas e colunas, mas são vinculados por IDs estáveis. Filtro/ordenação revalida a seleção; linhas ocultas não são atingidas por operação de intervalo. Desaparecimento do foco leva à célula visível mais próxima com anúncio acessível.
- Clipboard de intervalo oferece TSV para interoperabilidade e payload tipado local versionado para preservar relações/datas/false/zero/null. Strings que começam com = permanecem dados e nunca executam código. Não transportar credenciais nem objetos executáveis. Células calculadas/sistema são somente leitura: recusar o lote inválido com localização, sem gravar parcialmente. Formatos incompatíveis pedem correção; não substituir silenciosamente por vazio.
- Delete/Backspace limpa valores selecionados; não exclui páginas. Colagem retangular inicia na célula ativa e respeita colunas visíveis; exceder linhas existentes exige confirmação com contagem. Valor único pode preencher o retângulo selecionado; matriz maior deve caber ou ser recusada. Não alterar esquema implicitamente.
- Preenchimento por alça repete padrões tipados e oferece cópia; números/datas com duas sementes válidas podem continuar sequência com prévia e opção explícita. Uma semente apenas copia. Relações/select repetem valores existentes, fórmulas calculadas continuam derivadas; não criar novas opções/relações nem inferir sequências de texto. Limite inicial de 1.000 células por ação, com aviso antes de ultrapassar e sem truncamento silencioso.
- Seleção de linhas é distinta de intervalo. Selecionar todas significa todas as linhas atualmente filtradas daquela visualização, nunca o banco inteiro oculto; checkbox do cabeçalho é triestado. Não confundir limpar seleção com excluir.
- Menu mínimo de linha: expandir, inserir antes/depois, copiar, duplicar, mover para tabela, mover para lixeira, selecionar/desmarcar. Handle permite reordenar quando não há sort; com sort ativo explicar o bloqueio. Excluir avisa que afeta a origem e todas as views e usa lixeira/desfazer existentes.
- Cópia de linha inclui título, conteúdo e propriedades ocultas, com IDs novos ao duplicar. Dentro da mesma tabela mapear IDs; entre tabelas mostrar mapeamento por nome/tipo sem supor mesma ordem. Fórmulas/sistema são recalculados no destino; campos não mapeados precisam ser exibidos antes de confirmar. Relações só são copiadas se destino/tipo forem compatíveis. Mover conserva identidade e relações externas quando válido; se houver dependência incompatível, recusar com diagnóstico. Não converter mudança de tabela em perda silenciosa de dados.

### Tabelas e visualizações

- Botão de opções à direita reúne seções de filtros, sorts, layout, propriedades, cálculos, formato e views vinculadas; ações diretas úteis continuam disponíveis. Barra rápida usa chips/controles compactos, operadores por tipo, estado ativo, remover e restaurar. Configuração do que aparece pertence à view; valores rápidos continuam locais/temporários como no contrato atual, sem modificar fórmulas da origem. Defaults compartilhados e colaboração do Coda não são introduzidos implicitamente.
- Título oculto e recolhimento são estados da apresentação inserida/visualização, não nome/esquema da origem. Mesmo sem título manter affordance discreta de reabrir/configurar. Views vinculadas usam o mesmo shell visual das inline, sem fundo extra, e nomes próprios; renomear uma view não renomeia a origem nem as demais. A lista de backlinks de views identifica página/bloco e conserva diagnósticos de origem ausente/ciclo.
- Rodapé “Calcular” oferece uma operação por coluna por view, selecionada independentemente. Mostrar somente cálculos ativos; herdar largura, alinhamento e formato da coluna, incluindo congelamento/scroll. Agregar apenas linhas filtradas da view. Operações: soma, média, mediana, min/max e intervalo para números/duração; min/max/intervalo para datas com unidade explícita; contagem de linhas/valores, distintos, vazios/não vazios e percentual vazio/não vazio para tipos compatíveis. False e zero contam como preenchidos. Conjunto vazio e denominador zero têm estado vazio explicado, sem NaN. Erro de fórmula não vira zero e aparece no diagnóstico. Não aplicar o mesmo cálculo a todas as colunas ao escolher uma.
- Regra condicional pode usar predicado simples existente ou fórmula pura com contexto thisRow, bindings por ID e resultado booleano. null não corresponde; tipo inválido/erro não colore e mostra diagnóstico. Prévia não grava. Preservar prioridade atual das regras e declarar a vencedora; paleta e cor personalizada com contraste. Escopo e persistência continuam por view.

### Colunas, fórmulas e relações

- Seletor pesquisável de tipos com aliases PT/EN, sem distinguir acentos/caixa, ícone por tipo e descrições úteis; label de menu reduzida a “Editar coluna”. Ícone de propriedade pertence ao esquema; alteração do tipo troca o padrão, mas conserva override explícito. Reusar catálogo licenciado/upload sanitizado das páginas, sem redistribuir ícones proprietários Notion.
- Tokens arredondados são decoração da expressão textual e bindings, não sintaxe alternativa. Autocomplete resolve alvo do relation após ponto inclusive múltiplas relações vazias e nomes com espaços; Tab insere somente sugestão ativa. Preservar caret, colagem, IME, navegação e fallback texto. Erro/ambiguidade não recebe aparência de referência válida.
- Separar cálculo de formato: uma fórmula com resultado Number expõe precisão, localidade, limites de apresentação e demais opções equivalentes à coluna Number calculada; demais formatos reutilizam seu editor. Configuração de validação/padrão não é oferecida como edição de valor derivado. Troca de formato conserva fórmula e bindings; resultado incompatível mostra diagnóstico, sem coerção silenciosa.
- Ao configurar relation, sugerir criar inversa ou escolher compatível existente; também disponível depois. Reusar o modelo de campo proprietário e inverso projetado. Vincular duas colunas já preenchidas exige prévia de união dos pares; conflitos de cardinalidade, vínculo existente ou destino incompatível bloqueiam sem perda. Criar/desvincular é explícito e reversível; ao desvincular materializar valores projetados conforme contrato seguro ou manter projeção até decisão, nunca apagar vínculos silenciosamente. Editar qualquer lado mantém consistência sem duplicar pares.

## Testing Decisions

Priorizar comportamento em comando/sessão/reabertura e MemoryVault, aproveitando testes atuais de relations, formulaEditorModel, database, commands e round trip Markdown. Testes de grade e layout precisam de interface sintética real, perfil isolado e execução oculta; interação visível somente na segunda tela se indispensável. Verificar mouse e teclado, desfazer/refazer, reinício, falha de gravação e migração de arquivos antigos. Não usar dados, imagens ou vídeos pessoais como fixtures públicas.

Cenários: (a) página sintética com sete colunas, imagem recortada e títulos aninhados; (b) grade com filtros, colunas ocultas/congeladas, relações, moedas, datas, zero/false/vazios e células calculadas; (c) duas views da mesma origem com nomes/filtros/cálculos próprios; (d) duas tabelas com relações já preenchidas antes de configurar inversa. Medir seleção/renderização com 1.000 linhas e mutações de 1.000 células; registrar duração e ausência de travamento perceptível, sem prometer benchmark não medido. Gate da integração: npm run check mais evidência de UI. Aprovação dos tickets só após seus critérios, não pelo label ready-for-agent.

## Out of Scope

Na versão inicial desta spec, implementação nesta rodada estava fora de escopo; a autorização posterior de 28/10 para executar os tickets #26–#44 está registrada em `EXECUTION-2026-10-28.md` e não altera os limites permanentes abaixo. Instalação/publicação de builds e alteração dos cofres originais continuam fora da issue #44, assim como colaboração/multiusuário, semântica completa de planilha Excel/Coda, execução de fórmulas arbitrárias, importação universal de clipboard HTML, edição destrutiva do arquivo da imagem, agrupamentos/pivot/chart novos e funções sem relação com os vinte itens. “No mínimo as mesmas operações do Coda” foi delimitado às operações de linha documentadas/observadas nesta rodada, não a uma promessa indefinida de paridade com todo o produto.

## Further Notes

Suposições do grilling interno: preservar dados prevalece sobre imitar atalhos perigosos; seleção de células não exclui páginas; filtro rápido não altera cálculos globais; nomes e estados locais de view não se propagam à origem. São decisões de planejamento, não respostas atribuídas a Carlos. Qualquer mudança futura de contrato deve atualizar a spec antes de implementar.

Foram lidos todos os itens e inspecionadas 27 imagens e amostras em 20%, 50% e 80% de dez vídeos locais (um vídeo adicional não estava ligado na nota). Isso não equivale à reprodução integral quadro a quadro. Evidência pública utiliza apenas requisitos sanitizados; originais permanecem privados.

Referências oficiais consultadas em 27/10/2026:
- [Coda: operações de linhas](https://help.coda.io/hc/en-us/articles/39555928459021-Add-select-and-delete-rows): seleção por handle, ações sobre linhas e diferença entre copiar linhas inteiras e intervalos visíveis.
- [Coda: filter bar](https://help.coda.io/hc/en-us/articles/39555885255949-Filter-tables-via-the-filter-bar): controles compactos por coluna e reset; o contrato local do Morrow permanece explícito acima.
