# T07 — Painéis de propriedades e seletores legíveis, sem cortes

**GitHub:** https://github.com/hodeliun/Morrow/issues/58

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Configurar propriedades e preenchimento com controles legíveis, catálogos pesquisáveis e sobreposições dentro da janela.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Separar tipo/Adicionar no painel de criação; rótulos das três opções de inversa não escapam dos botões.
- [ ] Painel de prévia de preenchimento usa as camadas compartilhadas e não é recortado pelo contêiner horizontal da tabela; aplicar/cancelar/desfazer acessíveis.
- [ ] Moeda pesquisável por código/nome; aplicar busca a locale e fuso onde há catálogo, mantendo entrada numérica e texto verdadeiramente livres.
- [ ] Não descartar códigos válidos existentes que o catálogo não liste; exibir valor atual e diagnóstico apropriado.
- [ ] Decisão de planejamento: abrir configuração após criação manual bem-sucedida, sem reabrir em importações/duplicações ou apagar a coluna ao cancelar o painel.
- [ ] Preservar Escape da camada superior, foco e opções em viewport estreito e largura total.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

UI de criação/configuração, teste de teclado das camadas e round-trip das opções; casos de código válido não listado e preenchimento no extremo direito.

## Traceability and delivery

Origem: S2-06, S2-08, S2-11, S2-25. Grupo de publicação D2 — Apresentação e configuração de tabelas e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T07 -->
