# T31 — Mostrar arquivos e pastas com filtros por extensão

**GitHub:** https://github.com/hodeliun/Morrow/issues/83

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Encontrar arquivos comuns do vault e configurar o que aparece sem alterar os originais.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Catálogo separa arquivo binário de página Markdown e mostra pastas comuns contendo apenas mídia/Office; não criar notas de pasta artificiais.
- [ ] Configuração pesquisável mostra extensões detectadas/conhecidas, permite adicionar extensão e arquivos sem extensão, selecionar tipos ou todos e ocultar tipos específicos; comparação case-insensitive.
- [ ] Filtro é visual e por vault no perfil local; reset restaura padrão. Ocultar não exclui, não altera parser e mantém abertura por referência explícita.
- [ ] Imagens/PDF/áudio/vídeo/Office/PSD podem ser listados; desconhecido continua visível no modo todos. Attachments tem controle visual sem duplicação de conteúdo.
- [ ] Preservar exclusão de .morrow/.git/ocultos técnicos/temporários e confinamento realpath, junction e symlink; não escanear outros discos.
- [ ] Watcher reflete criação/remoção/renomeação externa e alternar vault não vaza catálogo. Scan não lê todos os bytes dos binários nem inicia rede para placeholders.

## Blocked by

Nenhum bloqueador funcional — atribuir somente após autorização de desenvolvimento.

## Verification

Vault sintético com pasta só de PDF, extensões em caixa mista, sem extensão, ocultos, junction externo, placeholder e dez mil entradas; validar árvore, configuração, watcher, limites e hashes.

## Traceability and delivery

Origem: S2-31. Grupo D10 — Explorador de arquivos e aplicativos associados. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T31 -->
