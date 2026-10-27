# Ticket 11 — revisão do principal no aplicativo

A revisão usou apenas um cofre financeiro fictício e um perfil Electron isolado, sempre com janelas invisíveis; nenhum arquivo ou aplicativo pessoal foi aberto.

## Verificado

- Na UI, a prévia mostrou três parcelas de R$ 33,34, R$ 33,33 e R$ 33,33, com vencimentos em 31/12/2026, 31/01/2027 e 28/02/2027. Antes da confirmação, o diretório continha só a compra original.
- A confirmação criou três arquivos Markdown, totalizando 10.000 centavos. Após fechar e reabrir o aplicativo, as quatro linhas e o estado do diário permaneciam disponíveis. O botão de desfazer removeu as três linhas criadas e preservou a compra original.
- O painel da coluna foi aberto pela UI. Alterar rótulo para “Dividir compra”, ícone e cor atualizou o botão e persistiu após reabertura.
- A revisão visual encontrou `33.339999999999996` no arquivo Markdown apesar de a célula mostrar R$ 33,34. O resultado de ações em colunas monetárias agora é gravado na precisão configurada; o arquivo passou a conter `Valor: 33.34`. Um teste cobre essa conversão.
- Os testes de armazenamento de `evidence/11.md` cobrem falha no segundo arquivo, recuperação, bloqueio de outra ação com conflito, clique repetido e desfazer sem sobrescrever edição posterior.
- `npm run check` passou após a correção: tipagem, lint, 275 testes em 34 arquivos e builds renderer/Electron/MCP. `git diff --check` passou.

Artefatos locais fora do Git: `actions-result.json`, `actions-preview.png`, `actions-saved.png`, `actions-reopened.png`, `actions-undone.png`, `actions-authoring-result.json` e `actions-authoring.png` em `local QA folder (excluded from Git)`. Os scripts e dados desse diretório são sintéticos.

## Limite

O journal mantém a última ação recuperável/desfazível do cofre. A integração final e o piloto empacotado pertencem ao ticket 12.
