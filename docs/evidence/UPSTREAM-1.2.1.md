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

O teste de interface foi representativo, não percorreu manualmente as 22 correções oficiais. Importação e histórico foram verificados por testes de comportamento, sem importação manual de um pacote Notion nem exportação manual de PDF. O executável portátil final precisa ser gerado e publicado separadamente após o commit final.
