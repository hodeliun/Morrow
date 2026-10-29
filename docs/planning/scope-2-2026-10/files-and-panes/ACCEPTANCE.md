# Aceitação — adendo S2-31 a S2-37

**Não executada.** Requisitos vieram da conversa posterior ao vídeo. T31–T39 continuam a numeração anterior; números de tickets não equivalem a números de origem.

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

- [ ] Catálogo separa arquivo binário de página Markdown e mostra pastas comuns contendo apenas mídia/Office; não criar notas de pasta artificiais.
- [ ] Configuração pesquisável mostra extensões detectadas/conhecidas, permite adicionar extensão e arquivos sem extensão, selecionar tipos ou todos e ocultar tipos específicos; comparação case-insensitive.
- [ ] Filtro é visual e por vault no perfil local; reset restaura padrão. Ocultar não exclui, não altera parser e mantém abertura por referência explícita.
- [ ] Imagens/PDF/áudio/vídeo/Office/PSD podem ser listados; desconhecido continua visível no modo todos. Attachments tem controle visual sem duplicação de conteúdo.
- [ ] Preservar exclusão de .morrow/.git/ocultos técnicos/temporários e confinamento realpath, junction e symlink; não escanear outros discos.
- [ ] Watcher reflete criação/remoção/renomeação externa e alternar vault não vaza catálogo. Scan não lê todos os bytes dos binários nem inicia rede para placeholders.

**Cenários:** Vault sintético com pasta só de PDF, extensões em caixa mista, sem extensão, ocultos, junction externo, placeholder e dez mil entradas; validar árvore, configuração, watcher, limites e hashes.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.

## T32 — Associar extensões ao viewer interno, sistema ou aplicativo escolhido

- [ ] Por extensão, oferecer interno somente quando houver capacidade, padrão do sistema e aplicativo específico escolhido por diálogo nativo; restaurar padrão e escolher abertura pontual.
- [ ] Configuração de visibilidade não muda handler e mudar handler não oculta arquivo; nenhuma alteração nas associações globais do sistema.
- [ ] Ação explícita do renderer confiável valida recurso do vault, sender e executável escolhido; passar caminho como argumento sem shell/modelos livres, inclusive espaços e metacaracteres.
- [ ] Aplicativo ausente, erro de lançamento ou tipo sem associação produz mensagem e opção escolher/abrir pasta, sem sucesso falso nem loop.
- [ ] Preferências de executável ficam locais ao dispositivo; perfil de outro computador exige escolher novamente.
- [ ] Planilhas, DOCX, PSD e tipos arbitrários abrem no aplicativo configurado, sem prometer edição/preview interno; nunca executar arquivo desconhecido como conteúdo ativo no Morrow.
- [ ] Para links HTTP(S), permitir navegador padrão do sistema ou navegador específico escolhido no dispositivo; abertura web externa respeita essa escolha. Arquivo local enviado a aplicativo recebe somente seu caminho, sem upload automático.

**Cenários:** Contrato de launcher com fake OS e pacote Windows com aplicativo inofensivo de teste; caminhos especiais, traversal, sender remoto, exe removido, cancelamento e associação sem aplicação.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.

## T33 — Abrir imagens existentes em abas sem importar para notas

- [ ] Alvo de aba diferencia página, arquivo local, URL e vazio sem converter binário em Page; rotas e abas antigas continuam funcionais durante expansão.
- [ ] Clique em imagem usa handler interno quando selecionado; zoom, ajustar à área, dimensão/nome e erro para arquivo removido; manter GIF animado quando suportado.
- [ ] Imagem já no vault é referenciada no lugar; não copiar para attachments nem aplicar limite de upload a arquivo existente.
- [ ] SVG é mostrado como imagem sem scripts, navegação ou preload do aplicativo; MIME e path reais validados pelo processo principal.
- [ ] Abrir/fechar/alternar vault libera recurso, preserva histórico e mantém readonly; erro de decode não modifica original.

**Cenários:** Aba de PNG/GIF/SVG sintéticos, route migration, arquivo com espaços/Unicode, arquivo ausente, SVG ativo, duas instâncias e comparação de hashes/reabertura.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.

## T34 — Visualizar PDF local em uma aba interna

- [ ] Abrir PDF existente com controle de páginas, zoom, busca e rolagem na aba; usar infraestrutura do Electron antes de adicionar dependência.
- [ ] PDF isolado do preload/bridge do aplicativo, sem navegar para caminho arbitrário; links externos passam pelo roteamento validado.
- [ ] Arquivo preservado e sem importação; servidor/recurso local valida MIME, path real e acesso somente ao arquivo selecionado.
- [ ] PDF inválido, protegido por senha ou indisponível informa condição apropriada; não armazenar senha nem sobrescrever arquivo; fallback externo explícito.
- [ ] Comprovar viewer no Windows empacotado, incluindo resize, tema e painel estreito; não aceitar só hyperlink para navegador externo como implementação.

**Cenários:** PDF sintético multipágina com texto pesquisável, arquivo grande, inválido e protegido; pacote real para páginas/busca/zoom, acessos negados e hashes.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.

## T35 — Reproduzir áudio e vídeo locais em abas

- [ ] Player tem play/pausa, posição/duração, seek, volume e velocidade; vídeo tem tela cheia e alternativa por teclado.
- [ ] Servir bytes sob demanda com Range/206/416, MIME, HEAD e cancelamento corretos; arquivo grande não é lido inteiro para começar; não copiar/transcodificar.
- [ ] Testar reprodução e seek de WAV/PCM e WebM/VP8+Opus no pacote; registrar resultado de MP4/H.264/AAC e demais amostras sem inferir suporte da extensão.
- [ ] Formato/codec inválido mostra diagnóstico e opção externa; mover/remover arquivo trata erro sem perda de documento.
- [ ] Ocultar/fechar aba ou trocar vault pausa mídia e libera recursos; restaurar aba/layout não inicia autoplay nem mantém áudio invisível.
- [ ] Originais não recebem escrita; placeholders mostram disponibilidade real; nada de baixar codecs ou iniciar rede automaticamente.

**Cenários:** Mídia sintética pequena e grande (>100 MiB), intervalos inválidos, seek inicial/final, codec incompatível, quatro superfícies mistas e interrupção/close.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.

## T36 — Navegar sites em abas internas isoladas

- [ ] Barra de endereço visível, voltar/avançar/recarregar/parar, título, estado de carregamento/erro e abrir no navegador externo; links de notas têm opção interna/externa e preferência clara. A abertura externa respeita o navegador configurado.
- [ ] Usar WebContentsView top-level, sem preload do app/Node e com isolamento, sandbox e webSecurity; negar acesso a filesystem e protocolos privilegiados em navegação/redirecionamentos/popups/requests.
- [ ] HTTP(S) validado; HTTPS ao completar domínio, HTTP explícito sinalizado. Bloquear javascript/data/file/vault-file; protocolos externos só por gesto e decisão explícita.
- [ ] Sessão web separada do renderer e local viewers; permissões negadas por padrão. Upload/download só após ação e diálogo de seleção; cancelamento não escreve. Limpar dados do navegador disponível.
- [ ] YouTube/Drive/Sheets são casos reais datados, não promessa de login/DRM. Se serviço bloquear navegador/login, oferecer externo sem copiar cookies, alterar user-agent para burlar ou fingir que sessão externa volta autenticada.
- [ ] Resolver .gsheet/.gdoc somente como descritor de URL HTTP(S) válido, sem avaliar código; XLSX continua arquivo local com associação.
- [ ] Restaurar URL não carrega site até ativação explícita; não persistir URLs com credenciais/tokens. Fechar aba/vault libera WebContents/rede.
- [ ] Testar overlays/foco/bounds/DPI: conteúdo nativo não cobre menus, diálogos ou seletores; ocultação pausa mídia e não deixa processo órfão.

**Cenários:** Servidor sintético com redirect/popup/download/upload e página que tenta acessar bridge/protocolo local; pacote Windows, limpeza sessão e verificação manual de sites sem conta pessoal.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.

## T37 — Organizar notas em até quatro painéis redimensionáveis

- [ ] Layouts com previews: único, duas colunas, uma esquerda e duas direita, grade 2×2; botão próximo aos controles de janela em área sem conflito com minimizar/maximizar.
- [ ] Aplicar preset mantém aba atual no primeiro slot, novos slots vazios; demais abas abertas permanecem acessíveis sem distribuição automática.
- [ ] Até quatro folhas/painéis visíveis, sem reduzir limite de abas totais. Separadores ajustam proporções de cada ramo com teclado, Esc/cancelar e reset.
- [ ] Generalizar main/side de forma compatível e incremental; migração inicial conserva splitShare, alvos e históricos antigos, sem resetar sessão.
- [ ] Fechar/reduzir painel devolve abas à lista e preserva drafts/save queue; layout/foco/proporções são estado do app, não edições das notas.
- [ ] Janela pequena mantém acesso aos painéis por overflow/adaptação explícita, sem apagar slots; readonly, PT/EN/ES e navegação por foco funcionam.

**Cenários:** Layouts de uma a quatro notas sintéticas, reabrir sessão legada, resize/keyboard/cancel, reduzir durante draft e viewport estreito; coordenar contrato de scroll de #67 sem bloqueio artificial.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.

## T38 — Escolher abas e arrastar arquivos para cada painel

- [ ] Slot vazio mostra escolher aba e arrastar arquivo/nota; seletor lista abas abertas identificadas por título, tipo e origem e não seleciona automaticamente.
- [ ] Arrastar aba ou escolhê-la move a instância e seu histórico para o destino; aba anterior de slot ocupado fica acessível, sem fechar documento.
- [ ] Arrastar nota/arquivo da lateral abre no painel indicado; destinos de borda dividem apenas se houver menos de quatro, com preview único e rejeição clara do quinto.
- [ ] Selecionar mesma nota em duas instâncias usa a mesma sessão de documento, com foco/scroll/histórico de navegação independentes e sem sobrescrita concorrente.
- [ ] Foco do painel define alvo de navegação, atalhos, painel de títulos e configurações; gesto em imagem/vídeo/célula não vira arraste da aba.
- [ ] Alternar/fechar/restaurar layouts conserva identidades e localização; falha de salvar impede perda silenciosa. Alternativa por menu/teclado equivale ao drag.

**Cenários:** Dois e quatro painéis, escolher aba existente, drop novo e ocupado, quinto rejeitado, mesma nota em dois lugares, salvar conflitante, navegador/viewers quando disponíveis e reabertura.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.

## T39 — Validar arquivos, navegação e painéis com o escopo anterior

- [ ] Bloqueado também pela aceitação original #81; não mudar os trinta critérios originais nem criar dependência circular.
- [ ] Matriz cobre S2-31 a S2-37 e todos os subcritérios; pacote/commit e esperado/observado registrados. Nenhum recurso aprovado só por existir no código.
- [ ] Pacote desktop mistura nota, PDF, vídeo e site em quatro painéis; testar chooser vazio, arraste, resize, foco, restore, close, readonly, light/dark e PT/EN/ES.
- [ ] Vault sintético antes/depois com hashes dos binários e Markdown, abrir sem gravar conteúdo, unknown YAML preservado, limites do scanner e consumo/seek documentados.
- [ ] Testar sender não confiável, traversal/junction e navegação remota tentando acessar recursos locais; uploads/downloads só com gesto; ausência de subprocessos órfãos.
- [ ] Rodar checks/CI pertinentes no futuro commit consolidado e revisão independente; mídia pública apenas sintética conforme política de release.
- [ ] Não construir pacote, instalar, despachar executor ou publicar release durante a rodada atual de planejamento.

**Cenários:** Gate final: aceitação original #81 e oito novos tickets concluídos, checklist auditável, evidências de UI e verificação de segurança pelos contratos públicos.

**Resultado:** não executado. Evidência futura deve informar pacote/commit, passos, esperado/observado, hashes/medidas quando pertinentes e mídia sintética.
