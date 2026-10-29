# Aumento de Escopo 2 — especificação

**Estado:** planejamento publicado; implementação não autorizada.
**Baseline:** Morrow 1.2.1 + fork 1.1.1; commit 0e1a9417aaef9a0f0f11d094ed2f09a56f988e4e.
**Rastreabilidade:** S2-01 a S2-30 identificam requisitos da consolidação privada. T01 a T30 identificam entregas; os números não são equivalentes.

## Problem Statement

A edição cotidiana ainda apresenta falhas de clipboard, conflitos de gestos, painéis recortados e comportamentos pouco claros de tabelas, views, títulos e fórmulas. A revisão de uso também pede melhor navegação, controles no documento e resultados encadeados. A existência de um recurso no código ou de uma validação anterior não comprova o comportamento relatado na versão gravada, que não foi identificada.

## Solution

Corrigir e completar os contratos atuais em nove grupos de entrega. Cada fatia precisa ser demonstrável desde a interação até a reabertura dos dados. Os sete controles e os resultados inline existentes são a base; somente capacidades ausentes serão acrescentadas. Os trinta itens de origem permanecem rastreáveis, sem publicar mídia pessoal nem substituir o mecanismo de fórmulas.

## User Stories

1. Como pessoa que edita documentos e bancos, quero copiar e colar células/intervalos e copiar resultados de fórmula na instalação empacotada, usando a capacidade desktop existente de forma explícita, para confiar na edição sem perder conteúdo.
2. Como pessoa que edita documentos e bancos, quero selecionar uma célula editável, digitar diretamente, confirmar e avançar; tratar texto multilinha sem perda do rascunho, para confiar na edição sem perder conteúdo.
3. Como pessoa que edita documentos e bancos, quero oferecer menu de coluna consistente, renomear o cabeçalho Nome e editar títulos de linha, além de trocar/restaurar o campo de exibição, para organizar o trabalho com menos interrupções.
4. Como pessoa que edita documentos e bancos, quero arrastar um cabeçalho para antes/depois de outro com destino claro, mantendo o schema e outras views, para organizar o trabalho com menos interrupções.
5. Como pessoa que edita documentos e bancos, quero selecionar várias linhas pelos checkboxes, usar a margem por hover/foco e acessar ações em menu compacto, para organizar o trabalho com menos interrupções.
6. Como pessoa que edita documentos e bancos, quero dentro de uma view vinculada, arrastar células seleciona intervalos; somente a alça do bloco move a view, para confiar na edição sem perder conteúdo.
7. Como pessoa que edita documentos e bancos, quero configurar propriedades e preenchimento com controles legíveis, catálogos pesquisáveis e sobreposições dentro da janela, para organizar o trabalho com menos interrupções.
8. Como pessoa que edita documentos e bancos, quero editar fórmulas com cursor fiel ao texto, distinção visual das referências, sugestões de funções e confirmação inequívoca, para organizar o trabalho com menos interrupções.
9. Como pessoa que edita documentos e bancos, quero aplicar critérios simples/fórmula e estilos visuais tipados, com propriedade correta ao abrir pelo cabeçalho, para organizar o trabalho com menos interrupções.
10. Como pessoa que edita documentos e bancos, quero criar, editar, pré-visualizar e recolher várias regras em grupos compreensíveis, para organizar o trabalho com menos interrupções.
11. Como pessoa que edita documentos e bancos, quero navegar views e configurar tabelas numa barra estável, com filtros compactos e melhor uso de largura, para organizar o trabalho com menos interrupções.
12. Como pessoa que edita documentos e bancos, quero adicionar registros antes dos cálculos e usar resumo sem uma faixa de dados artificial, para organizar o trabalho com menos interrupções.
13. Como pessoa que edita documentos e bancos, quero renomear a view pelo título visível, ocultá-lo de verdade e consultar a fonte só nas opções, preservando compartilhamento dos dados, para organizar o trabalho com menos interrupções.
14. Como pessoa que edita documentos e bancos, quero reproduzir o desaparecimento visual e garantir que converter/editar blocos não descarte uma tabela inesperadamente, para confiar na edição sem perder conteúdo.
15. Como pessoa que edita documentos e bancos, quero transformar títulos/textos em conteúdo recolhível e voltar, sem perder estilo nem deixar alças duplicadas sem função, para organizar o trabalho com menos interrupções.
16. Como pessoa que edita documentos e bancos, quero abrir/fechar o sumário, ir a um título e trocar abas sem perder o ponto de leitura, para organizar o trabalho com menos interrupções.
17. Como pessoa que edita documentos e bancos, quero criar e visualizar títulos sem receber azul automaticamente, preservando escolhas explícitas de cor, para organizar o trabalho com menos interrupções.
18. Como pessoa que edita documentos e bancos, quero ajustar tamanho individual de imagens mantendo recorte, alinhamento e importação local, para organizar o trabalho com menos interrupções.
19. Como pessoa que edita documentos e bancos, quero arrastar separadores de até sete colunas de conteúdo, com proporções próprias e ajuste fino, para organizar o trabalho com menos interrupções.
20. Como pessoa que edita documentos e bancos, quero manipular grupos de colunas e inserir parágrafos sem perder conteúdo ou ver destinos conflitantes, para organizar o trabalho com menos interrupções.
21. Como pessoa que edita documentos e bancos, quero manter dez ações recentes por banco de origem durante a sessão, compartilhadas entre suas views, para organizar o trabalho com menos interrupções.
22. Como pessoa que edita documentos e bancos, quero desfazer mudanças locais de apresentação sem alterar as outras visualizações, para organizar o trabalho com menos interrupções.
23. Como pessoa que edita documentos e bancos, quero tornar utilizáveis os sete controles já presentes, com configurações e valores compreensíveis, para usar dados e cálculos no fluxo da escrita.
24. Como pessoa que edita documentos e bancos, quero escolher vários valores no documento e reutilizar a seleção em cálculos e filtros, para usar dados e cálculos no fluxo da escrita.
25. Como pessoa que edita documentos e bancos, quero usar escala e progresso configuráveis sem perder a precisão dos cálculos, para usar dados e cálculos no fluxo da escrita.
26. Como pessoa que edita documentos e bancos, quero selecionar um intervalo de datas e utilizá-lo em filtros e fórmulas, para usar dados e cálculos no fluxo da escrita.
27. Como pessoa que edita documentos e bancos, quero apresentar o resultado calculado no fluxo do documento, com edição acessível, para usar dados e cálculos no fluxo da escrita.
28. Como pessoa que edita documentos e bancos, quero selecionar referências identificáveis e encadear cálculos sem perder vínculos ao renomear, para usar dados e cálculos no fluxo da escrita.
29. Como pessoa que edita documentos e bancos, quero escolher fundo discreto para fórmulas sem alterar retroativamente notas antigas, para usar dados e cálculos no fluxo da escrita.
30. Como mantenedor, quero comprovação por requisito no pacote desktop, para distinguir recurso disponível de recurso funcionando.
31. Como pessoa com notas antigas, quero que abrir um arquivo preserve seu conteúdo e preferências, para não sofrer migrações silenciosas.
32. Como pessoa que navega por teclado, quero foco, atalhos e nomes acessíveis, para operar sem depender de arrastar ou reconhecer cores.
33. Como mantenedor, quero entregas e commits coerentes com evidências sintéticas, para revisar e reverter melhorias sem expor documentos pessoais.

## Implementation Decisions

- Arquitetura preservada: editor React emite comando; applyCommand puro produz mudança; WorkspaceSession/SaveQueue persiste via VaultRepository; sistema de arquivos restrito ao Electron. Sem escrita direta por componente de UI.
- Estender modelos existentes de propriedades, ViewDef, controles, resultados calculados e bindings. Mudanças de metadados são aditivas; campos YAML/Markdown/comentários desconhecidos e documentos readonly não são descartados nem regravados ao abrir.
- Interpretador permanece puro e limitado: sem eval, acesso a rede, ações de botão ou gravação. Valores vazios, zero, falso e erro continuam distintos; nenhuma string de apresentação substitui o dado tipado.
- Nome é projeção do título obrigatório com alias editável. Coluna de exibição do banco e override de apresentação da relation são decisões diferentes. Ordem e configuração de view não alteram esquema global.
- Clipboard usa adaptador restrito da plataforma e interoperabilidade TSV; validação de colagem é atômica, cálculos não recebem escrita e cache nunca mascara falha do sistema.
- Controle de interação é específico: seleção de célula não arrasta NodeView; salvar/cancelar, IME e teclado têm contratos comuns, sem stopEvent indiscriminado.
- Controles existentes: texto, número, slider, select, checkbox, data e relation. Ampliar catálogo com multiSelect, scale, progress e dateRange; aproveitar validadores, formatos, comandos e serialização existentes.
- Referências nomeadas mantêm bindings por ID, resolução explícita por página, desambiguação, diagnóstico de exclusão e ciclos; copiar remapeia somente identidades locais da cópia.
- Sem novas dependências de runtime sem discussão prévia. PT/EN/ES, light/dark, teclado, foco e painéis estreitos fazem parte da entrega.
- Escolha de planejamento: digitação inicia edição, Enter confirma valor válido e avança uma linha, Shift+Enter insere quebra no texto, Escape cancela e blur confirma valor válido. Preservar IME. Ajustável apenas com evidência posterior, sem inventar resposta do usuário.
- Dados: dez ações por banco de origem, compartilhadas entre views. Configuração: dez por view. Ação contextual mais recente informa o proprietário; desfazer de draft fica no editor. Isso evita duas views desfazerem versões incompatíveis dos mesmos dados.
- Ampliação inicial é limitada à sessão. Preservar journal persistido de recuperação existente, inclusive conflitos e limite de tamanho. Não prometer dez ações após reiniciar. Teto global inicial de 32 MiB é suposição de planejamento a validar, com descarte só de entradas concluídas antigas.
- Validar estado esperado antes de aplicar inversa; conflito produz diagnóstico/recuperação, não sobrescrita. Nova edição invalida redo do escopo afetado, não de todos os bancos sem motivo.
- Última regra correspondente por atributo (fundo, texto, negrito, itálico). Expressão deve resultar em booleano ou diagnóstico. Preservar regras legadas de fundo e preselecionar contexto correto da coluna.
- Adotar sugestão como padrão na criação manual. Não interromper importação/duplicação. Cancelar fecha configuração e não apaga a coluna que acabou de ser criada.
- Mostrar confirmação e prévia; retirada do contêiner conserva filhos no fluxo normal após o grupo. Apagar conteúdo é ação destrutiva distinta. Escape, undo e round-trip devem conservar IDs e blocos embutidos.
- Par ordenado de datas ISO sem hora ou vazio, compatível com lista tipada atual. Presets inclusivos e finitos: hoje, últimos sete dias, mês atual, próximos sete dias e personalizado. Selecionar materializa datas; abrir não recalcula nem grava. Não confundir lista com relation.
- Não nesta entrega: fundo de resultados é padrão para novas notas, registrado na criação, com override por nota. Legado ausente resolve apresentação atual sem escrita ao abrir. Largura total de bancos segue a mesma proteção a preferências existentes.
- Não. Nove grupos de entrega propostos, ajustáveis por risco e resultado final; checkpoints locais são consolidados antes do primeiro push. Documentação desta rodada é um único commit. Não reescrever histórico já publicado.

## Testing Decisions

- Preferir comportamento público: comando→sessão→repositório e reabertura; UI real para gestos, foco, clipboard e dimensões. Usar precedentes de testes de NamedData, bindings, resultados, copia/remapeamento e recovery existentes.
- Testar inversas e conflitos com repositório temporário; engine pura com zero/falso/vazio, ciclos e limites. Não escrever testes que só confirmam existência de configuração.
- Para clipboard, permissões simuladas em navegador não substituem leitura/escrita reais em pacote Windows isolado. Nenhum conteúdo pessoal de clipboard deve ser registrado.
- Por ticket: cenário mínimo, resultado esperado/observado, versão/commit, testes, evidência e pendências. Matriz de aceitação contém todos os subcritérios; nenhum checkbox pode ser marcado por inferência.
- Verificar light/dark, painel estreito, readonly e PT/EN/ES; unknown YAML/Markdown, abrir sem escrever, comandos desfeitos e reabertura.
- Aceitação final exige checks existentes e CI no commit consolidado, revisão independente e evidência de mil linhas com metodologia/medidas registradas, sem meta de desempenho inventada.
- Esta rodada valida apenas a consistência do planejamento. Não declara execução ou passagem de testes do produto.

## Out of Scope

Implementar nesta rodada; iniciar agentes executores; instalar/buildar/publicar versão; anexar material privado ao GitHub; engine alternativa; ações, automações, canvas buttons ou Packs; colaboração multiusuário/personal controls; catálogo integral do Coda; converter arquivos JSON Canvas; reescrever histórico Git; alterar a base oficial sem necessidade desta expansão.

## Further Notes

Grilling e decisões explícitas: [GRILLING.md](GRILLING.md). Referências oficiais limitadas: [RESEARCH.md](RESEARCH.md). Cobertura verificável: [ACCEPTANCE.md](ACCEPTANCE.md). Os tickets e relações do GitHub são autoridade de status; a documentação não é prova de implementação. A política existente de commits e de release continua válida, com separação de novidades da base e do fork e mídia sintética demonstrativa. Ready-for-agent descreve preparação, não despacho.


## Addendum — files, web and panes

[Additional specification](files-and-panes/SPEC.md) extends this original thirty-item baseline to 37 source requirements and 39 tickets. Read both before executing. The original specification issue is preserved; the new specification is https://github.com/hodeliun/Morrow/issues/82. This is planning only.
