# Investigação do timeout de persistência de 1.000 células

## Candidato e limite

- Candidato: `9ccf63ff3697dc2187e9d47297bcee07d3fb7118` (`1.2.1-fork.1.1.1`).
- Bundle observado nas execuções: `09e65c934335952051b27386c7f21ce02015ddf8a102ebae94239fad26280d68`.
- A árvore de fonte e o bundle permaneceram estáveis durante cada execução. Os builds não foram alterados.
- O limite original de persistência continua em 120 s. Nenhuma asserção de valor foi removida ou flexibilizada.

## Evidência preservada

- [Falha inicial](../../9ccf63f-final-20261028T151613279-ca6c0aaf/audit/interaction-final-integrated.json): timeout de 120 s, primeiro valor divergente na linha 804 (`esperado 804`, encontrado `0`); fechamento e limpeza confirmados.
- [Repetição isolada](../../9ccf63f-final-20261028T151930999-retry-d33cab5d/audit/interaction-final-integrated.json): timeout de 120 s, primeira divergência na linha 930 (`esperado 930`, encontrado `0`); fechamento e limpeza confirmados. Não atribuí o resultado à execução concorrente de packaging.
- [Sonda com varredura integral espaçada](../../9ccf63f-final-saveprobe-20261028T152441072-7a488d65/audit/interaction-final-integrated.json): a fila atingiu `Salvo` e a leitura integral confirmou os 1.000 valores em 20,081 s; a reabertura também confirmou os valores.
- [Sonda mínima com sentinelas](../../9ccf63f-final-saveprobe-light-20261028T152756546-de4ec8db/audit/interaction-final-integrated.json): sem About/PDF, colagem real no UI, três sentinelas a cada 3 s, uma única verificação integral e reabertura.
- [Diagnóstico integrado no worktree](./interaction-final-integrated.json): passou colagem, persistência, undo, redo, rejeição de 1.001 células, reabertura e PDF. É evidência do worktree e HEAD efetivamente registrados; a vinculação à fonte final é demonstrada separadamente, sem reatribuir a execução a outro HEAD.

## Medidas da sonda mínima

- Colagem visível de 1.000 células: 238 ms.
- Estado de salvamento concluído: 18,128 s após iniciar a observação; verificação em disco terminou em 76 ms.
- Arquivos Markdown alterados: 1.000 nomes distintos observados por `fs.watch`; primeira gravação observada 476 ms após a colagem, última em 16,706 s, intervalo observado de 16,230 s.
- A reabertura confirmou todos os 1.000 valores. Não houve erro de renderer ou console; o app fechou e a fixture sintética foi removida.
- A contagem/latência do `fs.watch` é aproximada. A leitura integral e a reabertura são as verificações autoritativas.

## Diagnóstico e alteração do verificador

As duas execuções com o polling anterior expiraram enquanto a fixture ainda apresentava progresso. As sondas com baixa frequência de leitura convergiram em aproximadamente 18–20 s; na sonda mínima, as 1.000 notas foram verificadas de uma vez em 76 ms. A evidência aponta para contenção causada pelo próprio verificador, que relia até 1.000 arquivos síncronos a cada 500 ms durante gravações serializadas. Essa é uma inferência sustentada pela comparação; não é uma afirmação de SLO do produto.

Em [verify-interaction-final-ui.cjs](../../../../../scripts/verify-interaction-final-ui.cjs), o polling foi alterado para consultar o estado público de salvamento e as notas inicial, central e final. Quando as sentinelas e o indicador estão estáveis, o verificador faz a checagem integral. Se ela encontrar uma divergência, acompanha apenas aquele arquivo até mudar e então verifica o conjunto novamente. O prazo continua em 120 s; a verificação final cobre todos os valores também no timeout.

O diagnóstico integrado no worktree passou com os mesmos limites: primeira gravação 16,422 s, persistência do undo 15,261 s, persistência do redo 16,843 s; rejeitou a colagem de 1.001 células sem criar linhas; os valores reapareceram após reiniciar; erros de renderer ficaram em zero; fechamento e limpeza passaram. O bundle permaneceu estável. Depois dessa execução foi alterada apenas a frase de um comentário, sem mudança de lógica; a equivalência foi provada reconstruindo em memória o comentário anterior e obtendo exatamente o SHA-256 de fonte registrado na execução. Veja [vinculação de proveniência](../../polling-validation-binding.json). Nenhum resultado bruto foi reescrito. A CI e o empacotamento continuam vinculados ao commit final.

## Fronteira de alteração

O único arquivo de implementação alterado foi `scripts/verify-interaction-final-ui.cjs`. Nenhum arquivo em `src/`, `electron/`, `package.json`, lockfile ou diretórios `dist*` foi alterado. Não houve build, commit ou push nesta execução.
