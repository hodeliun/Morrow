# T01 — Clipboard de células e linhas funcionando no aplicativo desktop

**GitHub:** https://github.com/hodeliun/Morrow/issues/52

## Parent

https://github.com/hodeliun/Morrow/issues/51

## What to build

Copiar e colar células/intervalos e copiar resultados de fórmula na instalação empacotada, usando a capacidade desktop existente de forma explícita.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Reproduzir o erro de permissão em um pacote identificado e comparar com o desenvolvimento; registrar a versão e o comportamento real, sem inferir que o vídeo corresponde à última release.
- [ ] Na superfície desktop, ler/escrever clipboard por adaptador com ponte restrita ao processo principal; não desligar segurança do Electron nem conceder permissões amplas ao navegador.
- [ ] Copiar valor calculado para destino editável; proibir colar sobre cálculo e rejeitar lote inválido sem escrita parcial.
- [ ] Preservar TSV externo e metadados tipados internos; não reaproveitar cache antigo quando o clipboard do sistema mudar ou falhar.
- [ ] Cobrir também os fluxos de copiar/colar linhas que hoje usam a mesma API, sem quebrar o protocolo de cópia de banco.
- [ ] Comprovar a correção em Windows empacotado com dados sintéticos e clipboard real de ambiente de teste; nenhuma simulação de permissão conta como evidência desktop.

## Blocked by

Nenhum bloqueador funcional — pronto para atribuição após autorização de execução.

## Verification

Testes de contrato do adaptador de plataforma, comandos/storage para colagem atômica e UI empacotada sem injetar permissões do navegador; nenhum conteúdo pessoal de clipboard em relatórios.

## Traceability and delivery

Origem: S2-07. Grupo de publicação D1 — Confiabilidade: clipboard, edição, gestos e integridade. Um ticket não implica um commit separado.

Respeitar arquitetura, IDs estáveis, engine pura, readonly, compatibilidade Markdown/YAML e abrir sem escrever; PT/EN/ES, temas e painel estreito. Evidências públicas somente sintéticas. Não iniciar implementação nesta rodada.

[Spec e decisões](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f/docs/planning/scope-2-2026-10/ACCEPTANCE.md)
<!-- morrow-scope-2-2026-10:T01 -->
