# Histórico das modificações do fork

O Morrow original e este fork têm versões independentes. A tela **Sobre** mostra a versão da base oficial, a versão das modificações e a revisão oficial exata. O campo `version` do pacote combina ambas apenas para identificar executáveis: `<base>-fork.<modificações>`.

## Entrega sequencial — catálogo e configuração dos controles existentes (fontes, sem novo download)

- Texto, número, slider, select, checkbox, data e relation têm entradas próprias
  no catálogo, aliases PT/EN/ES e ações para configurar, resetar e limpar.
- Valor atual, padrão e formato permanecem separados; drafts inválidos têm
  diagnóstico, Save/Cancel preservam IDs e o modo somente leitura é respeitado.
- Resultados e filtros usam a engine existente. Views recém-carregadas voltam
  a aceitar configuração e histórico sem exigir uma edição prévia de texto.

Detalhes e validação: [T23 — controles existentes](docs/deliveries/T23-existing-controls.md).
Formato 13 preservado; sem novo tipo de controle, instalador, tag ou release.

## Verificação histórica — integridade de tabelas em conversões

- Conversão, confirmação de célula, exclusão intencional de contêiner, desfazer
  e reabertura foram conferidos na interface oculta com dados sintéticos.
- Documentos, identidades, campos desconhecidos e arquivos de origem foram
  medidos separadamente da aparência visual. Nenhuma nova correção de produto,
  mudança de formato, compilação ou release é atribuída a esta verificação.

Detalhes: [T14 — integridade do documento](docs/deliveries/T14-document-integrity.md).

## Entrega sequencial — histórico contextual das views (fontes, sem novo download)

Base oficial Morrow 1.3.0 e formato persistido 13 mantidos.

- Cada view mantém dez configurações recentes, separadas dos dados; desfazer
  escolhe o evento aplicável mais recente e identifica seu proprietário.
- Dados e views compartilham o teto global de 32 MiB das entradas concluídas,
  protegendo recuperação pendente e respeitando o escopo de refazer.
- Busca, arraste e resize confirmam uma ação lógica; texto em edição conserva
  seu desfazer nativo. Conflitos são revalidados antes da aplicação.

Detalhes e validação: [T22 — histórico contextual](docs/deliveries/T22-view-history.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — histórico de dados por banco (fontes, sem novo download)

Base oficial Morrow 1.3.0 e formato persistido 13 mantidos.

- Views da mesma origem compartilham desfazer/refazer de dados, com rótulo do
  próximo efeito e controles acessíveis; bancos diferentes conservam escopos próprios.
- Dez ações recentes por banco durante a sessão e teto global de 32 MiB para
  entradas concluídas, preservando recuperação pendente e conflitos.
- Inversas tipadas revalidam dados/permissões; uma edição nova invalida redo
  afetado. A recuperação persistida existente continua sem prometer dez ações após reiniciar.

Detalhes e validação: [T21 — histórico limitado dos dados](docs/deliveries/T21-data-history.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — títulos próprios de visualizações (fontes, sem novo download)

Base oficial Morrow 1.3.0 e formato persistido 13 mantidos.

- Renomear ou ocultar o título da visualização não altera a origem ou outras views;
  restauração pelo teclado e escolha da origem ficam nas Opções.
- Títulos, filtros e layouts independentes compartilham os mesmos registros, com
  tipografia interna isolada e formatação condicional preservada.
- Trocar a origem avisa sobre IDs incompatíveis, vínculos anteriores e dados opacos;
  não remapeia por nomes nem descarta configurações silenciosamente.

Detalhes e validação: [T13 — títulos de visualizações](docs/deliveries/T13-view-titles.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — seleção aditiva de linhas (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0 e formato persistido 13.

- Cada checkbox alterna somente sua linha, sem modificadores; seleção geral,
  teclado e célula ativa mantêm seus comportamentos.
- Um menu de três pontos concentra as ações em lote. A margem discreta já
  existente aparece por hover/foco, sem deslocar as colunas.
- Menus e confirmações revalidam linhas e permissão de edição; bancos somente
  leitura não oferecem controles mutantes de linha.

Detalhes e validação: [T05 — seleção aditiva e ações de linha](docs/deliveries/T05-additive-row-selection.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — ordem de colunas por visualização (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0 e formato persistido 13; nenhuma sincronização
upstream ou nova mudança de formato nesta entrega.

- A alça do cabeçalho move Nome e propriedades comuns antes/depois de outra
  coluna, com destino vertical único e cancelamento por Escape.
- O menu acessível oferece movimento para esquerda/direita. Cabeçalho, corpo,
  Novo e cálculos acompanham a ordem, inclusive com congelamento e rolagem.
- Cada visualização mantém sua ordem ao reabrir, preservando o esquema,
  valores das linhas e posições reservadas de colunas ocultas/desconhecidas.

Detalhes e validação: [T04 — ordem por visualização](docs/deliveries/T04-view-column-order.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — Nome e propriedade de exibição (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0; nenhuma sincronização upstream nesta entrega.

- O cabeçalho Nome pode receber outro rótulo sem duplicar os títulos das páginas.
  Editar uma célula Nome continua renomeando a página com o mesmo ID.
- O menu permite escolher a propriedade de exibição do banco e voltar a Nome,
  com indicador acessível. Um override de relação continua distinto desse padrão.
- A remoção de uma propriedade comum identifica o alvo; a remoção de Nome fica
  indisponível com explicação, preservando a semântica dos títulos.
- Esta entrega introduz a fundação do formato persistido 13, com os contratos
  completos dos campos já definidos e migração 12→13 preservando os registros.
  Isso não declara entregues as interfaces dos outros tickets.

Detalhes e validação: [T03 — Nome e propriedade de exibição](docs/deliveries/T03-name-display-property.md)
e [contratos do formato 13](docs/SCHEMA-13.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — painéis de propriedades e seletores (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0; nenhuma sincronização upstream nesta entrega.

- A criação manual separa tipo e Adicionar e abre a configuração após sucesso;
  cancelar mantém a propriedade. Importar e duplicar não reabrem esse painel.
- Moeda e fuso podem ser pesquisados por código/nome, mantendo entradas livres
  apropriadas e valores válidos existentes que não aparecem no catálogo.
- A prévia de preenchimento usa as camadas compartilhadas para manter suas ações
  dentro da janela, inclusive no extremo direito da tabela, com foco e Escape.

Detalhes e validação: [T07 — painéis e seletores legíveis](docs/deliveries/T07-readable-property-panels.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — rodapé compacto das tabelas (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0; nenhuma sincronização upstream nesta entrega.

- A ação Novo aparece depois dos registros e antes dos cálculos, sem entrar nos
  dados exportados ou nos resultados. Os resumos continuam por propriedade/view.
- O rodapé acompanha o fundo da tabela; a configuração vazia aparece por hover
  ou foco, e os resultados configurados permanecem legíveis.
- A criação e a reabertura preservam metadados desconhecidos por identidade,
  evitando regravações desnecessárias e a volta de itens removidos. Mapeamentos
  de banco reconhecidos que não podem ser preservados ficam somente leitura.

Detalhes e validação: [T12 — rodapé compacto das tabelas](docs/deliveries/T12-compact-table-footer.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — áudio e vídeo locais (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0; nenhuma sincronização upstream nesta entrega.

- Arquivos de áudio e vídeo existentes no vault podem abrir em abas com controles
  de reprodução, posição, duração, volume e velocidade, sem cópia ou conversão.
- A mídia usa leitura por intervalos e recursos validados pelo processo principal.
  Ocultar ou fechar a aba, ou trocar de cofre, pausa e libera a reprodução.
- Arquivo indisponível e falha de decodificação recebem orientações distintas;
  o aplicativo não baixa codecs nem obtém arquivos remotos automaticamente.

Detalhes e validação: [T35 — áudio e vídeo locais](docs/deliveries/T35-media-file-tabs.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — imagens em abas próprias (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0; nenhuma sincronização upstream nesta entrega.

- Imagens existentes no vault podem abrir em uma aba com zoom, ajuste à área e
  informações do arquivo, sem criar notas nem copiar para attachments.
- SVG é apresentado como imagem; cada aba recebe acesso ao recurso validado pelo
  processo principal, liberado ao fechar ou trocar de cofre.
- A expansão dos alvos preserva abas e rotas existentes. Endereços web recebem
  uma mensagem de indisponibilidade nesta etapa; não carregam navegação remota.

Detalhes e validação: [T33 — imagens em abas próprias](docs/deliveries/T33-image-file-tabs.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — tamanho individual de imagens (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0; nenhuma sincronização upstream nesta entrega.

- Cada imagem pode usar uma largura de 1% a 100% do contêiner, inclusive em colunas,
  sem alterar o arquivo de imagem. Recorte, legenda e alinhamento são preservados.
- A alça oferece prévia contínua; o painel de largura fornece alternativa por
  teclado. Cancelar restaura a apresentação anterior, e confirmar o arraste grava
  uma única edição. Desfazer e reabrir mantêm o tamanho escolhido.
- Os controles se posicionam dentro da região visível e se ajustam a imagens
  pequenas, tipografia ampliada e mudanças para somente leitura.

Detalhes e validação: [T18 — tamanho individual de imagens](docs/deliveries/T18-image-sizing.md).
Esta entrada não representa instalador, tag ou release publicada.

## Entrega sequencial — composição em colunas (fontes, sem novo download)

Base oficial mantida em Morrow 1.3.0; nenhuma sincronização upstream nesta entrega.

- O menu permite remover uma coluna vazia ou confirmar o destino de seu conteúdo:
  preservar os blocos após o grupo ou descartá-los explicitamente. As larguras
  restantes são redistribuídas; cancelar e desfazer preservam o documento.
- A inserção de parágrafos antes/depois de imagens e grupos posiciona o foco no
  novo texto. O arraste mostra um único destino coerente acima, abaixo ou ao lado.
  Um parágrafo imediatamente anterior ao grupo pode ser solto na lateral para
  criar uma coluna; esse destino válido deixa de ser cancelado por engano.
- A leitura e a gravação mantêm os campos desconhecidos dos marcadores de imagem
  ao transformar colunas. Essa preservação não ativa uma nova interface de resize.

Detalhes, limites e validação: [T20 — composição em colunas](docs/deliveries/T20-layout-columns.md).
Esta entrada não representa instalador, tag ou release publicada.

## Modificações do fork 1.2.0 — base Morrow 1.3.0 (fontes validadas, não lançado)

Identificação do código: `1.3.0-fork.1.2.0`. A base oficial avança para
[`13ce190`](https://github.com/Aarav2709/Morrow/commit/13ce1908ac7777a16161b5ef0c013de5eadcb3a1),
preservando os 39 commits oficiais desde a base 1.2.1. Esta entrada não representa
um instalador, tag ou release publicada.

### Mudanças oficiais integradas

- A validação integrada do build 23 passou com 771 testes, seleção de células, fórmulas a 100/125/150%, painéis condicionais e smoke do pacote. O painel de fórmulas mantém o cursor alinhado e permanece dentro da janela com zoom. As provas e limitações constam no [relatório da integração](docs/integration/1.3.0-fork-1.2.0.md).

- Arquivamento de páginas, abas fixadas, histórico de propriedades e preferências de módulos da barra lateral e verificação ortográfica.
- Seleção de blocos pela margem, conversão de itens de lista, títulos de toggles e melhorias de emojis, imagens e conteúdo rico.
- Restauração da posição e do cursor ao reabrir. A integração usa uma única autoridade de leitura, com isolamento por cofre, aba e painel.
- A abertura distingue um endereço explícito das abas restauradas: respeita Home/Hoje, preserva o estado de “Onde parei” e mantém os demais painéis e históricos.

### Melhorias do fork nesta rodada

- Ponte nativa para clipboard tipado, edição de células, diagnósticos de fórmulas, regras condicionais e controles de visualizações.
- Preservação reversível de seções e títulos, estilos de página e colunas de conteúdo; layouts de até quatro painéis com rascunhos e leitura independentes.
- Catálogo de arquivos e preferências locais de abertura, com validação do recurso e do dispositivo; compatibilidade de links Markdown ao mover e renomear arquivos.

Escopo desta integração: T01, T02, T06, T08, T09, T10, T11, T14, T15, T16,
T17, T19, T31, T32 e T37. Os outros 24 tickets permanecem sem início e pausados.
O aceite anterior desses quinze tickets não substitui a validação da árvore integrada.

## Modificações do fork 1.1.1 — base Morrow 1.2.1 (28/10/2026)

Pacote: `1.2.1-fork.1.1.1`. A base oficial continua no commit
[`5e6392b`](https://github.com/Aarav2709/Morrow/commit/5e6392bb6425924abd30eec8a99b42aa8c953577),
sem nova sincronização upstream. Este download reúne as melhorias da versão
interna 1.1.0 e a estabilização abaixo, comparado à última release baixável 1.0.1.
Os downloads, hashes e resultados dos artefatos ficam na [release](https://github.com/hodeliun/Morrow/releases/tag/v1.2.1-fork.1.1.1).

### Estabilização do fork

- Criar uma relação inversa pela coluna passa a salvar o novo campo e os vínculos de retorno. Configurações inválidas, IDs repetidos e o limite de 200 colunas são rejeitados sem alterar parcialmente os bancos.
- Desfazer uma inserção continua funcionando após reabrir uma linha sem título. A recuperação reconhece o nome padrão salvo e continua protegendo edições reais.
- Menus e diálogos compartilham a ordem de camadas: seletor de ícones e Canvas rico aparecem acima das configurações; Escape e retorno de foco agem na camada correta.
- Ícones de colunas enviados como PNG ou SVG respeitam o tamanho do cabeçalho e do controle, inclusive após mudar o tipo, restaurar ou reabrir. Ícones de páginas permanecem preservados.
- Recolher visualizações vinculadas preserva a seleção do documento; ocultar o título também oculta o nome da origem, com controles para restaurar e abrir o banco.
- A alça de seis pontos seleciona linhas e abre suas ações, preservando atalhos, seleção múltipla e arraste.
- A barra concentra as configurações em **Opções**, com indicadores acessíveis de filtros e ordenação. **Propriedades** permanece acessível em modo de leitura, com alterações bloqueadas.
- Tabelas embutidas e vinculadas compartilham estilos de tabela, cabeçalho, células e rodapé. Cálculos seguem o alinhamento das células com os padrões e alinhamentos escolhidos, inclusive ao redimensionar, rolar ou congelar colunas.

### Recursos novos desde o último download

Os recursos preparados em 1.1.0 incluem fundos de bloco personalizados, recorte e
substituição de imagens, títulos recolhíveis, até sete colunas de conteúdo,
filtros e cálculos por visualização, formatação condicional, tipos e ícones
pesquisáveis, sugestões e formato de resultado de fórmulas, edição e seleção de
intervalos, preenchimento por arraste e operações de linhas com recuperação.
As [notas ilustradas](docs/releases/1.1.1/NOTES.md) apresentam os fluxos e exemplos.

### Verificação do candidato

`npm run check` passou na versão candidata com **473 testes em 61 arquivos**,
typecheck, lint e builds do renderer, Electron e MCP. A comparação dos 258
arquivos de entrada antes e depois confirmou fontes estáveis; o registro está em
[check-candidate.json](docs/evidence/stabilization-1.1.1/check-candidate.json).
A auditoria dos vinte itens e as demonstrações estão vinculadas nas notas.
A CI do commit final e a prova dos artefatos são registradas na release pela issue #49. A política durável está em
[RELEASE-POLICY.md](docs/RELEASE-POLICY.md).

## Modificações do fork 1.1.0 — base Morrow 1.2.1 (28/10/2026, ainda não lançado)

Identificação do pacote: `1.2.1-fork.1.1.0`; base oficial: commit
[`5e6392b`](https://github.com/hodeliun/Morrow/commit/5e6392bb6425924abd30eec8a99b42aa8c953577).
O número da versão foi preparado localmente; nenhum instalador ou release foi
publicado.

### Entregas funcionais

- **Entrega 1 —** [commit `f0a8146`](https://github.com/hodeliun/Morrow/commit/f0a8146): menus e painéis dentro da área visível (#26), fundos de bloco (#27), recorte e substituição de imagens (#30), seções recolhíveis (#31) e colunas de conteúdo até sete (#40).
- **Entrega 2 —** [commit `c359e19`](https://github.com/hodeliun/Morrow/commit/c359e19): opções e filtros compactos (#28), visualizações vinculadas (#29), formatação condicional (#38) e cálculos independentes no rodapé (#39).
- **Entrega 3 —** [commit `443f3db`](https://github.com/hodeliun/Morrow/commit/443f3db): tipos e ícones de propriedades (#37), sugestões de campos relacionados (#41), formato de resultados de fórmula (#42) e relações inversas (#43).
- **Correções de revisão —** [commit `049de4d`](https://github.com/hodeliun/Morrow/commit/049de4d): controles de imagem, ícones de propriedades, editor de fórmulas, autocomplete e distinção de `false` em relação a resultado vazio; verificação das entregas 1–3 exercita os fluxos de interface com fixtures sintéticas.
- **Entrega 4 —** [commit `6c79867`](https://github.com/hodeliun/Morrow/commit/6c79867): foco e edição de células, navegação por teclado, seleção/clipboard de intervalos e preenchimento com prévia e desfazer (#32–#34).
- **Entrega 5 —** [commit `d3ee63e`](https://github.com/hodeliun/Morrow/commit/d3ee63ecdfbb8f345e8bd4b81354ecec0af7855c): seleção e operações de linhas, transferência entre tabelas com mapeamento seguro e journal recuperável (#35–#36).

### Verificação local de 28/10

`npm run check` passou localmente com 57 arquivos de teste e 440 testes, além de
typecheck, lint e builds do renderer, Electron e MCP. A execução unificada final
de UI passou nas cinco entregas e na integração sintética de #44, incluindo About
em inglês/espanhol/português, PDF de três páginas e operações verificadas com
1.000 linhas. Um timeout anterior da entrega 5 não se reproduziu na execução
diagnóstica standalone nem nesta rodada; sua causa permanece indeterminada. O
estado completo e as limitações estão em
[`docs/evidence/interaction-expansion-final.md`](docs/evidence/interaction-expansion-final.md)
e no JSON gerado pelo harness. Neste checkpoint pré-publicação de 28/10/2026, a
revisão Sol aprovou a validação local de #44 sem bloqueios, e a CI ainda não havia
sido executada após a correção local do teste de locale. O estado posterior da CI
e o encerramento atual de #25/#44 são os registrados no GitHub; essas issues são
a fonte autoritativa.

Neste checkpoint, issues #25 e #44 estavam abertas. Este registro não afirma
aprovação de CI; consulte as issues #25/#44 no GitHub para o estado posterior.

## Modificações do fork 1.0.1 — base Morrow 1.2.1 (27/10/2026)

- A exportação em PDF deixa de incluir o botão **Estilo da página** na folha impressa.
- Validação de interface em perfil oculto: importação de ZIP sintético no formato Notion, edição e restauração pelo histórico, e exportação de PDF pelo menu da página.
- Nenhum dado pessoal ou instalação do usuário foi usado nessa validação.

## Modificações do fork 1.0.0 — base Morrow 1.2.1 (27/10/2026)

Base oficial: [Morrow 1.2.1](https://github.com/Aarav2709/Morrow/releases/tag/v1.2.1), commit [`5e6392b`](https://github.com/Aarav2709/Morrow/commit/5e6392bb6425924abd30eec8a99b42aa8c953577). Identificador do pacote: `1.2.1-fork.1.0.0`.

### Herdado do Morrow original

- Editor: alça de blocos dentro de listas e toggles, conversão entre tipos de bloco, Backspace na primeira linha, formatação de código em linha e ajustes de espaçamento.
- Dados e navegação: desfazer em campos de propriedades, versões de página com propriedades, botões de voltar/avançar do mouse e idioma da nota diária.
- Importação e exportação: listas de conteúdo e checklists do Notion, PDF sem realces de hover e com margens claras no tema escuro.
- Assistente local e janela: rede para respostas longas do modelo, diagnóstico de falhas e botões da janela coerentes com o tema.

### Acrescentado pelo fork

- Bancos de dados locais com tipos adicionais, relações direcionadas, coluna de exibição, visualizações vinculadas e filtros rápidos por visualização.
- Fórmulas com referências de linha e projeção de relações, `IfError`, editor com sugestões e prévia de resultados.
- Padrões sequenciais, formatação numérica, menu contextual de colunas, duplicação com ou sem valores, congelamento, largura ajustável e altura de linha.
- Páginas com largura configurável, colunas de texto redimensionáveis, cores personalizadas e ícones configuráveis.
- Metadados e persistência Markdown do fork, com testes de compatibilidade e cenários sintéticos.

### Integração

O merge preservou os controles próprios de fundo de bloco, os campos de banco e o espaçamento por nota. Seis conflitos foram resolvidos: README, manifesto, lockfile, campo de propriedade, menu do editor e CSS do editor. O número antigo `1.2.4` era um rótulo de build do fork sobre a base oficial 1.2.0; não indicava a presença das correções oficiais 1.2.1.

## Regra para os próximos lançamentos

- `morrowBaseVersion` e `morrowBaseCommit` mudam apenas após integrar e validar um commit oficial identificado.
- `forkVersion` segue SemVer próprio: correção interna incrementa patch; recurso compatível incrementa minor; mudança incompatível incrementa major.
- `version` do pacote combina as duas séries no formato acima. O changelog registra separadamente correções herdadas e alterações criadas aqui.
- Toda publicação informa o commit do fork, o commit oficial usado como base, o resultado dos testes e o checksum do artefato. Lançamentos anteriores permanecem identificados pelos seus rótulos históricos.
