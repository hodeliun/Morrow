# Histórico das modificações do fork

O Morrow original e este fork têm versões independentes. A tela **Sobre** mostra a versão da base oficial, a versão das modificações e a revisão oficial exata. O campo `version` do pacote combina ambas apenas para identificar executáveis: `<base>-fork.<modificações>`.

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
