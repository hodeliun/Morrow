# Revisão principal — relações

Revisão e integração pelo principal Sol 6.1, esforço medium, após execução Luna max. Conflitos entre relações, ícones, YAML e estilo foram resolvidos preservando validação integral de metadados e a projeção inversa. `npm run check` integrado passou: 211 testes em 22 arquivos, typecheck, lint e builds.

Teste Electron invisível com vault sintético: a relação Autor do livro Duna mostrou somente Asha e Bela, ambas da tabela configurada; excluiu a página externa ao banco. Selecionar Asha gravou ID estável e rótulo legível no Markdown. Abrir Asha mostrou Duna na relação inversa. Fechar/reabrir preservou o vínculo. Todas as janelas permaneceram invisíveis.

Evidências locais: `local QA folder (excluded from Git)/relations-result.json` e `relations-result.png`. Nenhuma fonte pessoal foi alterada.
