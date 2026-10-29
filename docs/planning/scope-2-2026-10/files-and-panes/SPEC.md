# Aumento de Escopo 2 — adendo: arquivos, web e painéis

**Estado:** somente planejamento; implementação não iniciada.
**Escopo consolidado:** 37 itens de origem e 39 tickets (30 anteriores + 9 adicionais).
**Baseline de código:** 11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f; produto permanece 1.2.1-fork.1.1.1.
**Continuidade:** [spec original #51](https://github.com/hodeliun/Morrow/issues/51); [especificação anterior](../SPEC.md). Este adendo amplia, não substitui nem duplica os itens 1–30. Os itens 31–37 vieram de conversa posterior, não do vídeo.

## Problem Statement

O explorador orientado a notas não apresenta adequadamente arquivos comuns e pastas só de mídia. A pessoa precisa abrir PDF, imagem, áudio e vídeo existentes sem anexá-los a uma nota; para outros formatos, escolher o aplicativo. Também precisa acessar sites e comparar até quatro conteúdos na mesma janela com controle explícito de cada espaço.

## Solution

Adicionar catálogo e filtros de arquivos, associações de abertura por extensão, viewers de arquivos em abas, navegação web isolada e extensão do split atual a quatro painéis. Visibilidade, capacidade de preview e aplicativo de abertura serão configurações distintas. Novos slots ficam vazios até escolha explícita. Nenhuma abertura implica copiar, converter ou regravar o original.

## User Stories

1. Como pessoa que usa o Morrow, quero ver uma pasta só de PDFs e vídeos na lateral, para organizar materiais sem criar notas artificiais.
2. Como pessoa que usa o Morrow, quero pesquisar extensões e adicionar tipos personalizados, para escolher o que aparece.
3. Como pessoa que usa o Morrow, quero ocultar tipos sem apagar arquivos, para reduzir ruído de navegação.
4. Como pessoa que usa o Morrow, quero ver PSD ou planilha mesmo sem viewer, para localizar e abrir no aplicativo apropriado.
5. Como pessoa que usa o Morrow, quero definir viewer interno, padrão do sistema ou aplicativo específico por extensão, para escolher onde trabalhar.
6. Como pessoa que usa o Morrow, quero escolher navegador externo por dispositivo, para abrir links no navegador preferido.
7. Como pessoa que usa o Morrow, quero abrir imagem em aba com zoom e ajuste, para examiná-la sem inseri-la em nota.
8. Como pessoa que usa o Morrow, quero abrir PDF em aba com páginas, zoom e busca, para ler sem sair do Morrow.
9. Como pessoa que usa o Morrow, quero reproduzir áudio e vídeo locais com seek, volume e velocidade, para consultar fontes.
10. Como pessoa que usa o Morrow, quero saber quando o codec não é suportado e usar aplicativo externo, para não confundir falha com arquivo ausente.
11. Como pessoa que usa o Morrow, quero abrir arquivo grande sem carregá-lo inteiro na memória, para manter a interface utilizável.
12. Como pessoa que usa o Morrow, quero abrir URL em aba e voltar/avançar/recarregar, para alternar notas e sites.
13. Como pessoa que usa o Morrow, quero tentar usar YouTube, Drive e Sheets e entender limitações de login/reprodução, para escolher fallback quando necessário.
14. Como pessoa que usa o Morrow, quero controlar permissões e limpar dados do navegador, para separar sites dos arquivos locais.
15. Como pessoa que usa o Morrow, quero abrir descritor Google válido como URL e não como planilha local, para usar o destino correto.
16. Como pessoa que usa o Morrow, quero escolher layout único, duas colunas, esquerda com duas à direita ou grade 2×2, para comparar conteúdos.
17. Como pessoa que usa o Morrow, quero arrastar separadores horizontais e verticais, para ajustar cada área.
18. Como pessoa que usa o Morrow, quero manter novos slots vazios sem preenchimento automático, para escolher o conteúdo.
19. Como pessoa que usa o Morrow, quero selecionar uma aba existente para um slot vazio, para organizar o que já está aberto.
20. Como pessoa que usa o Morrow, quero arrastar arquivo ou nota da lateral até o painel desejado, para abrir no destino certo.
21. Como pessoa que usa o Morrow, quero mover uma aba mantendo seu histórico, para reorganizar sem perder contexto.
22. Como pessoa que usa o Morrow, quero usar duas instâncias da mesma nota com sessão compartilhada e rolagens independentes, para consultar e editar sem sobrescrever.
23. Como pessoa que usa o Morrow, quero reduzir layout sem fechar documentos ou perder drafts, para mudar o espaço de trabalho com segurança.
24. Como pessoa que usa o Morrow, quero restaurar layouts e migrar o split anterior, para continuar o trabalho existente.
25. Como pessoa que usa o Morrow, quero operar tudo por teclado em temas e idiomas suportados, para não depender de gestos ou cores.
26. Como pessoa que usa o Morrow, quero comprovar proteção do vault, hashes e ausência de escritas ao visualizar, para preservar originais.

## Implementation Decisions

- Não. VaultScan.others já descobre binários, mas o carregamento só promove pastas com páginas ou vazias. Expor um catálogo de arquivos separado do modelo Page, com atualização via watcher, preservando limites/nomes reservados. Não criar .md para pastas de mídia.
- São três propriedades independentes: visibilidade, capacidade de visualização e destino de abertura. PSD e XLSX podem aparecer sem viewer. Desligar extensão não apaga arquivos nem impede links explícitos; filtros não modificam o parser Markdown.
- Preferência por vault no perfil local do dispositivo, com modo tipos selecionados ou todos os arquivos comuns; exclusão explícita vence inclusão. Normalizar extensão case-insensitive, tratar sem extensão, permitir adicionar/resetar. Arquivos .md/.canvas continuam parser próprio, mesmo se ocultados na árvore. Attachments é pasta comum com toggle visual próprio; .morrow/.git/temporários/ocultos técnicos e symlinks continuam fora.
- A escolha será do Morrow, sem mudar registro/associações do sistema. Padrão do sistema delega abertura ao OS; aplicativo específico é escolhido em diálogo nativo e recebe um único caminho/URL como argumento, sem shell ou modelo de comando livre. Caminho do executável é local ao dispositivo, nunca enviado ao vault/repo.
- Plano usa primeiro Electron/Chromium já instalado, controles HTML de áudio/vídeo e viewer de PDF existente no ambiente. Não importar player enorme nem adicionar runtime dependency nesta etapa. PDF deve comprovar páginas/zoom/busca em pacote real; se infraestrutura não suportar, registrar impedimento antes de mudar dependências.
- Não. Viewer referencia o original dentro do vault por recurso relativo validado. Não importar nem converter. Limite de upload de anexo não limita reprodução de arquivo existente; mídia grande usa streaming/range sem carregar tudo na RAM. Mudança de vault invalida recursos.
- Pastas comuns só com mídia aparecem; pastas técnicas permanecem ocultas. Respeitar confinamento realpath/junction e não seguir links para fora. Placeholder do Drive sem bytes locais gera estado de indisponibilidade/obter no sistema; não iniciar download nem rede na varredura.
- Não compartilhar o renderer privilegiado com conteúdo não confiável. Recurso local serve só arquivo autorizado com MIME/Range corretos; PDF pode usar contexto isolado sem preload do app, sem navegação ao vault arbitrário. SVG apenas como imagem, nunca documento ativo.
- Extensão não garante codec. Aceitar catálogo visível amplo, detectar capacidade/erro real e mostrar fallback. Baseline de pacote: amostra WebM/VP8+Opus e WAV/PCM; MP4/H.264/AAC e demais formatos têm resultados registrados, não suporte declarado por suposição. Sem transcodificação/DRM/plugins de codecs.
- Não. Navegação remota é top-level em WebContentsView isolado e sem preload do app, com sessão dedicada. URLs HTTP(S) apenas; bloquear esquemas de execução e acesso local. HTTPS padrão; HTTP explicitamente solicitado é sinalizado. Não desabilitar webSecurity ou falsificar navegador para contornar bloqueios.
- Tentar acesso normal e documentar compatibilidade; login OAuth do Google não é prometido em agente embutido. Se bloqueado, oferecer browser externo, sem copiar cookies/credenciais ou burlar autenticação. Abrir no externo não autentica automaticamente a aba interna. .gsheet/.gdoc só são resolvidos quando contêm URL HTTP(S) válida, nunca executados como código.
- Por padrão negar câmera, microfone, geolocalização, notificações e acesso local. Downloads/uploads somente por ação explícita e diálogo nativo; cancelar não escreve. Web session própria persistida no perfil, opção limpar dados; nunca exportar cookies. Restaurar URL de sessão não carrega rede até ativação explícita da aba; não restaurar URLs com credenciais/tokens.
- Sim, main/side e splitShare persistidos. Generalizar com compatibilidade para árvore de até quatro folhas e grupos de abas, cada aba com alvo tipado e estado independente. Não confundir colunas do documento com painéis do app; tampouco exigir quatro janelas/monitores.
- Preservar aba atual no slot inicial e criar slots vazios com seletor. Demais abas continuam acessíveis em biblioteca/grupos, sem fechar drafts. Troca de preset não distribui automaticamente abas existentes. Migração inicial do split legado conserva seus dois alvos, diferente da seleção manual de um novo preset.
- Move a instância de aba e seu histórico. Escolher aba já aberta move a mesma instância para o slot escolhido. Arrastar arquivo da lateral abre uma instância no slot; múltiplas instâncias da mesma nota compartilham WorkspaceSession, mas mantêm foco/scroll. Slot ocupado só troca conteúdo com destino claro e preserva aba anterior na lista.
- Fechar painel devolve abas ao conjunto acessível; reduzir layout não descarta documentos nem cancela save queue. Falha de salvar permanece visível. Duplicar instância de nota nunca cria segundo documento ou sessão de persistência concorrente.
- Gerenciar bounds/DPI/z-order e foco. Esconder/desanexar superfícies nativas quando diálogo do app cobre a área, restaurando corretamente. Fechar aba/vault destrói WebContents e recursos; não deixar áudio/rede ocultos. Mídia é pausada ao ocultar ou fechar; não inicia autoplay ao restaurar.
- Imagem abre o caminho vertical de alvo de arquivo tipado e viewer simples; PDF e mídia o estendem. Layout de quatro painéis começa com notas existentes; preenchimento conecta arquivos depois. Preservar rotas antigas durante expansão, migrar uso gradualmente, remover legado apenas quando nenhum caller depender dele e testes verdes.
- Usar vault sintético e servidor controlado; testar negativas IPC/traversal/protocolos e comparação de hashes antes/depois. Sites reais têm verificação manual datada separada, sem login pessoal obrigatório. A aceitação antiga #81 conserva seus trinta itens; nova aceitação depende dela e das novas entregas, evitando dependência circular.
- Esta rodada revisa escopo, spec e tickets como continuação do planejamento. Não despachar executores, buildar/instalar nem implementar. Publicar somente documentação agrupada; o pedido de recurso faz parte do escopo planejado.

### Módulos e contratos

- Catálogo de recursos e preferências: metadados de arquivos separados de PageMeta, reutilizando scan.others, watcher, confinamento do VaultRepository e reservas de nomes. Sem indexar binário como texto de nota.
- Host de abas: alvo discriminado página/arquivo/URL/vazio; coexistência com rotas antigas durante migração. Gerenciador de painéis organiza grupos de abas e árvore de splits com no máximo quatro folhas. Layout pertence ao perfil, não ao conteúdo das notas.
- Abertura desktop: bridge restrita para abrir recurso autorizado e aplicativo explicitamente escolhido. O renderer não passa comandos livres nem obtém APIs gerais de processo. Configurações de aplicação são locais ao dispositivo.
- Conteúdo local e remoto usam contextos/sessões distintos. Renderer confiável controla bounds e ações; site/PDF não recebem bridge de arquivos, AI, MCP ou shell. Sem diminuir segurança para suportar uma página.
- Preservar comandos/sessão/save queue para qualquer edição real. Views continuam independentes de fonte e editor pode existir em múltiplos painéis sem duas sessões persistindo a mesma nota.
- Sem novas dependências de runtime nesta autorização. Player de mídia básico, não editor/transcodificador. Compatibilidade real de codecs/PDF deve ser demonstrada no pacote.

## Testing Decisions

- Preferir limite público catálogo→preferência→árvore→abertura e host→painel→estado restaurado. Estender precedentes de MemoryVault, testes de scanner/watch, sessão e abas; não testar só presença de botão.
- Bridge/launcher e servidor local têm testes de contrato para sender, path real, MIME, Range/HEAD/cancelamento, erro de aplicativo e navegação para protocolo proibido. Abertura externa real usa aplicativo inofensivo e perfil sintético, nunca o desktop pessoal.
- UI de pacote Windows comprova PDF páginas/busca/zoom, mídia com seek e layouts 1–4 misturando nota/PDF/vídeo/site. Exigir foco, overlays nativos, DPI, resize, teclado, readonly, light/dark e PT/EN/ES.
- Hashes de binários e notas antes/depois; abrir não escreve nem copia para attachments. Testar placeholders, nomes Unicode/espaços, renomeação externa, vault alternado, limites de scanner e arquivo de mídia acima do limite de upload sem leitura integral.
- Servidor controlado fornece site com redirect/popup/upload/download e tentativas de bridge/protocolo local. Sites reais têm compatibilidade datada com resultado aprovado/limitado/externo; bloqueio de serviço não se transforma em bypass ou aprovação fictícia.
- Nova aceitação é bloqueada por oito tickets adicionais e pela aceitação antiga #81. #81 continua limitada aos trinta itens originais; não adicionar bloqueio reverso que forme ciclo.
- Nesta rodada executar somente validações de planejamento, links, cobertura, dependências e publicação; não alegar teste runtime ou implementação.

## Out of Scope

Implementação nesta rodada; edição interna de Office/PSD, fórmulas de planilha no viewer, Photoshop integrado, transcodificação, DRM ou garantia de qualquer codec/site; sincronizar sessão com navegador externo; copiar cookies; plugins de navegador; generalizar filesystem além do vault; mostrar pastas técnicas ou seguir symlinks/junctions externos; transferir abas para janelas/monitores separados; mais de quatro painéis; novo motor de notas, engine de fórmulas, fork de player ou runtime dependencies sem discussão.

## Further Notes

[Grilling](GRILLING.md), [referências oficiais](RESEARCH.md), [aceitação](ACCEPTANCE.md), [tickets](TICKETS.md) e [handoff](HANDOFF.md) compõem o adendo. A diretriz de commits continua: entregar grupos coerentes D10–D14, não um commit por ticket. Os grupos D1–D9 continuam válidos. Evidências públicas são sintéticas e a política de release exige autorização própria. Rótulo ready-for-agent não despacha execução.
