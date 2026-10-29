# T32 — Associar extensões ao viewer interno, sistema ou aplicativo escolhido

**GitHub:** https://github.com/hodeliun/Morrow/issues/84

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Escolher como abrir cada tipo de arquivo e manter arquivos sem viewer navegáveis.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Por extensão, oferecer interno somente quando houver capacidade, padrão do sistema e aplicativo específico escolhido por diálogo nativo; restaurar padrão e escolher abertura pontual.
- [ ] Configuração de visibilidade não muda handler e mudar handler não oculta arquivo; nenhuma alteração nas associações globais do sistema.
- [ ] Ação explícita do renderer confiável valida recurso do vault, sender e executável escolhido; passar caminho como argumento sem shell/modelos livres, inclusive espaços e metacaracteres.
- [ ] Aplicativo ausente, erro de lançamento ou tipo sem associação produz mensagem e opção escolher/abrir pasta, sem sucesso falso nem loop.
- [ ] Preferências de executável ficam locais ao dispositivo; perfil de outro computador exige escolher novamente.
- [ ] Planilhas, DOCX, PSD e tipos arbitrários abrem no aplicativo configurado, sem prometer edição/preview interno; nunca executar arquivo desconhecido como conteúdo ativo no Morrow.
- [ ] Para links HTTP(S), permitir navegador padrão do sistema ou navegador específico escolhido no dispositivo; abertura web externa respeita essa escolha. Arquivo local enviado a aplicativo recebe somente seu caminho, sem upload automático.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/83

## Verification

Contrato de launcher com fake OS e pacote Windows com aplicativo inofensivo de teste; caminhos especiais, traversal, sender remoto, exe removido, cancelamento e associação sem aplicação.

## Traceability and delivery

Origem: S2-32. Grupo D10 — Explorador de arquivos e aplicativos associados. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T32 -->
