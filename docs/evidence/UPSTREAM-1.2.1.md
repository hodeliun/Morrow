# Verificação da sincronização com Morrow 1.2.1

Data: 27/10/2026. Base oficial: `5e6392bb6425924abd30eec8a99b42aa8c953577`.

## Integração

O merge foi realizado com dois pais, preservando a linha oficial. Seis conflitos foram resolvidos:

| Arquivo | Resolução |
|---|---|
| README | Explica separadamente a base 1.2.1 e o fork 1.0.0, mantendo o guia do demo sintético e a informação de migração do upstream. |
| package.json e package-lock.json | Conserva dependências e correções upstream, aplica o identificador técnico `1.2.1-fork.1.0.0` e metadados separados. |
| PropertyValue | Mantém os tipos e validação do fork, acrescenta o desfazer do upstream e preserva a opção numérica `step` sem colisão de nomes. |
| EditorMenus | Mantém cores/fundo de bloco do fork e usa a conversão de blocos e títulos H4–H6 do upstream. |
| editor.css | Mantém espaçamento por nota e aplica a proporção acima/abaixo de títulos corrigida pelo upstream. |

## Checagens

- `npm run check`: 46 arquivos de teste, **334 testes aprovados**, TypeScript, ESLint e build concluídos.
- Novas regressões: checklists do Notion com `[]` e espaço não separável; histórico restaura documento, propriedades e metadados extras.
- Perfil Electron oculto com vault sintético: Sobre mostrou base 1.2.1, fork 1.0.0, revisão `5e6392b` e pacote `1.2.1-fork.1.0.0`; tabela relacionada mostrou projeção 7 e número `15,00`; Ctrl+Z em campo numérico com rascunho voltou ao valor salvo sem esvaziar o campo. O valor sintético foi restaurado depois do teste.
- Nenhum vault pessoal ou instalação do usuário foi aberto ou alterado.

## Limites

O teste inicial de interface foi representativo e não percorreu manualmente as 22 correções oficiais. A rodada inicial não incluiu importação de pacote Notion nem exportação de PDF; a rodada complementar abaixo cobre esses fluxos em dados sintéticos. O executável portátil 1.0.0 foi publicado na release inicial.

## Rodada complementar e correção 1.0.1

- `node scripts/verify-upstream-ui.cjs` iniciou Electron oculto com perfil e cofre temporários. Pela interface, importou um ZIP sintético com página, subpágina e checklist no formato de exportação do Notion; ambas as páginas apareceram, e a principal foi gravada em Markdown.
- O teste editou o parágrafo pelo editor, aguardou a persistência, abriu **Histórico da página**, restaurou a versão inicial e confirmou que a versão editada permaneceu recuperável no histórico.
- O teste acionou **Exportar como PDF** no menu da página; o diálogo nativo foi redirecionado por um entrypoint exclusivo do teste para um arquivo temporário. O PDF gerado pela rotina real de impressão tinha uma página e texto extraível.
- A primeira execução revelou que o PDF incluía o botão **Estilo da página**. A regra de impressão passou a ocultá-lo. Após rebuild e nova execução, o PDF extraído continha o título, o texto e a tarefa sintética, sem o botão.
- `npm run check` passou com 46 arquivos de teste e 334 testes, além de tipo, lint e build, após a correção de CSS.
- A validação usou apenas pastas em `%TEMP%`; nenhum cofre pessoal, perfil instalado ou janela do usuário foi manipulado. O `npm run check`, a verificação de interface oculta via `node scripts/verify-upstream-ui.cjs` e a geração do pacote `1.2.1-fork.1.0.1` foram concluídos com sucesso.
