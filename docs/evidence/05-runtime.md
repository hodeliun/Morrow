# Revisão principal — fórmulas relacionais

O principal integrou a entrega com as células de mídia. Os três conflitos de imports/migração foram resolvidos preservando validação de mídia e bindings. Check integrado: 243 testes em 28 arquivos, tipagem, lint e builds aprovados.

Teste Electron invisível com perfil e dados sintéticos:

- Criação de `thisRow.Artefato.Valor` pela interface retornou 3.
- `Artefatos.Filter(CurrentValue.Status = "Ativo").Valor.Sum()` retornou 3 usando o nome visível de uma opção select.
- Uma lista com número, booleano e zero foi exibida sem erro. Depois o assistente de referências inseriu a tabela e o campo e produziu `Artefatos.Valor`, exibindo a lista 3, 5; as sugestões por nome também apareceram.
- Editar o valor de origem para 9 recalculou projeção e soma. Renomear a coluna Valor para Custo preservou as fórmulas já vinculadas e os resultados 9.
- Uma coluna richCanvas calculada por `thisRow.Original` abriu o conteúdo completo em leitura, com formatação preservada e sem editor ativo.
- Fechar/reabrir o aplicativo manteve os resultados e vínculos após o rename.

Todas as janelas permaneceram invisíveis e nenhum vault pessoal foi usado. Artefatos locais: `local QA folder (excluded from Git)/formulas-result.json`, `formulas-result.png` e `formula-integration-check.log`.

Funções e limites estão documentados em `docs/FORMULAS.md`. A medição do executor de uma consulta sobre mil linhas é um caso local, não uma garantia universal de desempenho.
