# T30 — Validação integrada do Aumento de Escopo 2

Implementação e validação integrada de [T30 / #81](https://github.com/hodeliun/Morrow/issues/81).
Grupo de publicação: E002-D09 — Aceitação integrada e evidências.
Branch: `codex/t30-integrated-acceptance`.

---

## 1. Visão Geral e Fronteira de Versão

Esta entrega consolida a validação integrada dos trinta itens originais do Aumento de Escopo 2 (`S2-01` a `S2-30`), organizados nos tickets `T01` a `T30`.

- **Base oficial Upstream:** Morrow `1.3.0` (`13ce1908ac7777a16161b5ef0c013de5eadcb3a1`).
- **Versão própria do Fork:** `1.2.0`.
- **Identificador de pacote integrado:** `1.3.0-fork.1.2.0`.
- **Separação estrita (Política de Release):**
  - **Base oficial Upstream (`1.3.0`):** Restauração oficial de posição de leitura e cursor em nota, preferência de verificação ortográfica por cofre, proteção e persistência de abas fixadas, paleta de nova aba, campo `archivedAt` e arquivamento/restauração na barra lateral, serialização oficial `<details open>`.
  - **Melhorias e correções do Fork (`1.2.0`):** Bancos de dados locais no formato 13 (`titleAlias`, `displayPropertyId`), linked views com títulos e ordenação de colunas independentes, seleção aditiva na margem e menu compacto, rodapé discreto com Novo antes dos cálculos, regras condicionais tipadas por célula/linha em cartões recolhíveis, editor de fórmulas com cursor alinhado e autocomplete, 11 controles nomeados com IDs estáveis (`text`, `number`, `slider`, `select`, `checkbox`, `date`, `relation`, `multiSelect`, `scale`, `progress`, `dateRange`), resultados de fórmulas inline, rede de referências nomeadas entre páginas com detecção de ciclo, preferência de fundo de resultados por nota, colunas de conteúdo com larguras livres e remoção segura, tamanho individual de imagens e histórico limitado de dados (10 passos / 32 MiB) e de configuração por visualização (10 passos).

---

## 2. Matriz de Rastreabilidade Completa (S2-01..S2-30 → T01..T30)

| Item | Ticket | Issue | PR / Commit | Relatório e Registro de Evidência | Captura Sintética / Contrato Verificado | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **S2-01** | T17 | #68 | `28debc9` (build 17/23) | `docs/integration/1.3.0-fork-1.2.0.md` | `docs/integration/assets/1.3.0-fork-1.2.0/reversible-headings-narrow.png` | Aprovado |
| **S2-02** | T03 | #54 | PR #99 (`a416cab`) | `docs/deliveries/T03-name-display-property.md` | `docs/deliveries/assets/T03/alias-collision-pt-dark.png` | Aprovado |
| **S2-03** | T03 | #54 | PR #99 (`a416cab`) | `docs/deliveries/T03-name-display-property.md` | `docs/deliveries/assets/T03/display-property-eye.png` | Aprovado |
| **S2-04** | T05 | #56 | PR #101 (`f2f4c0f`) | `docs/deliveries/T05-additive-row-selection.md` | `docs/deliveries/assets/T05/row-selection-420.png` | Aprovado |
| **S2-05** | T16 | #67 | `28debc9` (build 20/23) | `docs/integration/1.3.0-fork-1.2.0.md` | `docs/integration/assets/1.3.0-fork-1.2.0/four-panes-wide.png` | Aprovado |
| **S2-06** | T07 | #58 | PR #98 (`3d2ce66`) | `docs/deliveries/T07-readable-property-panels.md` | `docs/deliveries/assets/T07/manual-property-settings.png` | Aprovado |
| **S2-07** | T01 | #52 | `28debc9` (build 23) | `docs/integration/1.3.0-fork-1.2.0.md` | `src/app/platform/clipboard.test.ts` e `docs/integration/validation-1.3.0-fork.1.2.0.json` | Aprovado |
| **S2-08** | T07 | #58 | PR #98 (`3d2ce66`) | `docs/deliveries/T07-readable-property-panels.md` | `docs/deliveries/assets/T07/fill-preview-pt-dark.png` | Aprovado |
| **S2-09** | T04 | #55 | PR #100 (`dda416c`) | `docs/deliveries/T04-view-column-order.md` | `docs/deliveries/assets/T04/column-drop-target.png` | Aprovado |
| **S2-10** | T08 | #59 | `28debc9` (build 23) | `docs/integration/1.3.0-fork-1.2.0.md` | `src/app/components/database/FormulaEditor.test.ts` e `docs/integration/validation-1.3.0-fork.1.2.0.json` | Aprovado |
| **S2-11** | T07 | #58 | PR #98 (`3d2ce66`) | `docs/deliveries/T07-readable-property-panels.md` | `src/app/components/database/formatCatalogs.test.ts` e `docs/deliveries/assets/T07/manual-property-settings.png` | Aprovado |
| **S2-12** | T12 | #63 | PR #97 (`97cafd5`) | `docs/deliveries/T12-compact-table-footer.md` | `docs/deliveries/assets/T12/compact-footer-pt-dark.png` | Aprovado |
| **S2-13** | T12 | #63 | PR #97 (`97cafd5`) | `docs/deliveries/T12-compact-table-footer.md` | `docs/deliveries/assets/T12/readonly-footer.png` | Aprovado |
| **S2-14** | T05 | #56 | PR #101 (`f2f4c0f`) | `docs/deliveries/T05-additive-row-selection.md` | `docs/deliveries/assets/T05/selection-menu-pt-dark.png` | Aprovado |
| **S2-15** | T11 | #62 | `28debc9` (build 23) | `docs/integration/1.3.0-fork-1.2.0.md` | `docs/integration/validation-1.3.0-fork.1.2.0.json` (3 capturas estreitas PT/EN/ES no build 23) | Aprovado |
| **S2-16** | T09, T10 | #60, #61 | `28debc9` (build 23) | `docs/integration/1.3.0-fork-1.2.0.md` | `docs/integration/validation-1.3.0-fork.1.2.0.json` (temas claro/escuro PT/EN/ES no build 23) | Aprovado |
| **S2-17** | T18 | #69 | PR #94 (`7e5a412`) | `docs/deliveries/T18-image-sizing.md` | `docs/deliveries/assets/T18/independent-widths.png` | Aprovado |
| **S2-18** | T19, T20 | #70, #71 | PR #93 (`3f560ff`) e build 16 | `docs/deliveries/T20-layout-columns.md` | `docs/integration/assets/1.3.0-fork-1.2.0/content-columns.png` e `docs/deliveries/assets/T20/paragraph-between-blocks.png` | Aprovado |
| **S2-19** | T13 | #64 | PR #102 (`63c20cd`) | `docs/deliveries/T13-view-titles.md` | `docs/deliveries/assets/T13/independent-views.png` | Aprovado |
| **S2-20** | T15 | #66 | `28debc9` (build 16/23) | `docs/integration/1.3.0-fork-1.2.0.md` | `docs/integration/assets/1.3.0-fork-1.2.0/reversible-headings-narrow.png` | Aprovado |
| **S2-21** | T14 | #65 | PR #105 (`7ebdd2c`) e build 20 | `docs/deliveries/T14-document-integrity.md` | `docs/assets/T14/conversion.png` e `docs/deliveries/T14-validation.json` | Aprovado |
| **S2-22** | T21, T22 | #72, #73 | PRs #103 (`6e8f079`) e #104 (`3e1b57c`) | `docs/deliveries/T21-data-history.md` e `docs/deliveries/T22-view-history.md` | `docs/deliveries/assets/T21/history-controls-pt-dark-520.png` e `docs/deliveries/assets/T22/contextual-history.png` | Aprovado |
| **S2-23** | T11 | #62 | `28debc9` (build 23) | `docs/integration/1.3.0-fork-1.2.0.md` | `docs/integration/validation-1.3.0-fork.1.2.0.json` (chips de filtros e barra de views em PT/EN/ES) | Aprovado |
| **S2-24** | T02 | #53 | `28debc9` (build 20/23) | `docs/integration/1.3.0-fork-1.2.0.md` | `src/app/components/database/cellEditing.test.ts` e `docs/integration/validation-1.3.0-fork.1.2.0.json` | Aprovado |
| **S2-25** | T07 | #58 | PR #98 (`3d2ce66`) | `docs/deliveries/T07-readable-property-panels.md` | `docs/deliveries/assets/T07/inverse-labels-es.png` | Aprovado |
| **S2-26** | T06 | #57 | `28debc9` (build 23) | `docs/integration/1.3.0-fork-1.2.0.md` | `src/core/delivery4.test.ts` e `docs/integration/validation-1.3.0-fork.1.2.0.json` (27 asserções) | Aprovado |
| **S2-27** | T16 | #67 | `28debc9` (build 20/23) | `docs/integration/1.3.0-fork-1.2.0.md` | `src/app/readingPlace.test.ts` e `docs/integration/validation-1.3.0-fork.1.2.0.json` | Aprovado |
| **S2-28** | T11 | #62 | `28debc9` (build 23) | `docs/integration/1.3.0-fork-1.2.0.md` | `src/core/vault/pageFile.test.ts` e `docs/integration/validation-1.3.0-fork.1.2.0.json` | Aprovado |
| **S2-29** | T23–T26 | #74–#77 | PRs #106, #107, #108, #109 | `docs/deliveries/T23-existing-controls.md`, `docs/deliveries/T24-multiple-selection-control.md`, `docs/deliveries/T25-scale-progress-controls.md`, `docs/deliveries/T26-date-range-controls.md` | `docs/assets/T23/configuration-pt-dark.png`, `docs/assets/T24/typed-list-filter.png`, `docs/assets/T25/configuration-es-light.png`, `docs/assets/T26/range-pt-dark-520.png` | Aprovado |
| **S2-30** | T27–T29 | #78–#80 | PRs #110, #111, #112 | `docs/deliveries/T27-inline-formula-results.md`, `docs/deliveries/T28-named-reference-network.md`, `docs/deliveries/T29-formula-background.md` | `docs/assets/T27/inline-results-520.png`, `docs/assets/T28/network-pt-dark-520.png`, `docs/assets/T29/legacy-background-and-override.png` | Aprovado |

---

## 3. Suíte de Validação Integrada Automatizada (`src/core/scope2IntegratedAcceptance.test.ts`)

A nova suíte automatizada cobre a interação real entre os 30 itens e verifica 4 critérios nucleares:

### 3.1. Abertura Sem Escrita (`Open Without Writing`), Rede de Referências e Round-Trip de Persistência
- **Cenário executado:** Um cofre sintético complexo composto por notas com colunas livres (`data-widths="40,60"`), imagens com alinhamento e largura própria (`width="45%"`), alternadores recolhíveis (`<details open>`), 6 tipos de controles tipados (`number`, `select`, `multiSelect`, `scale`, `progress`, `dateRange`), resultado de fórmula inline com override de fundo (`morrowCalculatedResultBackground: false`), referências cruzadas entre páginas (`Global Tax * 100`, `First(Fiscal Quarter)`, `Last(Fiscal Quarter)`), detecção de ciclo em resultado autorreferenciado, banco de dados com `titleAlias`, `displayPropertyId`, ordenação por view, regras condicionais e linked view independente.
- **Resultado:**
  - Abertura e inspeção completas despacharam **0 operações de escrita** para o disco (`appliedWrites = []`). O fechamento da sessão também gerou zero escritas.
  - No round-trip completo (`execute → flush → close → reopen`), as mutações de controle (`page.control.setValue`) e de ordem de colunas da view (`database.set`) foram persistidas mantendo os metadados desconhecidos (`futureRootMetadata`, `futureDatabaseProp`), e a reabertura subsequente realizou **0 escritas adicionais**.

### 3.2. Comportamento e Medição Real com 1.000 Linhas em Banco Sintético
Banco de dados sintético com 1.000 linhas geradas contendo propriedades de texto, número, categoria (`select`) e fórmula calculada (`thisRow.Score * 2`).
Medições reais obtidas com `performance.now()` nesta VM Linux:
- **Avaliação de fórmula (célula individual):** `0,60–2,73 ms` (cálculo exato de dobro: `500 * 2 = 1.000`).
- **Avaliação de regras condicionais (1.000 células):** `43,82–56,46 ms` (200 células com score > 800 destacadas).
- **Filtragem de linhas (1.000 linhas):** `1,51–5,76 ms` (334 linhas da categoria 'Alpha' filtradas).
- **Ordenação (1.000 linhas):** `1,32–1,54 ms` (ordenação descendente por score: primeiro item 1.000, último item 1).
- **Seleção aditiva (50 linhas):** `1,24–1,59 ms` (inclusão de 50 checkboxes e desmarcação pontual).
- **Agregação de rodapé (1.000 linhas):** `1,77–2,23 ms` (soma: 500.500; média: 500,5; mínimo: 1; máximo: 1.000).

*Nota: Não foram inventados nem extrapolados benchmarks teóricos; estes tempos refletem a medição direta em memória do runtime.*

### 3.3. Histórico de Dados (10 passos / 32 MiB) e Histórico Contextual por View (10 passos)
- **Cenário executado:** Intercalação de alterações de dados em linhas com alterações de configuração em visualizações.
- **Resultado:**
  - Evicção automática ao atingir 10 entradas na pilha de undo para cada domínio, respeitando o teto global de 32 MiB.
  - Contextual history (`getContextualHistory` / `stepContextualHistory`) desfaz na ordem cronológica correta: desfazer em view reverte a configuração da view sem afetar dados do banco; desfazer de dados reverte o valor da célula sem afetar visualizações.
  - Nova mutação invalida imediatamente o histórico de redo do escopo afetado.

### 3.4. Internacionalização (PT/EN/ES), Contraste Claro/Escuro e Modo Somente Leitura (`Readonly`)
- **i18n:** Validação das traduções em Português (`pt`), Inglês (`en`) e Espanhol (`es`) para clipboard, seleção aditiva, rodapé, painéis de propriedades e ações comuns com interpolação de parâmetros (`{count}`, `{name}`).
- **Temas claro/escuro e estilos condicionais:** Verificação de contraste de texto para fundos claros e escuros (`contrastTextForHex`) e precedência por atributo em regras condicionais sobrepostas (`resolveConditionalFormatForCell` combinando `backgroundColor`, `textColor`, `bold` e `italic`).
- **Readonly:**
  - `isColumnReadOnly` bloqueia edição em colunas calculadas (fórmula, createdTime, lastEditedTime, button).
  - Páginas com formato malformado ou não reconhecido são isoladas como `unreadable`. Tentativas de mutação (`page.setDoc`, `database.set`) são rejeitadas com erro (`protected from changes`) e nenhuma alteração é gravada no disco.

---

## 4. Catálogo de Evidências Sintéticas por Fluxo de Usuário

Todas as imagens sintéticas abaixo pertencem aos registros auditados em `docs/integration/assets/1.3.0-fork-1.2.0/`, `docs/deliveries/assets/` e `docs/assets/`, sem qualquer dado pessoal:

### 4.1. Edição, Títulos, Alternadores, Imagens e Colunas (T14, T15, T16, T17, T18, T19, T20)

![Títulos reversíveis em janela estreita](../integration/assets/1.3.0-fork-1.2.0/reversible-headings-narrow.png)

![Colunas de conteúdo com larguras livres](../integration/assets/1.3.0-fork-1.2.0/content-columns.png)

![Dimensionamento independente de imagens](assets/T18/independent-widths.png)

![Inserção de parágrafo entre blocos de colunas](assets/T20/paragraph-between-blocks.png)

![Preservação de tabelas ao converter blocos](../assets/T14/conversion.png)

### 4.2. Tabelas, Bancos de Dados, Painéis e Visualizações Vinculadas (T03, T04, T05, T07, T12, T13)

![Indicador de propriedade de exibição](assets/T03/display-property-eye.png)

![Reordenação de colunas por visualização](assets/T04/column-drop-target.png)

![Seleção aditiva de linhas e menu compacto](assets/T05/selection-menu-pt-dark.png)

![Prévia de preenchimento sem recorte](assets/T07/fill-preview-pt-dark.png)

![Rodapé compacto e cálculos](assets/T12/compact-footer-pt-dark.png)

![Visualizações vinculadas com títulos independentes](assets/T13/independent-views.png)

### 4.3. Controles Nomeados, Fórmulas Inline, Referências e Fundo por Nota (T23, T24, T25, T26, T27, T28, T29)

![Configuração de controles existentes](../assets/T23/configuration-pt-dark.png)

![Controle de seleção múltipla em filtro tipado](../assets/T24/typed-list-filter.png)

![Controles de escala e progresso](../assets/T25/configuration-es-light.png)

![Controle de intervalo de datas](../assets/T26/range-pt-dark-520.png)

![Resultados de fórmula inline](../assets/T27/inline-results-520.png)

![Rede de referências nomeadas entre páginas](../assets/T28/network-pt-dark-520.png)

![Preferência de fundo de resultados por nota](../assets/T29/legacy-background-and-override.png)

### 4.4. Histórico Limitado de Dados e Visualizações (T21, T22)

![Histórico limitado de dados em banco](assets/T21/history-controls-pt-dark-520.png)

![Histórico contextual por visualização](assets/T22/contextual-history.png)

---

## 5. Falhas e Limites Históricos Preservados

1. **Ressalva de mtime em `recent.json` (T17):** O arquivo de metadados de cofres recentes atualiza seu timestamp na abertura intencional do cofre. Os documentos Markdown mantêm bytes, tamanho e mtime idênticos.
2. **Separação entre provas desktop Windows e automação Linux:** As provas empacotadas de integração desktop (ASAR reader 3.4.1, IPC seguro de clipboard e executável Windows) foram consolidadas nos relatórios prévios autorizados (`scope-2-build-16/20/23` em `docs/integration/validation-1.3.0-fork.1.2.0.json`) e nas entregas individuais `T03–T29` com CI Windows/Linux na `main`. A validação do ticket T30 executou a suíte integrada automatizada no ambiente Linux VM local, preservando fielmente a fronteira entre as provas empacotadas já auditadas e a suíte integrada atual.
3. **Escopo estritamente local:** Nenhuma release pública foi gerada, nenhum instalador foi criado e nenhum push remoto foi efetuado, respeitando integralmente as diretrizes do projeto.

---

## 6. Resultados do Gate Automatizado (`npm run check`)

O gate completo foi executado nesta branch com 0 erros:
- `npm run typecheck`: Sucesso (TypeScript 0 erros em `tsconfig.json` e `tsconfig.electron.json`).
- `npm run lint`: Sucesso (ESLint 0 erros, 0 avisos).
- `vitest run`: Sucesso (**1.253 testes aprovados em 158 arquivos**, incluindo os 6 testes integrados de `src/core/scope2IntegratedAcceptance.test.ts`).
- `npm run build`: Sucesso (Vite build cliente, Electron e MCP compilados com sucesso).

Registro estruturado da validação: [T30-validation.json](T30-validation.json).
