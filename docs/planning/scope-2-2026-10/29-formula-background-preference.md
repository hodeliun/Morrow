# T29 — Preferência de fundo dos resultados por nota

**GitHub:** https://github.com/hodeliun/Morrow/issues/80

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Escolher fundo discreto para fórmulas sem alterar retroativamente notas antigas.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Preferência global define novas notas e inicia ativada; criação registra a escolha da nota.
- [ ] Cada nota pode sobrescrever a preferência; alterar padrão global não reescreve notas existentes.
- [ ] Notas legadas sem campo mantêm apresentação anterior com fundo, sem gravação ao abrir.
- [ ] Sem fundo, resultado mantém foco/hover, leitura e acesso à configuração; readonly funciona.
- [ ] Preferências e overrides sobrevivem à reabertura e preservam metadados desconhecidos.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/78

## Verification

Nova nota antes/depois de trocar padrão, override local, legado sem campo, readonly, light/dark e abertura sem escrita.

## Traceability and delivery

Origem: S2-30. Grupo de publicação D8 — Resultados inline e rede de referências. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T29 -->
