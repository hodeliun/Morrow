# T39 — Validação integrada estendida (arquivos, navegação e painéis com o escopo anterior)

Implementação e validação integrada estendida de [T39 / #91](https://github.com/hodeliun/Morrow/issues/91).
Grupo de publicação: E002-D14 — Aceitação integrada da expansão.
Branch: `codex/t39-extended-acceptance`.

---

## 1. Visão Geral e Fronteira de Versão

Esta entrega consolida o aceite integrado do adendo de arquivos, navegação web e painéis (`S2-31` a `S2-37`, tickets `T31` a `T39`), validando sua interoperabilidade plena com os trinta itens originais do Aumento de Escopo 2 (`S2-01` a `S2-30`, tickets `T01` a `T30`, formalizados no aceite [T30 / #81](T30-integrated-acceptance.md)).

- **Base oficial Upstream:** Morrow `1.3.0` (`13ce1908ac7777a16161b5ef0c013de5eadcb3a1`).
- **Versão própria do Fork:** `1.2.0`.
- **Identificador de pacote integrado:** `1.3.0-fork.1.2.0`.
- **Adendo de Arquivos, Web e Painéis (`S2-31`..`S2-37`):**
  - Catálogo de arquivos de mídia/Office com filtros configuráveis e preservação estrita de caminhos (`T31`).
  - Associações flexíveis de abertura interna/sistema/aplicativo escolhido por diálogo nativo (`T32`).
  - Visualização de imagens existentes (PNG, GIF animado, SVG isolado) em abas sem importação para notas (`T33`).
  - Visualizador nativo de PDFs com controle de páginas, zoom, busca e detecção de senha (`T34`).
  - Player interno de áudio e vídeo sob demanda via streaming HTTP Range (206/416), HEAD e MIME (`T35`).
  - Navegação web isolada em `WebContentsView` sem preload/Node, com sandbox e sessão persistida própria (`T36`).
  - Workspace flexível de até quatro painéis (`single`, `two-columns`, `one-left-two-right`, `two-by-two`), com redimensionamento proporcional e teclado (`T37`).
  - Seletor de abas abertas em slot vazio (`PaneEmptyChooser`), arraste com detecção de bordas, divisão até 4 painéis e rejeição clara do 5º painel, mesma nota em múltiplas instâncias concorrentes seguras e guardas de gestos internos (`T38`).
  - Validação integrada de ponta a ponta sem dependência circular com o aceite original `T30` (`T39`).

---

## 2. Matriz de Rastreabilidade Completa do Adendo (S2-31..S2-37 → T31..T39)

| Item Origem | Ticket | Issue | PR / Commit | Relatório de Evidência | Evidência Visual / Contrato Auditado | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **S2-31** | T31 | #83 | `202a71f` / `28debc9` (build 20/23) | `docs/integration/1.3.0-fork-1.2.0.md` | `src/core/vault/fileCatalog.test.ts` e `electron/vault.test.ts` (10.005 itens em 1.566 ms) | Aprovado |
| **S2-32** | T32 | #84 | `202a71f` / `28debc9` (build 20/23) | `docs/integration/1.3.0-fork-1.2.0.md` | `electron/fileHandlers.test.ts` e `electron/fileHandlerDialogs.test.ts` (launcher sem shell) | Aprovado |
| **S2-33** | T33 | #85 | PR #95 (`a264820`) | `docs/deliveries/T33-image-file-tabs.md` | `docs/deliveries/assets/T33/image-file-tab.png` e `narrow-pt-dark.png` | Aprovado |
| **S2-33** | T34 | #86 | PR #113 (`f61bb09`) | `docs/deliveries/T34-pdf-file-tabs.md` | `docs/assets/T34/native-two-page-pdf.png` e `password-required.png` | Aprovado |
| **S2-34** | T35 | #87 | PR #96 (`99cdda6`) | `docs/deliveries/T35-media-file-tabs.md` | `docs/deliveries/assets/T35/four-mixed-surfaces.png` e `file-unavailable.png` | Aprovado |
| **S2-35** | T36 | #88 | PR #114 (`f1719ba`) | `docs/deliveries/T36-isolated-web-tabs.md` | `docs/assets/T36/two-pane-toolbar.png` e `native-content.png` | Aprovado |
| **S2-36** | T37 | #89 | `86d664f` / `28debc9` (build 20/23) | `docs/integration/1.3.0-fork-1.2.0.md` | `docs/integration/assets/1.3.0-fork-1.2.0/four-panes-wide.png` e `four-panes-narrow.png` | Aprovado |
| **S2-37** | T38 | #90 | PR #115 (`3b56589`) | `docs/deliveries/T38-pane-content-placement.md` | `src/app/paneContentPlacement.test.ts` e `src/app/components/FileCatalog.test.ts` | Aprovado |
| **S2-01..30** | T30 | #81 | PR #116 (`a197cfd`) | `docs/deliveries/T30-integrated-acceptance.md` | `src/core/scope2IntegratedAcceptance.test.ts` (26 cenários S2-01..S2-30) | Aprovado |
| **S2-31..37** | T39 | #91 | Esta entrega (`codex/t39-extended-acceptance`) | `docs/deliveries/T39-extended-acceptance.md` | `src/app/scope2ExtendedAcceptance.test.ts` (suíte integrada estendida) | Aprovado |

*Nota de desvinculação circular:* O ticket T30 valida estritamente os requisitos `S2-01` a `S2-30` do escopo original. O ticket T39 toma o aceite de T30 como pré-requisito downstream unidirecional, validando a integração dos itens `S2-31` a `S2-37` sobre essa fundação sem retroalimentação ou alteração dos critérios de T30.

---

## 3. Suíte de Validação Integrada Estendida Automatizada (`src/app/scope2ExtendedAcceptance.test.ts`)

A suíte cobre a interoperabilidade em tempo de execução dos novos recursos com a arquitetura de persistência, modelo de comandos e motor reativo do Morrow, dividida em 3 critérios estruturais:

### 3.1. Quatro Painéis Simultâneos Misturando Nota, PDF, Vídeo/Áudio e Web
- **Preset `two-by-two` (Grade 2×2 / 4 painéis):**
  - Construção do layout com 4 folhas visíveis estáveis (`MAX_VISIBLE_PANES = 4`), com identificação estável de slots (`layout:pane:1` a `layout:pane:4`).
  - Distribuição simultânea de 4 naturezas de conteúdo distintas:
    - Painel 1: Nota Markdown (`#/page/note-system-architecture`) com controles e fórmulas.
    - Painel 2: Visualizador de PDF local (`#/file/<vaultId>/Papers/api-specification.pdf`).
    - Painel 3: Player de Mídia em WebM/VP8 (`#/file/<vaultId>/Media/briefing.webm`).
    - Painel 4: Aba Web isolada (`#/url/https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs`).
- **Seletor de Abas em Slot Vazio (`describeTabForChooser`):**
  - Mapeamento fiel de metadados: título descritivo, ícone tipado, subtítulo de localização e origem precisa (ex.: `Painel 1`, `Painel 2`, ou `Disponível` para abas em segundo plano).
  - Sem pré-seleção forçada na montagem da tela (`aria-selected: false`), permitindo escolha deliberada por teclado ou ponteiro.
- **Divisão por Borda e Rejeição do 5º Painel:**
  - A partir de 2 painéis (`two-columns`), o split por borda divide o espaço para 3 e subsequentemente para 4 painéis.
  - Ao atingir 4 painéis, nova tentativa de split por borda é terminantemente rejeitada (`success: false, reason: 'too-many-panes'`), disparando feedback acessível e preservando o layout intacto.
- **Redimensionamento Proporcional, por Teclado e Restauração:**
  - `beginPaneResize` inicia sessão; `previewPaneResize` interpola a razão de divisão respeitando o clamp de segurança (`MIN_SPLIT_RATIO = 0.2` a `MAX_SPLIT_RATIO = 0.8`).
  - Tecla Escape cancela o arraste (`cancelPaneResize`), restaurando a razão inicial da sessão.
  - Tecla Home redefine a proporção (`resetPaneSplit`), restaurando o valor padrão `DEFAULT_SPLIT_RATIO = 0.5`.
- **Foco e Fechamento sem Descarte de Abas:**
  - Foco de painel define o alvo de comandos e atalhos contextuais (`focusPane`).
  - Fechar um painel (`closePane`) reduz a contagem de folhas visíveis, mas a aba antes contida naquele painel é devolvida intacta ao rol de abas disponíveis (`layout.tabs` e `availablePaneTabs`), com **zero perda de rascunhos, histórico ou documentos**.
- **Restauração de Sessão e URLs Estacionadas:**
  - Rotas web permanecem como descritores estacionados (`parseResourceTarget` -> `{ kind: 'url', url: '...' }`), sem disparar requisições de rede ou renderização nativa até a ativação deliberada pelo usuário.
  - URLs com credenciais no formato authority (`https://user:pass@host/path`) são bloqueadas e expurgadas.
  - URLs com parâmetros efêmeros de consulta (`?token=...`, `#access-token`) geram aviso contextual e não são persistidas para reabertura automática.
  - Endereços canônicos e URLs exatas de vídeo do YouTube (`https://www.youtube.com/watch?v=...`) são preservadas.
- **Mesma Nota em Múltiplos Painéis Concorrentes:**
  - Abertura da mesma nota em dois painéis simultâneos via `duplicatePaneTab`.
  - Instâncias recebem `tabId`s únicos (`instance1.id !== instance2.id`), mantendo histórico de navegação independente (`back` e `forward` isolados).
  - Ambas as instâncias conectam-se à mesma sessão de documento na `WorkspaceSession`. Modificações em controles nomeados (`page.control.setValue`) ou propriedades refletem instantaneamente no estado compartilhado em memória, eliminando qualquer risco de corrida ou sobrescrita concorrente em disco.
- **Guardas de Gestos Internos (`shouldIgnorePaneContentDragStart`):**
  - Impede que seleções em elementos ProseMirror (`.ProseMirror`), células de banco de dados (`td`, `th`, `[role="gridcell"]`, `.database`), imagens (`img`, `.image-file-view`), vídeos/áudios (`video`, `audio`, `.media-file-view`) e PDFs (`.pdf-file-view`, `embed[type="application/pdf"]`) acionem inadvertidamente o arraste da aba ou do painel.
- **Acessibilidade, Temas e Internacionalização (i18n):**
  - Modo `readonly`: colunas calculadas e geradas pelo sistema (`formula`, `createdTime`, `lastEditedTime`, `button`) são estritamente somente leitura (`isColumnReadOnly`).
  - Temas: verificação de contraste de texto para fundos claros e escuros (`contrastTextForHex`).
  - Paridade linguística: 100% de paridade entre Inglês (`en.ts`), Português (`pt.ts`) e Espanhol (`es.ts`) para todas as chaves dos módulos `paneLayout`, `fileCatalog`, `fileViewer`, `mediaViewer`, `browserTabs`, `pdfViewer` e `resourceTarget`.

---

### 3.2. Integridade de Vault Sintético (Antes/Depois), Scanner e Streaming HTTP Range
- **Preservação Absoluta de Binários e Metadados YAML (0 Escritas ao Abrir):**
  - Cofre sintético populado com binários reais e representativos: PNG, SVG vetorial, PDF formatado, WAV áudio, WebM vídeo, descritor Google Doc (`.gdoc`), descritor Google Sheet (`.gsheet`), arquivo sem extensão (`README`) e nota Markdown com YAML complexo.
  - Hashes SHA-256 calculados antes e após abertura da sessão (`WorkspaceSession.open`) e catalogação (`createFileCatalog`).
  - O runtime despachou **0 operações de escrita** para o disco (`appliedWrites = []`).
  - Todos os hashes SHA-256 permaneceram **100% idênticos**.
  - Campos YAML desconhecidos e metadados futuros (`unknownFutureField`, `extraMetadata.nestedProp`) foram mantidos intactos no modelo e na serialização.
- **Limites e Confinamento do Scanner de Catálogo:**
  - Exclusão rigorosa de diretórios técnicos (`.morrow`, `.git`), pastas ocultas (`.hidden`), lixeira (`.trash`), temporários de upload (`.morrow-tmp-upload.bin`) e tentativas de directory traversal (`../outside.pdf`).
  - Filtragem por extensões case-insensitive, inclusão controlada de arquivos sem extensão e controle de exibição de anexos (`attachments/`).
- **Contrato de Streaming HTTP Range (206/416), HEAD e MIME:**
  - Suporte completo ao particionamento de bytes (`parseMediaByteRange`): intervalos explícitos (`bytes=100-199`), sufixos (`bytes=-100`), clamp ao fim do arquivo e detecção de ranges insatisfatíveis (HTTP 416).
  - No handler do protocolo `morrow-media://`, requisições com header `Range` retornam HTTP 206 Partial Content com headers precisos (`Content-Range`, `Content-Length`, `Content-Type: video/webm`, `Accept-Ranges: bytes`), lendo sob demanda apenas a fatia requisitada sem ler o arquivo grande inteiro na memória.
  - Requisições HTTP `HEAD` retornam metadados completos de tamanho e MIME com corpo vazio (0 bytes transferidos).

---

### 3.3. Verificação de Contratos de Segurança e Isolamento
- **Bloqueio de Sender Não Confiável:**
  - O handler de protocolo rejeita requisições quando a autorização falha (retornando indisponibilidade segura 404 para prevenir enumeração de recursos).
  - Emissões de IPC verificam frames confiáveis (`isTrustedImageViewerFrame`), impedindo que renderers remotos ou frames não autorizados reivindiquem acesso a recursos do vault.
  - Iniciadores cross-origin com credenciais embutidas são bloqueados (`isTrustedImageResourceInitiator`).
- **Negação de Directory Traversal e Confinamento:**
  - Tentativas de traversal (`../../etc/passwd`) e symlinks apontando para fora do vault são rejeitados pelo leitor de descritores e pelo scanner.
- **Isolamento de Abas Web e Bloqueio de Protocolos Locais:**
  - URLs de documento bloqueiam terminantemente acesso ao sistema de arquivos local e bridges nativas:
    - `file:///...` -> Rejeitado (`invalid-url`).
    - `morrow-asset://...` e `morrow-media://...` -> Rejeitados (`invalid-url`).
    - `javascript:...` -> Rejeitado (`invalid-url`).
    - `data:...` em documentos de topo -> Rejeitado (`invalid-url`).
  - Em requisições de sub-recursos (`isAllowedBrowserRequestUrl`), frames remotos são impedidos de navegar para `file:` ou scripts privilegiados.
- **Descritores Google (.gdoc/.gsheet) vs Arquivos Locais (.xlsx):**
  - Descritores `.gdoc` e `.gsheet` são validados estritamente para formato JSON contendo URLs HTTPS apontando unicamente para `docs.google.com/document/d/...` ou `docs.google.com/spreadsheets/d/...` (teto de 64 KiB).
  - Tentativas de injeção de script (`javascript:...`), esquemas `file:` ou domínios arbitrários resultam em erro imediato (`invalid-resource`), sem qualquer execução de código.
  - Planilhas locais `.xlsx` permanecem arquivos binários normais associados a aplicativos nativos locais, sem conversão em documento web.

---

## 4. Catálogo de Evidências Sintéticas por Fluxo de Conteúdo e Painel

Todas as capturas e artefatos referenciados abaixo correspondem a arquivos reais auditados existentes no repositório, sem dados pessoais ou contas de terceiros:

### 4.1. Workspace de até Quatro Painéis Redimensionáveis (T37, T38)

![Quatro painéis redimensionáveis em janela ampla](../integration/assets/1.3.0-fork-1.2.0/four-panes-wide.png)

![Adaptação de quatro painéis em janela estreita](../integration/assets/1.3.0-fork-1.2.0/four-panes-narrow.png)

### 4.2. Abas de Imagem Locais em Alta Resolução (T33)

![Aba de imagem local aberta sem conversão em nota](assets/T33/image-file-tab.png)

![Visualização de imagem em janela estreita no tema escuro em Português](assets/T33/narrow-pt-dark.png)

### 4.3. Visualizador de PDF Local em Aba Isolada (T34)

![Visualização de PDF sintético nativo de duas páginas com zoom](../assets/T34/native-two-page-pdf.png)

![Tratamento de PDF com senha e fallback](../assets/T34/password-required.png)

![Controles de navegação de PDF em janela de 520px no tema escuro em Português](../assets/T34/pdf-controls-pt-dark-520.png)

### 4.4. Reprodução de Áudio e Vídeo sob Demanda com Streaming Range (T35)

![Superfície combinada com reprodução de mídia em quatro painéis mistos](assets/T35/four-mixed-surfaces.png)

![Tratamento de mídia indisponível ou codec não suportado](assets/T35/file-unavailable.png)

![Player de áudio em janela de 520px no tema escuro em Português](assets/T35/narrow-pt-dark.png)

### 4.5. Navegação Web em Abas Internas Isoladas (T36)

![Barra de endereço web isolada em layout dividido](../assets/T36/two-pane-toolbar.png)

![Conteúdo web isolado nativo capturado separadamente sem bridge](../assets/T36/native-content.png)

![Controles da aba web em janela de 520px no tema escuro em Português](../assets/T36/pt-dark-520.png)

---

## 5. Limites Históricos Preservados e Fronteira de Ambiente

1. **Separação entre Provas Empacotadas Windows e Suíte Integrada Linux VM:**
   - As provas de integração nativa do Electron (motor de PDF isolado em Chromium, WebContentsView com manipulação direta de bounds nativos do Windows e integração do ASAR reader 3.4.1) foram auditadas e consolidadas nos relatórios prévios dos tickets `T31` a `T38` com builds desktop documentados (`scope-2-build-03` a `build-23`).
   - A presente validação integrada do ticket `T39` operou estritamente no ambiente automatizado da VM Linux local, sem abrir janelas gráficas visíveis do Electron, validando 100% dos contratos lógicos, rotas, modelos de layout, guardas de gestos, integridade de arquivos, streaming de bytes e isolamento de segurança.
2. **Preservação de Dados Pessoais:**
   - Nenhum cofre pessoal foi tocado, nenhuma credencial foi armazenada ou transitada, e nenhum comando de rede externa foi disparado contra servidores reais de terceiros durante os testes.
3. **Escopo Estritamente Local:**
   - Nenhuma release pública, tag remota ou comando `git push` foi emitido, mantendo o trabalho 100% contido no repositório local na branch `codex/t39-extended-acceptance`.

---

## 6. Resultados do Gate Automatizado (`npm run check`)

O gate completo foi executado nesta branch com **100% de aprovação (0 erros e 0 avisos)**:

- `npm run typecheck`: Sucesso (TypeScript 0 erros em `tsconfig.json` e `tsconfig.electron.json`).
- `npm run lint`: Sucesso (ESLint 0 erros, 0 avisos).
- `npm test` (`vitest run`): Sucesso (**1.262 testes aprovados em 159 arquivos de teste**, incluindo os 9 testes de aceitação integrada estendida em `src/app/scope2ExtendedAcceptance.test.ts`).
- `npm run build`: Sucesso (Vite build cliente, Electron e MCP compilados em ~3s).

Registro estruturado da validação: [T39-validation.json](T39-validation.json).

---

## 7. Conclusão Final do Aumento de Escopo 2

Com a conclusão auditada de **T39 (#91)** e o encerramento prévio de **T30 (#81)** e de todos os tickets antecessores (`T01` a `T38`), **todos os 39 tickets e 37 itens de origem do Aumento de Escopo 2 encontram-se integralmente implementados, integrados e validados**, respeitando os padrões de integridade documental, preservação de YAML/Markdown e separação canônica de versão `1.3.0-fork.1.2.0`.
