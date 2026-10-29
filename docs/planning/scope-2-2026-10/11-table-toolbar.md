# T11 — Barra compacta, filtros discretos e área útil de bancos

**GitHub:** https://github.com/hodeliun/Morrow/issues/62

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Navegar views e configurar tabelas numa barra estável, com filtros compactos e melhor uso de largura.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Views à esquerda e opções/busca/filtro/ordenação à direita; abas com rolagem e indicação de continuidade quando não couberem, sem esconder ações.
- [ ] Chips mostram propriedade e estado ativo; condição completa surge ao abrir. Ícones de layout aparecem no seletor.
- [ ] Seção de vínculos começa recolhida e expande listas grandes sem perder navegação.
- [ ] Páginas novas de banco usam largura total por padrão; uma largura explicitamente escolhida em página existente é respeitada, sem migração ao abrir.
- [ ] Tabela inline/view não são forçadas a largura total da janela fora de seu bloco; estilo do bloco e da página permanecem distintos.
- [ ] Controle por teclado e viewport estreito continuam operáveis; no espaço insuficiente, não sobrepor ou cortar comandos.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

UI comparativa de página de banco, inline e view em larguras distintas; salvar filtros/abas e preservar preferências existentes.

## Traceability and delivery

Origem: S2-15, S2-23, S2-28. Grupo de publicação D2 — Apresentação e configuração de tabelas e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T11 -->
