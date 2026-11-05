# T38 — Escolher abas e arrastar arquivos para cada painel

Implementação e aceite local de [T38 / #90](https://github.com/hodeliun/Morrow/issues/90).
Grupo E002-D13 — Workspace de até quatro painéis.
Publicação e encerramento dependem do fluxo de integração e CI da main.

## Comportamento

Painéis vazios em layouts divididos apresentam uma superfície interativa e acolhedora (`PaneEmptyChooser`). Em vez de permanecerem como espaços inertes, exibem um seletor completo das abas abertas no workspace, além de instruções de arraste e atalhos para ações rápidas (criar nova nota, abrir diário de hoje ou página inicial).

### 1. Seletor de abas em slot vazio
- O seletor lista todas as abas abertas com identificação rica: título, ícone de tipo (Nota, Diário, Imagem, PDF, Mídia, Site externo, Início, etc.), subtítulo do caminho/URL e indicação precisa de localização (ex.: "Painel 1" caso já visível, ou "Disponível" se em segundo plano).
- **Sem pré-seleção automática**: a lista não seleciona nem impõe abas sem confirmação deliberada do usuário.
- Inclui campo de busca para filtrar rapidamente abas abertas em workspaces densos.
- Permite mover a aba diretamente para o painel alvo, ou criar uma nova instância se for nota.
- Oferece navegação e acionamento completos por teclado (Tab / Shift+Tab, Enter).

### 2. Mover e preservar instâncias
- Arrastar uma aba ou escolhê-la no seletor transfere a instância para o painel alvo, conservando intacto todo o seu histórico de navegação local (`back` e `forward`).
- Caso o painel de destino já possua uma aba ativa, ela não é descartada nem fechada: permanece preservada na lista global de abas (`layout.tabs`) e imediatamente acessível via barra de abas ou pelo seletor de outros painéis, garantindo zero perda de estado ou de documentos.

### 3. Arraste de notas e arquivos da barra lateral e catálogo
- Suporte a arrastar notas da árvore lateral (`Sidebar`) e arquivos do catálogo (`FileCatalog`) diretamente sobre qualquer painel ou para suas bordas.
- Detecção proporcional de bordas (`detectPaneDropZone`): o centro do painel substitui ou abre o item no painel existente; as bordas (`left`, `right`, `top`, `bottom`) solicitam a divisão do painel naquela direção.
- **Preview único e feedback imediato**: enquanto o arraste ocorre sobre o painel, uma sobreposição visual única (`.pane-drop-preview` com `.is-center`, `.is-left`, `.is-right`, `.is-top`, `.is-bottom`) ilustra exatamente a zona de drop ativa.
- **Divisão até quatro painéis e rejeição clara do quinto**: divisões em borda dividem o espaço respeitando o limite máximo de 4 painéis. Quando o layout já atinge 4 painéis visíveis, bordas que tentem criar um 5º painel são prontamente bloqueadas com realce de rejeição (`.pane-drop-preview.is-rejected`), toast de erro e anúncio sonoro/acessível via `role="status"` / `aria-live="polite"`.

### 4. Mesma nota em múltiplos painéis
- Uma mesma nota (`#/page/<id>`) pode ser aberta simultaneamente em dois ou mais painéis distintos, com identidades de aba (`tabId`) separadas (`duplicateTabToPane` / `duplicatePaneTab`).
- Ambas as instâncias conectam-se à mesma sessão de documento e salvamento em disco, prevenindo qualquer sobrescrita concorrente.
- O foco, a seleção e o estado de rolagem permanecem independentes entre os painéis.

### 5. Foco e proteção de gestos internos
- O painel em foco determina atalhos de navegação, comandos e configurações contextuais.
- A função de guarda `shouldIgnorePaneContentDragStart` impede rigorosamente que seleções e manipulações internas (arrastar texto em editores ProseMirror, células de banco de dados, visualizadores de imagem, controles de mídia de áudio/vídeo, embeds de PDF nativo) acionem inadvertidamente o arraste de aba ou de painel.

### 6. Equivalência por teclado e menu de contexto
- Na barra de abas (`TabBar`), nas páginas da lateral/cabeçalho (`pageMenu`) e nos arquivos do catálogo (`FileCatalog`), o menu de contexto (acessível também via teclado por `ContextMenu` / `Shift+F10` ou botão de opções) oferece opções explícitas de "Mover para o Painel N" / "Abrir no Painel N" e "Dividir em novo painel" (bloqueando com aviso claro quando já há 4 painéis), garantindo paridade total com o fluxo de arraste para usuários de teclado ou dispositivos assistivos.

### 7. Internacionalização (i18n)
- Todos os novos textos, anúncios de acessibilidade, títulos e rótulos de tipo estão traduzidos nos 3 idiomas suportados: Inglês (`en.ts`), Português (`pt.ts`) e Espanhol (`es.ts`).

## Verificação

`npm run check` aprovado com 100% de sucesso:
- **1.247 testes em 157 arquivos de teste**, incluindo:
  - 25 testes em `src/app/paneLayout.test.ts` (operações puras de layout, detecção de bordas, divisão em árvore, clonagem de instâncias e proteções de drag).
  - 13 testes em `src/app/paneContentPlacement.test.ts` (metadados do seletor de abas, descrições de rotas, movimentação e preservação em runtime, anúncios de status de limite e guardas de drag).
  - Testes de componentes (`FileCatalog.test.ts` com 7 testes incluindo abertura e divisão por painel e rejeição do 5º painel, `tabs.test.ts`).
- `npm run typecheck` (tsc padrão e tsc electron sem erros).
- `npm run lint` (ESLint 0 erros, 0 avisos).
- `npm run build` (build cliente, electron e MCP concluídos com sucesso).

Registro verificável: [T38 validation](T38-validation.json).
