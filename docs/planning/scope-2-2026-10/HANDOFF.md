# Handoff — planejamento do Aumento de Escopo 2

**PLANEJAMENTO SOMENTE. EXECUÇÃO NÃO AUTORIZADA.**

Leia SPEC, GRILLING, ACCEPTANCE e TICKETS desta pasta, além de AGENTS, ARCHITECTURE, CONTRIBUTING e políticas de commits/release do projeto. Baseline 0e1a9417aaef9a0f0f11d094ed2f09a56f988e4e, pacote 1.2.1-fork.1.1.1.

## Estado

Especificação e tickets preparados; nenhuma modificação funcional realizada. GitHub é autoridade de status. Ready-for-agent significa escopo executável depois de autorização explícita, não ordem para iniciar. Não despachar executor, buildar, instalar ou publicar release por ler este handoff.

## Quando houver autorização futura

1. Revalidar branch, alterações de terceiros, versão e status/dependências no GitHub. Reutilizar planejamento, não reiniciar setup.
2. Principal/revisor preferido: GPT 6.1 Sol medium; executores GPT 6 Luna max, nas sessões e projeto definidos pela política de orquestração. Não trocar modelo silenciosamente.
3. Despachar somente fronteira com bloqueadores concluídos, atribuir responsabilidade e evitar concorrência nos mesmos módulos. Cada executor recebe ticket e critérios completos e preserva alterações alheias.
4. Concluir caminho UI→comando→persistência→reabertura com testes pertinentes. Relato do vídeo não determina causa técnica. Fixtures sintéticas; material pessoal nunca entra no repo.
5. Integrar por grupos funcionais D1–D9; ticket não é commit automático. Preservar upstream e histórico já compartilhado. Uma revisão independente valida comportamento antes de marcar tickets concluídos.
6. Aceitação final depende de T01–T29. Não usar sucesso de npm check como substituto para clipboard desktop, foco, gesto ou validação visual. Release exige sua própria autorização e política de evidências.

## Contratos de segurança e compatibilidade

Engine pura sem eval/ações; IDs estáveis; preservação de YAML/Markdown desconhecido; readonly real; zero/falso/vazio distintos; sem escrita ao abrir; journal de recuperação existente preservado. Nenhuma dependência de runtime nova está aprovada.


## Ler também o adendo de arquivos

Antes de qualquer execução futura, ler [arquivos, web e painéis](files-and-panes/HANDOFF.md). Total planejado: 37 itens e 39 tickets. O gate original #81 continua dos trinta itens iniciais; o novo gate cobre o adendo e depende de #81, sem bloqueio reverso. Nenhuma implementação iniciada.
