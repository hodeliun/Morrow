# T14 — Preservar tabelas ao editar e converter blocos

**GitHub:** https://github.com/hodeliun/Morrow/issues/65

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Reproduzir o desaparecimento visual e garantir que converter/editar blocos não descarte uma tabela inesperadamente.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Registrar pacote/versão e sequência mínima sintética que diferencie remover, ocultar e deslocar um bloco.
- [ ] Conferir identidades, conteúdo do documento, schema, registros e arquivos antes/depois; não declarar perda de dados só por ausência visual.
- [ ] Conversões de título/alternador, exclusão de contêiner e confirmação de célula não descartam filhos sem intenção.
- [ ] Persistência e watcher preservam dados/desconhecidos; documento incompatível não é normalizado destrutivamente.
- [ ] Desfazer e reabrir preservam vínculos e conteúdo; exclusão intencional tem resultado inequívoco.
- [ ] Uma causa corrigida exige teste que falhe no caminho real; não fechar só por ausência de reprodução em outro ambiente.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

ProseMirror/documento → comandos/session → MemoryVault e reabertura real; UI da sequência sem substituir estado interno para fabricar o resultado.

## Traceability and delivery

Origem: S2-21. Grupo de publicação D1 — Confiabilidade: clipboard, edição, gestos e integridade. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/planning/scope-2-2026-10/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T14 -->
