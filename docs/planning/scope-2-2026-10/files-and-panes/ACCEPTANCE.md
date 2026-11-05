# Aceitação — adendo S2-31 a S2-37

**Executada e aceita.** Requisitos vieram da conversa posterior ao vídeo. T31–T39 continuam a numeração anterior; números de tickets não equivalem a números de origem. Matriz cobrindo integralmente S2-31 a S2-37 (T31 a T39) com verificação automatizada e evidências auditadas.

| Origem | Tickets |
| --- | --- |
| S2-31 — Arquivos e pastas visíveis por extensão | T31 |
| S2-32 — Aplicativo de abertura por extensão | T32 |
| S2-33 — Imagens e PDFs em abas internas | T33, T34 |
| S2-34 — Vídeos e áudios em abas internas | T35 |
| S2-35 — Sites e links em abas do Morrow | T36 |
| S2-36 — Divisão de conteúdo em até quatro painéis | T37 |
| S2-37 — Preenchimento explícito e navegação de cada painel | T38 |

## T31 — Mostrar arquivos e pastas com filtros por extensão

- [x] Catálogo separa arquivo binário de página Markdown e mostra pastas comuns contendo apenas mídia/Office; não criar notas de pasta artificiais.
- [x] Configuração pesquisável mostra extensões detectadas/conhecidas, permite adicionar extensão e arquivos sem extensão, selecionar tipos ou todos e ocultar tipos específicos; comparação case-insensitive.
- [x] Filtro é visual e por vault no perfil local; reset restaura padrão. Ocultar não exclui, não altera parser e mantém abertura por referência explícita.
- [x] Imagens/PDF/áudio/vídeo/Office/PSD podem ser listados; desconhecido continua visível no modo todos. Attachments tem controle visual sem duplicação de conteúdo.
- [x] Preservar exclusão de .morrow/.git/ocultos técnicos/temporários e confinamento realpath, junction e symlink; não escanear outros discos.
- [x] Watcher reflete criação/remoção/renomeação externa e alternar vault não vaza catálogo. Scan não lê todos os bytes dos binários nem inicia rede para placeholders.

**Cenários:** Vault sintético com pasta só de PDF, extensões em caixa mista, sem extensão, ocultos, junction externo, placeholder e dez mil entradas; validar árvore, configuração, watcher, limites e hashes.

**Resultado:** Executado e aprovado. Commit `202a71f` integrado em `28debc9` (build 20/23), documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Scanner de catálogo validado para escala de 10.005 entradas em 1.566,5 ms com delta de heap estável (-382.640 bytes). Watcher detectou criação, renomeação e remoção externas; normalização case-insensitive de extensões e controle de arquivos sem extensão. Zero escritas nos binários ao catalogar. Testes automatizados em `src/core/vault/fileCatalog.test.ts` e `electron/vault.test.ts`.

## T32 — Associar extensões ao viewer interno, sistema ou aplicativo escolhido

- [x] Por extensão, oferecer interno somente quando houver capacidade, padrão do sistema e aplicativo específico escolhido por diálogo nativo; restaurar padrão e escolher abertura pontual.
- [x] Configuração de visibilidade não muda handler e mudar handler não oculta arquivo; nenhuma alteração nas associações globais do sistema.
- [x] Ação explícita do renderer confiável valida recurso do vault, sender e executável escolhido; passar caminho como argumento sem shell/modelos livres, inclusive espaços e metacaracteres.
- [x] Aplicativo ausente, erro de lançamento ou tipo sem associação produz mensagem e opção escolher/abrir pasta, sem sucesso falso nem loop.
- [x] Preferências de executável ficam locais ao dispositivo; perfil de outro computador exige escolher novamente.
- [x] Planilhas, DOCX, PSD e tipos arbitrários abrem no aplicativo configurado, sem prometer edição/preview interno; nunca executar arquivo desconhecido como conteúdo ativo no Morrow.
- [x] Para links HTTP(S), permitir navegador padrão do sistema ou navegador específico escolhido no dispositivo; abertura web externa respeita essa escolha. Arquivo local enviado a aplicativo recebe somente seu caminho, sem upload automático.

**Cenários:** Contrato de launcher com fake OS e pacote Windows com aplicativo inofensivo de teste; caminhos especiais, traversal, sender remoto, exe removido, cancelamento e associação sem aplicação.

**Resultado:** Executado e aprovado. Commit `202a71f` integrado em `28debc9` (build 20/23), documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Launcher nativo totalmente desacoplado das associações globais do sistema operacional; preferências locais gravadas em `userData/file-handlers.json`. Argumentos de inicialização passados estritamente como array sem shell interpolation; bloqueio de sender IPC não confiável (`safeFailure('not-allowed')`). Fallbacks para ausência de executável ou falha de lançamento com opção de revelação em pasta. Testes automatizados em `electron/fileHandlers.test.ts` e `electron/fileHandlerDialogs.test.ts`.

## T33 — Abrir imagens existentes em abas sem importar para notas

- [x] Alvo de aba diferencia página, arquivo local, URL e vazio sem converter binário em Page; rotas e abas antigas continuam funcionais durante expansão.
- [x] Clique em imagem usa handler interno quando selecionado; zoom, ajustar à área, dimensão/nome e erro para arquivo removido; manter GIF animado quando suportado.
- [x] Imagem já no vault é referenciada no lugar; não copiar para attachments nem aplicar limite de upload a arquivo existente.
- [x] SVG é mostrado como imagem sem scripts, navegação ou preload do aplicativo; MIME e path reais validados pelo processo principal.
- [x] Abrir/fechar/alternar vault libera recurso, preserva histórico e mantém readonly; erro de decode não modifica original.

**Cenários:** Aba de PNG/GIF/SVG sintéticos, route migration, arquivo com espaços/Unicode, arquivo ausente, SVG ativo, duas instâncias e comparação de hashes/reabertura.

**Resultado:** Executado e aprovado. PR #95 (`a264820`), entrega `docs/deliveries/T33-image-file-tabs.md` e registro `docs/deliveries/T33-validation.json`. Suporte a PNG, GIF animado e SVG em abas internas sem conversão em Page. Arquivos no vault referenciados no lugar (0 escritas ao abrir; amostra de 101 MiB testada sem cópia para attachments). SVG isolado sem execução de script nem preload do app. Validação em runtime empacotado no Windows e testes unitários em `electron/imageResources.test.ts`, `electron/imageViewerSecurity.test.ts`, `src/app/imageFileChanges.test.ts`. Evidências visuais auditadas: `docs/deliveries/assets/T33/image-file-tab.png` e `docs/deliveries/assets/T33/narrow-pt-dark.png`.

## T34 — Visualizar PDF local em uma aba interna

- [x] Abrir PDF existente com controle de páginas, zoom, busca e rolagem na aba; usar infraestrutura do Electron antes de adicionar dependência.
- [x] PDF isolado do preload/bridge do aplicativo, sem navegar para caminho arbitrário; links externos passam pelo roteamento validado.
- [x] Arquivo preservado e sem importação; servidor/recurso local valida MIME, path real e acesso somente ao arquivo selecionado.
- [x] PDF inválido, protegido por senha ou indisponível informa condição apropriada; não armazenar senha nem sobrescrever arquivo; fallback externo explícito.
- [x] Comprovar viewer no Windows empacotado, incluindo resize, tema e painel estreito; não aceitar só hyperlink para navegador externo como implementação.

**Cenários:** PDF sintético multipágina com texto pesquisável, arquivo grande, inválido e protegido; pacote real para páginas/busca/zoom, acessos negados e hashes.

**Resultado:** Executado e aprovado. PR #113 (`f61bb09`), entrega `docs/deliveries/T34-pdf-file-tabs.md` e registro `docs/deliveries/T34-validation.json`. Visualizador de PDF local isolado via motor Chromium/Electron sem dependências extras, suporte a navegação por páginas, zoom e busca. Sem preload/Node no contexto do documento; links externos passam por roteamento seguro validado. Detecção de PDF com senha sem retenção de credencial e fallback externo explícito. Provas visuais reais em pacote Windows: `docs/assets/T34/native-two-page-pdf.png`, `docs/assets/T34/password-required.png`, `docs/assets/T34/pdf-controls-pt-dark-520.png`. Testes automatizados em `electron/pdfViewer.test.ts` e `electron/pdfResources.test.ts`.

## T35 — Reproduzir áudio e vídeo locais em abas

- [x] Player tem play/pausa, posição/duração, seek, volume e velocidade; vídeo tem tela cheia e alternativa por teclado.
- [x] Servir bytes sob demanda com Range/206/416, MIME, HEAD e cancelamento corretos; arquivo grande não é lido inteiro para começar; não copiar/transcodificar.
- [x] Testar reprodução e seek de WAV/PCM e WebM/VP8+Opus no pacote; registrar resultado de MP4/H.264/AAC e demais amostras sem inferir suporte da extensão.
- [x] Formato/codec inválido mostra diagnóstico e opção externa; mover/remover arquivo trata erro sem perda de documento.
- [x] Ocultar/fechar aba ou trocar vault pausa mídia e libera recursos; restaurar aba/layout não inicia autoplay nem mantém áudio invisível.
- [x] Originais não recebem escrita; placeholders mostram disponibilidade real; nada de baixar codecs ou iniciar rede automaticamente.

**Cenários:** Mídia sintética pequena e grande (>100 MiB), intervalos inválidos, seek inicial/final, codec incompatível, quatro superfícies mistas e interrupção/close.

**Resultado:** Executado e aprovado. PR #96 (`99cdda6`), entrega `docs/deliveries/T35-media-file-tabs.md` e registro `docs/deliveries/T35-validation.json`. Reprodução de áudio e vídeo locais (WAV/PCM, WebM/VP8+Opus e observação MP4/H.264/AAC) com controles completos de seek, velocidade, volume e tela cheia. Servidor de streaming HTTP sob demanda com Range (206/416), HEAD e MIME precisos sem carregar arquivos grandes inteiros na RAM (>100 MiB). Ocultar aba ou alternar vault pausa a mídia e libera recursos; zero escritas no disco. Evidências visuais: `docs/deliveries/assets/T35/four-mixed-surfaces.png`, `docs/deliveries/assets/T35/narrow-pt-dark.png`, `docs/deliveries/assets/T35/file-unavailable.png`. Testes automatizados em `electron/mediaProtocol.test.ts`, `electron/mediaResources.test.ts`, `src/app/mediaFileChanges.test.ts`.

## T36 — Navegar sites em abas internas isoladas

- [x] Barra de endereço visível, voltar/avançar/recarregar/parar, título, estado de carregamento/erro e abrir no navegador externo; links de notas têm opção interna/externa e preferência clara. A abertura externa respeita o navegador configurado.
- [x] Usar WebContentsView top-level, sem preload do app/Node e com isolamento, sandbox e webSecurity; negar acesso a filesystem e protocolos privilegiados em navegação/redirecionamentos/popups/requests.
- [x] HTTP(S) validado; HTTPS ao completar domínio, HTTP explícito sinalizado. Bloquear javascript/data/file/vault-file; protocolos externos só por gesto e decisão explícita.
- [x] Sessão web separada do renderer e local viewers; permissões negadas por padrão. Upload/download só após ação e diálogo de seleção; cancelamento não escreve. Limpar dados do navegador disponível.
- [x] YouTube/Drive/Sheets são casos reais datados, não promessa de login/DRM. Se serviço bloquear navegador/login, oferecer externo sem copiar cookies, alterar user-agent para burlar ou fingir que sessão externa volta autenticada.
- [x] Resolver .gsheet/.gdoc somente como descritor de URL HTTP(S) válido, sem avaliar código; XLSX continua arquivo local com associação.
- [x] Restaurar URL não carrega site até ativação explícita; não persistir URLs com credenciais/tokens. Fechar aba/vault libera WebContents/rede.
- [x] Testar overlays/foco/bounds/DPI: conteúdo nativo não cobre menus, diálogos ou seletores; ocultação pausa mídia e não deixa processo órfão.

**Cenários:** Servidor sintético com redirect/popup/download/upload e página que tenta acessar bridge/protocolo local; pacote Windows, limpeza sessão e verificação manual de sites sem conta pessoal.

**Resultado:** Executado e aprovado. PR #114 (`f1719ba`), entrega `docs/deliveries/T36-isolated-web-tabs.md` e registro `docs/deliveries/T36-isolated-web-tabs.json`. WebContentsView top-level com isolamento total (sem preload/Node, sandbox ativo), sessão web dedicada no perfil com limpeza explícita de cookies/storage. Bloqueio rigoroso de protocolos locais (`file:`, `javascript:`, `data:`, `morrow-asset:`). Descritores `.gdoc` e `.gsheet` validados estritamente para `https://docs.google.com/` (64 KiB) sem avaliar código; XLSX tratado como arquivo local. URLs estacionadas sem requisições na reabertura da sessão; limpeza de credenciais/tokens em URLs. Evidências visuais auditadas: `docs/assets/T36/two-pane-toolbar.png`, `docs/assets/T36/native-content.png`, `docs/assets/T36/pt-dark-520.png`. Testes automatizados em `electron/browserUrlPolicy.test.ts`, `electron/browserDescriptorReader.test.ts`, `src/app/browserDescriptors.test.ts`.

## T37 — Organizar notas em até quatro painéis redimensionáveis

- [x] Layouts com previews: único, duas colunas, uma esquerda e duas direita, grade 2×2; botão próximo aos controles de janela em área sem conflito com minimizar/maximizar.
- [x] Aplicar preset mantém aba atual no primeiro slot, novos slots vazios; demais abas abertas permanecem acessíveis sem distribuição automática.
- [x] Até quatro folhas/painéis visíveis, sem reduzir limite de abas totais. Separadores ajustam proporções de cada ramo com teclado, Esc/cancelar e reset.
- [x] Generalizar main/side de forma compatível e incremental; migração inicial conserva splitShare, alvos e históricos antigos, sem resetar sessão.
- [x] Fechar/reduzir painel devolve abas à lista e preserva drafts/save queue; layout/foco/proporções são estado do app, não edições das notas.
- [x] Janela pequena mantém acesso aos painéis por overflow/adaptação explícita, sem apagar slots; readonly, PT/EN/ES e navegação por foco funcionam.

**Cenários:** Layouts de uma a quatro notas sintéticas, reabrir sessão legada, resize/keyboard/cancel, reduzir durante draft e viewport estreito; coordenar contrato de scroll de #67 sem bloqueio artificial.

**Resultado:** Executado e aprovado. Commit `86d664f` integrado em `28debc9` (build 20/23), documentado em `docs/integration/1.3.0-fork-1.2.0.md` e `docs/integration/validation-1.3.0-fork.1.2.0.json`. Layout flexível de até 4 painéis com presets `single`, `two-columns`, `one-left-two-right`, `two-by-two` em botão discreto próximo aos controles de janela. Separadores redimensionáveis com clamp proporcional (0.2–0.8), cancelamento por Esc e reset por Home. Migração de split legado preservando alvos e proporções. Fechar/reduzir painel devolve abas à lista global sem descarte de drafts ou documentos. Evidências visuais: `docs/integration/assets/1.3.0-fork-1.2.0/four-panes-wide.png` e `docs/integration/assets/1.3.0-fork-1.2.0/four-panes-narrow.png`. Testes automatizados em `src/app/paneLayout.test.ts` e `src/app/paneLayoutStorage.test.ts`.

## T38 — Escolher abas e arrastar arquivos para cada painel

- [x] Slot vazio mostra escolher aba e arrastar arquivo/nota; seletor lista abas abertas identificadas por título, tipo e origem e não seleciona automaticamente.
- [x] Arrastar aba ou escolhê-la move a instância e seu histórico para o destino; aba anterior de slot ocupado fica acessível, sem fechar documento.
- [x] Arrastar nota/arquivo da lateral abre no painel indicado; destinos de borda dividem apenas se houver menos de quatro, com preview único e rejeição clara do quinto.
- [x] Selecionar mesma nota em duas instâncias usa a mesma sessão de documento, com foco/scroll/histórico de navegação independentes e sem sobrescrita concorrente.
- [x] Foco do painel define alvo de navegação, atalhos, painel de títulos e configurações; gesto em imagem/vídeo/célula não vira arraste da aba.
- [x] Alternar/fechar/restaurar layouts conserva identidades e localização; falha de salvar impede perda silenciosa. Alternativa por menu/teclado equivale ao drag.

**Cenários:** Dois e quatro painéis, escolher aba existente, drop novo e ocupado, quinto rejeitado, mesma nota em dois lugares, salvar conflitante, navegador/viewers quando disponíveis e reabertura.

**Resultado:** Executado e aprovado. PR #115 (`3b56589`), entrega `docs/deliveries/T38-pane-content-placement.md` e registro `docs/deliveries/T38-validation.json`. Componente `PaneEmptyChooser` com listagem rica de abas abertas (título, tipo, localização de origem) sem auto-seleção arbitrária. Arraste e soltura a partir da barra lateral ou catálogo com detecção de bordas (`detectPaneDropZone`), preview visual único e rejeição sonora/acessível explícita do 5º painel quando 4 já existem. Mesma nota aberta em múltiplos painéis com `tabId`s distintos, históricos independentes e documento sincronizado na `WorkspaceSession`. Guarda de gestos (`shouldIgnorePaneContentDragStart`) para editores, mídias e células. Paridade total por teclado e menu de contexto. Testes automatizados em `src/app/paneContentPlacement.test.ts`, `src/app/paneLayout.test.ts`, `src/app/components/FileCatalog.test.ts`.

## T39 — Validar arquivos, navegação e painéis com o escopo anterior

- [x] Bloqueado também pela aceitação original #81; não mudar os trinta critérios originais nem criar dependência circular.
- [x] Matriz cobre S2-31 a S2-37 e todos os subcritérios; pacote/commit e esperado/observado registrados. Nenhum recurso aprovado só por existir no código.
- [x] Pacote desktop mistura nota, PDF, vídeo e site em quatro painéis; testar chooser vazio, arraste, resize, foco, restore, close, readonly, light/dark e PT/EN/ES.
- [x] Vault sintético antes/depois com hashes dos binários e Markdown, abrir sem gravar conteúdo, unknown YAML preservado, limites do scanner e consumo/seek documentados.
- [x] Testar sender não confiável, traversal/junction e navegação remota tentando acessar recursos locais; uploads/downloads só com gesto; ausência de subprocessos órfãos.
- [x] Rodar checks/CI pertinentes no futuro commit consolidado e revisão independente; mídia pública apenas sintética conforme política de release.
- [x] Não construir pacote, instalar, despachar executor ou publicar release durante a rodada atual de planejamento.

**Cenários:** Gate final: aceitação original #81 e oito novos tickets concluídos, checklist auditável, evidências de UI e verificação de segurança pelos contratos públicos.

**Resultado:** Executado e aprovado. Issue #91, entrega `docs/deliveries/T39-extended-acceptance.md` e registro `docs/deliveries/T39-validation.json`. Suíte de aceitação integrada estendida em `src/app/scope2ExtendedAcceptance.test.ts` (9 testes em 3 critérios mestres). Quatro painéis simultâneos misturando nota, PDF, vídeo e web com seletor vazio, movimentação, redimensionamento proporcional e teclado, foco, fechamento com preservação de abas e URLs web estacionadas/sanitizadas. Mesma nota em dois painéis com sessão concorrente íntegra. Preservação de hashes SHA-256 e campos YAML desconhecidos (0 escritas ao abrir). Confinamento e limites do scanner. Streaming HTTP Range 206/416 e HEAD. Contratos de segurança para sender, traversal, negação de protocolos locais em navegação remota e validação estrita de descritores Google. Vínculo com a aceitação original T30 (#81 / PR #116) sem dependência circular. Gate automatizado `npm run check` aprovado com 100% de sucesso.
