# Grilling interno — arquivos, web e painéis

Ampliação de planejamento. Decisões abaixo são análises internas, não respostas inventadas do usuário.

## 1. É preciso refazer o scanner?

Não. VaultScan.others já descobre binários, mas o carregamento só promove pastas com páginas ou vazias. Expor um catálogo de arquivos separado do modelo Page, com atualização via watcher, preservando limites/nomes reservados. Não criar .md para pastas de mídia.

## 2. Visível significa editável ou compatível?

São três propriedades independentes: visibilidade, capacidade de visualização e destino de abertura. PSD e XLSX podem aparecer sem viewer. Desligar extensão não apaga arquivos nem impede links explícitos; filtros não modificam o parser Markdown.

## 3. Quais filtros e onde persistem?

Preferência por vault no perfil local do dispositivo, com modo tipos selecionados ou todos os arquivos comuns; exclusão explícita vence inclusão. Normalizar extensão case-insensitive, tratar sem extensão, permitir adicionar/resetar. Arquivos .md/.canvas continuam parser próprio, mesmo se ocultados na árvore. Attachments é pasta comum com toggle visual próprio; .morrow/.git/temporários/ocultos técnicos e symlinks continuam fora.

## 4. Aplicativo padrão significa padrão do Windows?

A escolha será do Morrow, sem mudar registro/associações do sistema. Padrão do sistema delega abertura ao OS; aplicativo específico é escolhido em diálogo nativo e recebe um único caminho/URL como argumento, sem shell ou modelo de comando livre. Caminho do executável é local ao dispositivo, nunca enviado ao vault/repo.

## 5. Visualizador novo exige dependência?

Plano usa primeiro Electron/Chromium já instalado, controles HTML de áudio/vídeo e viewer de PDF existente no ambiente. Não importar player enorme nem adicionar runtime dependency nesta etapa. PDF deve comprovar páginas/zoom/busca em pacote real; se infraestrutura não suportar, registrar impedimento antes de mudar dependências.

## 6. Abrir arquivo pode copiá-lo para attachments?

Não. Viewer referencia o original dentro do vault por recurso relativo validado. Não importar nem converter. Limite de upload de anexo não limita reprodução de arquivo existente; mídia grande usa streaming/range sem carregar tudo na RAM. Mudança de vault invalida recursos.

## 7. E pastas de mídia, placeholders e links simbólicos?

Pastas comuns só com mídia aparecem; pastas técnicas permanecem ocultas. Respeitar confinamento realpath/junction e não seguir links para fora. Placeholder do Drive sem bytes locais gera estado de indisponibilidade/obter no sistema; não iniciar download nem rede na varredura.

## 8. PDF é só carregar file:// no editor?

Não compartilhar o renderer privilegiado com conteúdo não confiável. Recurso local serve só arquivo autorizado com MIME/Range corretos; PDF pode usar contexto isolado sem preload do app, sem navegação ao vault arbitrário. SVG apenas como imagem, nunca documento ativo.

## 9. Todo MP4/MKV deve tocar?

Extensão não garante codec. Aceitar catálogo visível amplo, detectar capacidade/erro real e mostrar fallback. Baseline de pacote: amostra WebM/VP8+Opus e WAV/PCM; MP4/H.264/AAC e demais formatos têm resultados registrados, não suporte declarado por suposição. Sem transcodificação/DRM/plugins de codecs.

## 10. Um iframe basta para sites?

Não. Navegação remota é top-level em WebContentsView isolado e sem preload do app, com sessão dedicada. URLs HTTP(S) apenas; bloquear esquemas de execução e acesso local. HTTPS padrão; HTTP explicitamente solicitado é sinalizado. Não desabilitar webSecurity ou falsificar navegador para contornar bloqueios.

## 11. Como lidar com Google e YouTube?

Tentar acesso normal e documentar compatibilidade; login OAuth do Google não é prometido em agente embutido. Se bloqueado, oferecer browser externo, sem copiar cookies/credenciais ou burlar autenticação. Abrir no externo não autentica automaticamente a aba interna. .gsheet/.gdoc só são resolvidos quando contêm URL HTTP(S) válida, nunca executados como código.

## 12. Quais permissões, downloads e sessões?

Por padrão negar câmera, microfone, geolocalização, notificações e acesso local. Downloads/uploads somente por ação explícita e diálogo nativo; cancelar não escreve. Web session própria persistida no perfil, opção limpar dados; nunca exportar cookies. Restaurar URL de sessão não carrega rede até ativação explícita da aba; não restaurar URLs com credenciais/tokens.

## 13. Já existe split?

Sim, main/side e splitShare persistidos. Generalizar com compatibilidade para árvore de até quatro folhas e grupos de abas, cada aba com alvo tipado e estado independente. Não confundir colunas do documento com painéis do app; tampouco exigir quatro janelas/monitores.

## 14. Como aplicar preset sem adivinhar conteúdo?

Preservar aba atual no slot inicial e criar slots vazios com seletor. Demais abas continuam acessíveis em biblioteca/grupos, sem fechar drafts. Troca de preset não distribui automaticamente abas existentes. Migração inicial do split legado conserva seus dois alvos, diferente da seleção manual de um novo preset.

## 15. Arrastar aba duplica ou move?

Move a instância de aba e seu histórico. Escolher aba já aberta move a mesma instância para o slot escolhido. Arrastar arquivo da lateral abre uma instância no slot; múltiplas instâncias da mesma nota compartilham WorkspaceSession, mas mantêm foco/scroll. Slot ocupado só troca conteúdo com destino claro e preserva aba anterior na lista.

## 16. Como não perder edição ao fechar painel?

Fechar painel devolve abas ao conjunto acessível; reduzir layout não descarta documentos nem cancela save queue. Falha de salvar permanece visível. Duplicar instância de nota nunca cria segundo documento ou sessão de persistência concorrente.

## 17. Navegador nativo fica por cima de menus?

Gerenciar bounds/DPI/z-order e foco. Esconder/desanexar superfícies nativas quando diálogo do app cobre a área, restaurando corretamente. Fechar aba/vault destrói WebContents e recursos; não deixar áudio/rede ocultos. Mídia é pausada ao ocultar ou fechar; não inicia autoplay ao restaurar.

## 18. Como evitar refatoração horizontal gigante?

Imagem abre o caminho vertical de alvo de arquivo tipado e viewer simples; PDF e mídia o estendem. Layout de quatro painéis começa com notas existentes; preenchimento conecta arquivos depois. Preservar rotas antigas durante expansão, migrar uso gradualmente, remover legado apenas quando nenhum caller depender dele e testes verdes.

## 19. Como validar sem depender de conta pessoal?

Usar vault sintético e servidor controlado; testar negativas IPC/traversal/protocolos e comparação de hashes antes/depois. Sites reais têm verificação manual datada separada, sem login pessoal obrigatório. A aceitação antiga #81 conserva seus trinta itens; nova aceitação depende dela e das novas entregas, evitando dependência circular.

## 20. Isto autoriza desenvolvimento?

Esta rodada revisa escopo, spec e tickets como continuação do planejamento. Não despachar executores, buildar/instalar nem implementar. Publicar somente documentação agrupada; o pedido de recurso faz parte do escopo planejado.
