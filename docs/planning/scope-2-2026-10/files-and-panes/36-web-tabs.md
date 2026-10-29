# T36 — Navegar sites em abas internas isoladas

**GitHub:** https://github.com/hodeliun/Morrow/issues/88

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Abrir URL em aba com navegação básica e fallback externo sem dar acesso ao vault para o site.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Barra de endereço visível, voltar/avançar/recarregar/parar, título, estado de carregamento/erro e abrir no navegador externo; links de notas têm opção interna/externa e preferência clara. A abertura externa respeita o navegador configurado.
- [ ] Usar WebContentsView top-level, sem preload do app/Node e com isolamento, sandbox e webSecurity; negar acesso a filesystem e protocolos privilegiados em navegação/redirecionamentos/popups/requests.
- [ ] HTTP(S) validado; HTTPS ao completar domínio, HTTP explícito sinalizado. Bloquear javascript/data/file/vault-file; protocolos externos só por gesto e decisão explícita.
- [ ] Sessão web separada do renderer e local viewers; permissões negadas por padrão. Upload/download só após ação e diálogo de seleção; cancelamento não escreve. Limpar dados do navegador disponível.
- [ ] YouTube/Drive/Sheets são casos reais datados, não promessa de login/DRM. Se serviço bloquear navegador/login, oferecer externo sem copiar cookies, alterar user-agent para burlar ou fingir que sessão externa volta autenticada.
- [ ] Resolver .gsheet/.gdoc somente como descritor de URL HTTP(S) válido, sem avaliar código; XLSX continua arquivo local com associação.
- [ ] Restaurar URL não carrega site até ativação explícita; não persistir URLs com credenciais/tokens. Fechar aba/vault libera WebContents/rede.
- [ ] Testar overlays/foco/bounds/DPI: conteúdo nativo não cobre menus, diálogos ou seletores; ocultação pausa mídia e não deixa processo órfão.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/85

## Verification

Servidor sintético com redirect/popup/download/upload e página que tenta acessar bridge/protocolo local; pacote Windows, limpeza sessão e verificação manual de sites sem conta pessoal.

## Traceability and delivery

Origem: S2-35. Grupo D12 — Navegação web isolada. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T36 -->
