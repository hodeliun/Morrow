# T09 — Regras condicionais corretas com estilos de célula e linha

**GitHub:** https://github.com/hodeliun/Morrow/issues/60

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Aplicar critérios simples/fórmula e estilos visuais tipados, com propriedade correta ao abrir pelo cabeçalho.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Reproduzir numericamente valores acima/abaixo/iguais ao limite e explicar regra inválida em vez de fingir correspondência.
- [ ] Ação da coluna inicia regra com sua propriedade identificada; editar uma regra não muda outra.
- [ ] Reutilizar mecanismo de filtros/fórmulas puro, distinguindo alcance célula/linha e preservando regras antigas só de fundo.
- [ ] Adicionar cor do texto, negrito e itálico além de fundo; por atributo, a última regra correspondente na ordem explícita prevalece.
- [ ] Critério por fórmula exige resultado booleano ou diagnóstico claro, sem coerção silenciosa de número/texto.
- [ ] Persistir estilos/regras e rejeitar configuração inválida sem perda de regras anteriores.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Seams de avaliação de regras, comandos e round-trip de schema; UI comprova estilo realmente aplicado, não apenas prévia no formulário.

## Traceability and delivery

Origem: S2-16. Grupo de publicação D3 — Editor de fórmulas e formatação condicional. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T09 -->
