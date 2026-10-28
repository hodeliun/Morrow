# T13 — Views com título próprio e a mesma experiência da tabela inline

**GitHub:** https://github.com/hodeliun/Morrow/issues/64

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Renomear a view pelo título visível, ocultá-lo de verdade e consultar a fonte só nas opções, preservando compartilhamento dos dados.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Reutilizar apresentação/layouts existentes da tabela; não implementar outro banco nem copiar registros para uma view.
- [ ] O título visível identifica a view, alterável sem renomear fonte/outras views; rótulo da fonte fica em Opções.
- [ ] Remover seletores técnicos permanentes e Mostrar título residual; restaurar pelo painel acessível por teclado.
- [ ] Distinguir nome da view/bloco e nome da aba de layout; explicar os campos sem criar dois títulos concorrentes.
- [ ] Tipografia interna da tabela não herda acidentalmente o tamanho/cor de um título externo do canvas.
- [ ] Trocar fonte exige validar os IDs das propriedades e avisar sobre configurações incompatíveis, sem remapear silenciosamente por nomes.
- [ ] Salvar/reabrir duas views com títulos/filtros/layouts diferentes e conferir edição de dados sincronizada com a fonte.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/62

## Verification

Comandos/serialização de views e UI comparativa inline-vinculada; duas views da mesma fonte, readonly, títulos ocultos e troca de fonte.

## Traceability and delivery

Origem: S2-19. Grupo de publicação D2 — Apresentação e configuração de tabelas e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T13 -->
