# T39 — Validar arquivos, navegação e painéis com o escopo anterior

**GitHub:** https://github.com/hodeliun/Morrow/issues/91

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Concluir a expansão somente com evidências dos novos itens e regressão do planejamento original.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Bloqueado também pela aceitação original #81; não mudar os trinta critérios originais nem criar dependência circular.
- [ ] Matriz cobre S2-31 a S2-37 e todos os subcritérios; pacote/commit e esperado/observado registrados. Nenhum recurso aprovado só por existir no código.
- [ ] Pacote desktop mistura nota, PDF, vídeo e site em quatro painéis; testar chooser vazio, arraste, resize, foco, restore, close, readonly, light/dark e PT/EN/ES.
- [ ] Vault sintético antes/depois com hashes dos binários e Markdown, abrir sem gravar conteúdo, unknown YAML preservado, limites do scanner e consumo/seek documentados.
- [ ] Testar sender não confiável, traversal/junction e navegação remota tentando acessar recursos locais; uploads/downloads só com gesto; ausência de subprocessos órfãos.
- [ ] Rodar checks/CI pertinentes no futuro commit consolidado e revisão independente; mídia pública apenas sintética conforme política de release.
- [ ] Não construir pacote, instalar, despachar executor ou publicar release durante a rodada atual de planejamento.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/83
- https://github.com/hodeliun/Morrow/issues/84
- https://github.com/hodeliun/Morrow/issues/85
- https://github.com/hodeliun/Morrow/issues/86
- https://github.com/hodeliun/Morrow/issues/87
- https://github.com/hodeliun/Morrow/issues/88
- https://github.com/hodeliun/Morrow/issues/89
- https://github.com/hodeliun/Morrow/issues/90
- https://github.com/hodeliun/Morrow/issues/81

## Verification

Gate final: aceitação original #81 e oito novos tickets concluídos, checklist auditável, evidências de UI e verificação de segurança pelos contratos públicos.

## Traceability and delivery

Origem: S2-31, S2-32, S2-33, S2-34, S2-35, S2-36, S2-37. Grupo D14 — Aceitação integrada da expansão. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T39 -->
