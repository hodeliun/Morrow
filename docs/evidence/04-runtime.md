# Revisão principal — colunas tipadas

Sol 6.1 medium revisou e integrou a entrega Luna max. `npm run check` integrado passou: 225 testes em 24 arquivos, tipagem, lint e builds.

Teste de interface Electron invisível, com perfil e vault sintéticos:

- Tabela editável exibiu BRL, percentual fracionário e duração formatados antes de iniciar a edição.
- Digitar 999 no preço e pressionar Escape manteve 10. Confirmar 17,5 gravou 17.5 no Markdown e mostrou R$ 17,50.
- Alterar a unidade de duração de minutos para horas mudou 90 min para 1,5 h, preservando 5400 segundos no arquivo.
- Alterar o valor inicial do preço para 20 não modificou a linha existente. Nova linha criada pela interface recebeu preço 20, quantidade 2, taxa 0.25, duração 5400, checkbox false e texto multilinha.
- Campo calculado de moeda exibiu R$ 40,00 a partir de preço × quantidade. Fechar e reabrir preservou os resultados e formatos.
- Inspeção visual da captura confirmou as células formatadas e editáveis. Todas as janelas permaneceram invisíveis.

Artefatos locais fora do Git: `local QA folder (excluded from Git)/columns-result.json`, `columns-result.png` e `columns-integration-check.log`.

O motor relacional avançado ainda pertence ao ticket 05. Esta revisão não afirma que o motor legado já oferece referências cross-table ou dependências entre valores iniciais calculados.
