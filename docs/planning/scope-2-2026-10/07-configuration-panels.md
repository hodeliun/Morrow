# T07 — Painéis de propriedades e seletores legíveis, sem cortes

**GitHub:** https://github.com/hodeliun/Morrow/issues/58

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Configurar propriedades e preenchimento com controles legíveis, catálogos pesquisáveis e sobreposições dentro da janela.

**Implementado e verificado no recorte isolado T07; publicação sequencial autorizada por Carlos.**

## Acceptance criteria

- [x] Separar tipo/Adicionar no painel de criação; rótulos das três opções de inversa não escapam dos botões.
- [x] Painel de prévia de preenchimento usa as camadas compartilhadas e não é recortado pelo contêiner horizontal da tabela; aplicar/cancelar/desfazer acessíveis.
- [x] Moeda pesquisável por código/nome; aplicar busca a locale e fuso onde há catálogo, mantendo entrada numérica e texto verdadeiramente livres.
- [x] Não descartar códigos válidos existentes que o catálogo não liste; exibir valor atual e diagnóstico apropriado.
- [x] Decisão de planejamento: abrir configuração após criação manual bem-sucedida, sem reabrir em importações/duplicações ou apagar a coluna ao cancelar o painel.
- [x] Preservar Escape da camada superior, foco e opções em viewport estreito e largura total.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

UI de criação/configuração, teste de teclado das camadas e round-trip das opções; casos de código válido não listado e preenchimento no extremo direito.

## Traceability and delivery

Origem: S2-06, S2-08, S2-11, S2-25. Grupo de publicação D2 — Apresentação e configuração de tabelas e views. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Implementação autorizada por Carlos e concluída.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T07 -->

## Evidência da entrega isolada

931 testes em 114 arquivos, tipos, lint e compilação aprovados; pacote 3597/3597. UI principal e invalidação real de colunas aprovadas nos seis critérios. Criação manual, catálogos, fill/Undo público, importação, duplicação e reabertura verificados sem mudança de formato 12. [Comportamento e limites](../../deliveries/T07-readable-property-panels.md) e [registro verificável](../../deliveries/T07-validation.json). Negativo do seletor privado de histórico preservado e corrigido sem alterar produto/pacote.
