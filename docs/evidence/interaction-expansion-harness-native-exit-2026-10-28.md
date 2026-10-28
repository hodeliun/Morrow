# Diagnóstico do encerramento nativo do harness de UI — grupo 2

**Data:** 2026-10-28
**Resultado:** falha nativa não reproduzida na execução standalone; causa interna permanece indeterminada.

## Ocorrência reportada

- A rodada anterior terminou o processo Node com código decimal `3221226505` (`0xC0000409`), sem texto em stderr.
- O último progresso disponível foi `PASS action #28`, `PASS action #29`, `PASS reopen #29`, `PASS action #38` e `PASS reopen #38`; não houve `PASS action #39`.
- A execução deixou um processo Electron principal e três subprocessos associados a um perfil sintético da etapa seguinte. O processo Node pai já havia encerrado e a rodada não produziu JSON final.

## Reprodução standalone

- Comando: `node scripts/verify-delivery2-ui.cjs`, em processo oculto, com perfil e vault sintéticos isolados.
- **Saída:** exit code `0` (`0x00000000`); stderr vazio; #28, #29, #38 e #39 passaram, incluindo as reaberturas previstas.
- **Integridade:** `pageErrors: []`, nenhuma falha fatal, janelas ocultas e fingerprint idêntico antes e depois de todos os lançamentos.
- Bundle observado: `dist-electron/main.cjs` mtime `2026-10-28T08:29:07.792Z`; renderer `index.html` mtime `2026-10-28T08:29:07.357Z`; 197 assets; manifesto SHA-256 `36a8b4fb53eeab87e9af9ba520b02084e8381daa9c9661e628fec20511948b77`.

## Diagnóstico delimitado

O perfil sintético restante e os argumentos dos processos Electron situam a interrupção reportada durante ou logo após a abertura do aplicativo da etapa #39, depois do último log referente a #38. Isso não identifica o módulo ou a causa do `0xC0000409`; a execução standalone completa passou, então a falha permanece intermitente e não foi reproduzida.

Não encontrei evento Application Error/WER correspondente no intervalo local consultado, nem dump recente de Node/Electron na pasta local de crash dumps examinada. O stderr vazio e a ausência de JSON final deixam sem stack nativo a rodada que falhou. Não há evidência suficiente para atribuir a falha ao código do produto, ao Playwright, ao Electron, ao Node ou a um driver.

## Limpeza e alterações

- Após verificar os caminhos dos executáveis, a relação pai/filhos e o perfil sintético exato, encerrei somente quatro processos Electron órfãos pertencentes à rodada: o processo principal e três filhos. O processo Node pai já não existia.
- A consulta posterior confirmou que os quatro PIDs alvo haviam terminado. Os arquivos da fixture sintética foram preservados; não houve remoção de dados.
- Nenhum outro processo Node/Electron foi encerrado. Não alterei scripts, código de produto ou bundle; executei somente a reprodução de UI descrita acima, sem build, commit ou push.
