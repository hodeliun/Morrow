# Histórico das modificações do fork

O Morrow original e este fork têm versões independentes. A tela **Sobre** mostra a versão da base oficial, a versão das modificações e a revisão oficial exata. O campo `version` do pacote combina ambas apenas para identificar executáveis: `<base>-fork.<modificações>`.

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
