# T34 — Visualizar PDF local em uma aba interna

**GitHub:** https://github.com/hodeliun/Morrow/issues/86

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Ler PDF de qualquer pasta comum do vault sem sair do app.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Abrir PDF existente com controle de páginas, zoom, busca e rolagem na aba; usar infraestrutura do Electron antes de adicionar dependência.
- [ ] PDF isolado do preload/bridge do aplicativo, sem navegar para caminho arbitrário; links externos passam pelo roteamento validado.
- [ ] Arquivo preservado e sem importação; servidor/recurso local valida MIME, path real e acesso somente ao arquivo selecionado.
- [ ] PDF inválido, protegido por senha ou indisponível informa condição apropriada; não armazenar senha nem sobrescrever arquivo; fallback externo explícito.
- [ ] Comprovar viewer no Windows empacotado, incluindo resize, tema e painel estreito; não aceitar só hyperlink para navegador externo como implementação.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/85

## Verification

PDF sintético multipágina com texto pesquisável, arquivo grande, inválido e protegido; pacote real para páginas/busca/zoom, acessos negados e hashes.

## Traceability and delivery

Origem: S2-33. Grupo D11 — Visualizadores locais de imagens, PDF e mídia. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/planning/scope-2-files-and-panes/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T34 -->
