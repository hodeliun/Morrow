# Histórico das modificações do fork

O Morrow original e este fork têm versões independentes. A tela **Sobre** mostra a versão da base oficial, a versão das modificações e a revisão oficial exata. O campo `version` do pacote combina ambas apenas para identificar executáveis: `<base>-fork.<modificações>`.

## Ainda não lançado — base Morrow 1.2.1

- Grade de banco com foco e edição explícitos, navegação por teclado, seleção de intervalos, clipboard tipado/TSV e preenchimento por cópia ou sequência com prévia e desfazer.
- Correções de imagem: geometria e proporção do recorte, substituição imediata, proteção contra respostas assíncronas antigas e eventos dos controles isolados da seleção do editor.
- Seletor de ícones de propriedades funciona sem depender de uma página; autocomplete conserva a segunda sugestão ao navegar e inserir por Tab/Enter.
- Fórmulas de checkbox distinguem `false` de resultado vazio na apresentação.
- Roteiros das entregas anteriores verificam ações, dados persistidos e reabertura com fixtures sintéticas, builds estáveis e zero erros de renderer; evidências em `docs/evidence/interaction-expansion-prior-ui.md`.

Estas mudanças estão no código; o instalador publicado anteriormente não é atualizado automaticamente.

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
