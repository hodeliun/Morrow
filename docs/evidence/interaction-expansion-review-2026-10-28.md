# Revisão de retomada — expansão de interação

Revisor: GPT-6.1 Sol medium. Executor de correções: GPT-6 Luna max.
Data: 28/10/2026. **Estado: revisão inicial; não comprova conclusão.**

## Grade interativa — achados no WIP recebido

1. Desfazer de paste com novas linhas inverte a ordem de trash/deleteForever e falha.
2. Desfazer de células de relação inversa não restaura vínculos proprietários deslocados.
3. Valores inválidos de clipboard são convertidos em vazio/false antes da validação.
4. Cache local de clipboard pode prevalecer sobre conteúdo novo do sistema e não transporta tipos entre views.
5. Parser TSV não preserva campos multilinha entre aspas nem zeros iniciais de texto.
6. Payload JSON necessita validação completa de dimensões, linhas, tipos e valores.
7. Editores especializados não respeitam integralmente foco/entrada/confirmar/cancelar da grade.
8. Preenchimento precisa de escolha explícita cópia/sequência, prévia dos valores e alternativa de teclado.
9. Sequências de datas misturam UTC/local; extensão para esquerda usa direção incorreta.
10. Revalidação do intervalo/foco e histórico redo incompletos.

Atomicidade em memória de `WorkspaceSession.executeAll` foi identificada, mas não
resolve coerção prévia ou undo incorreto. Os 16 testes recebidos testavam planos;
o handoff os descrevia também como testes de sessão, o que não era sustentado
pelo arquivo examinado. Foram solicitadas regressões reais de sessão, undo,
inversas, recusa de lote, persistência e reabertura.

Todos os achados foram enviados ao executor. A aceitação depende de nova revisão
do diff final e dos resultados dos testes; não fechar #32–#34 por este registro.

## Checkpoints posteriores (ainda sem aceitação final)

- O core foi revisto em rodadas: undo de proprietário deslocado, TSV excessivo
  e troca de pares um-para-um receberam reproduções e correções. Última revisão
  estática não encontrou novo bloqueador no core. Os testes direcionados cresceram
  para 28 casos, incluindo sessões reais, undo/redo, reabertura, limites e
  falha de gravação com retry.
- Revisão estática da UI identificou foco da prévia de preenchimento, handlers
  de link/e-mail/telefone, rascunho/saída de slider/scale/seletores e proteção de
  mutações em tabela somente leitura. As quatro correções foram confirmadas
  estaticamente. Uma regressão de Tab no campo de data fora da grade também foi
  apontada e corrigida pelo executor; aguarda evidência final da interface.
- Executor reportou `npm run check` aprovado com 402 testes, tipos, lint e build
  incluindo o primeiro patch de imagem. O harness da grade segue em execução;
  essa checagem não autoriza fechar os tickets por si só.
- Auditoria das entregas anteriores foi salva separadamente. #27 inicialmente
  falhou porque o harness cancelava a escolha com Escape no HEX; teste corrigido
  confirmou persistência. Duas views canônicas também preservam independência e
  reabertura; fixture sem fallback não representava o serializer do app.
- Recorte tinha defeitos reais de overlay, handles, cálculo de arraste e
  proporção natural, corrigidos em patch separado. UI confirmou aplicar,
  cancelar e reabrir; a substituição salva os metadados e reabre corretamente,
  mas ainda foi observada imagem antiga na sessão atual e erro de seleção.
  Um patch complementar de ciclo de vida do NodeView está em elaboração.
- #40 foi verificado por eventos DOM com DataTransfer e coordenadas, incluindo
  drop para sétima coluna, recusa da oitava e persistência. Não confundir essa
  modalidade com drag nativo do sistema operacional.

Nenhuma entrega desta retomada foi publicada ou issue fechada até este checkpoint.

## Aceitação da entrega 4

Sol medium aprovou #32–#34 após conferir diff, asserções do harness e evidência
final `interaction-expansion-delivery4-ui.json`. Os achados da grade foram
resolvidos; foram repetidos 28 testes direcionados em dois arquivos, aprovados.
O executor reportou `npm run check` aprovado com 405 testes em 54 arquivos,
tipos, lint e builds. O harness confirmou a operação completa por teclado da
prévia (cópia/sequência/aplicar/cancelar), editores especializados, clipboard,
proteção somente leitura, foco após filtros e undo/reabertura/recuperação.

Essa aceitação é exclusiva da grade; Media, ícones, autocomplete e a medição
integrada de 1.000 linhas/células continuam na rodada seguinte/#44.

## Aceitação do lote de correções das entregas anteriores

Sol medium aprovou o lote após conferir scripts e os três JSONs finais citados em
`interaction-expansion-prior-ui.md`. Todos registram ações e reaberturas
aprovadas, fingerprints estáveis, janelas ocultas e zero erros de renderer.
Imagem/recorte/substituição, ícone de propriedade, segunda sugestão por Tab/Enter
e distinção false/null foram confirmados. Os grupos 1/2 e 3 usaram bundles
identificados separadamente, como documentado na evidência.

O check local final passou com 428 testes em 57 arquivos, tipos, lint e build;
esse total local também inclui oito testes iniciais do core de linhas ainda
não publicado. A aprovação e o commit de correções excluem esse WIP, assim como
qualquer aceitação de #35/#36/#44.
