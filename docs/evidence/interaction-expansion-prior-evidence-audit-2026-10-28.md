# Auditoria das evidências anteriores — expansão de interação

Data: 2026-10-28 (America/Sao_Paulo).

## Escopo e limites

Auditoria estática dos scripts e registros das entregas 1–3 contra a especificação
`docs/planning/interaction-expansion-2026-10/SPEC.md` e os critérios dos tickets
#26, #27, #28, #29, #30, #31, #37, #38, #39, #40, #41, #42 e #43.

Commits examinados:

- `f0a8146`: entrega 1 — #26, #27, #30, #31, #40.
- `c359e19`: entrega 2 — #28, #29, #38, #39.
- `443f3db`: entrega 3 — #37, #41, #42, #43.

Os scripts `scripts/verify-delivery1-ui.cjs`,
`scripts/verify-delivery2-ui.cjs` e `scripts/verify-delivery3-ui.cjs` estavam iguais
às respectivas versões publicadas. Foram lidos os JSONs existentes em
`C:\Users\clove\AppData\Local\Temp\morrow-delivery{1,2,3}-evidence.json`, com
timestamps UTC `2026-10-28T02:24:48.100Z`, `2026-10-28T03:35:38.788Z` e
`2026-10-28T04:45:27.483Z`. Esses arquivos temporários podem não permanecer
disponíveis; os resultados relevantes estão transcritos abaixo.

Não foram executados UI, build ou testes. Não houve alteração de código ou
scripts. A revisão da grade da entrega 4 não faz parte deste documento.
Os achados são lacunas de evidência: não demonstram, por si só, defeitos nos
recursos. Não se afirma verificação completa nem nova aprovação dos tickets.

## Resultado

Os registros existentes não sustentam a verificação integral dos 13 tickets.
Há cobertura complementar de lógica, Markdown e armazenamento, mas parte dos
campos positivos dos JSONs vem de constantes ou verificações de presença de
controles. A matriz de #44 precisa distinguir essas modalidades e vincular cada
afirmação a uma asserção e resultado reais.

### 1. #37 e #41: resultados não comprovam busca e autocomplete na interface

Em `scripts/verify-delivery3-ui.cjs:319`, a busca aceita qualquer lista não vazia.
O JSON registra todos os 25 tipos após pesquisar `moeda`, incluindo Texto,
E-mail, Relação e Botão de ação. Isso não demonstra filtragem correta.

Em `scripts/verify-delivery3-ui.cjs:393`, as asserções de #41 exigem editor,
token e raio visual, mas não sugestões. O JSON contém
`dotAutocompleteTested: true` e `suggestionsFound: []` após `Autor.`.

Os testes puros em `PropertyTypeSelect.test.ts` e
`formulaEditorModel.test.ts` cobrem busca e resolução de sugestões; não
substituem a comprovação da ligação real entre entrada e interface. O script
altera valores DOM e dispara eventos sintéticos; esta auditoria não determinou
por que os resultados não mudaram.

Casos futuros para #44:

- Digitar por teclado e exigir conjunto filtrado correto para aliases PT/EN,
  caixa e acentos; conferir resultados esperados e exclusão dos incompatíveis.
- Navegar pela lista por teclado; escolher/resetar ícone e alterar tipo
  preservando override; salvar e reabrir.
- Digitar relation ponto, conferir sugestões concretas, selecionar a ativa com
  Tab e verificar expressão/caret. Incluir nomes com espaços, relação vazia e
  múltipla, colagem/IME, bindings após renomear e painel junto à borda.

### 2. #43: prévia positiva pode significar apenas botão existente

Em `scripts/verify-delivery3-ui.cjs:496`,
`unionPreviewRendered` é `!!unionPreviewEl || hasLinkInverse`. O JSON registra
`unionPreviewChecked: true` com `unionSummarySample: ""`.
O script verifica os modos, mas não escolhe uma coluna existente compatível,
aplica união nem desvincula.

Há testes de core para união, conflitos, edição de relações e materialização
segura em `delivery3.test.ts` e `relations.test.ts`. A lacuna é a integração do
fluxo de configuração com persistência e interface.

Casos futuros para #44:

- Duas colunas já preenchidas: conferir os pares/contagens da prévia antes de
  aplicar e comparar os pares efetivos após salvar.
- Criar inversa e vincular existente; editar ambos os lados sem duplicar pares.
- Recusar conflito de cardinalidade, destino ou vínculo ocupado sem alteração.
- Desvincular, conferir materialização e reabrir preservando vínculos; cobrir
  zero/um/múltiplos vínculos e self-relation válida, conforme o ticket.

### 3. #28, #38 e #39: fixture da entrega 2 não popula o banco

Em `scripts/verify-delivery2-ui.cjs:100–104`, banco e itens são gravados como
arquivos irmãos na raiz do vault. O carregador associa linhas à hierarquia de
pastas (`src/core/vault/load.ts:206–210`), e as linhas de um banco são suas
subpáginas. Os itens sintéticos não ficam dentro do banco dessa fixture.

O script não exige linhas renderizadas nem valores agregados. O JSON de #39
registra em `operationsAvailable` as seções gerais Filtrar, Ordenar, Layout,
Propriedades, Calcular e Formatação condicional, em vez de operações de cálculo.
As asserções exigem rodapé e gatilhos/resumos, não resultados numéricos.
Para #38, são verificados controles de regra, prévia, modo e campo de fórmula,
sem demonstrar a cor efetivamente aplicada aos dados.

`delivery2.test.ts` cobre agregações, zero/false/vazios, fórmulas condicionais e
prioridade no core. Isso não comprova os fluxos de interação com dados reais na
fixture UI.

Casos futuros para #44:

- Criar itens na pasta do banco e assertar IDs/quantidade das linhas visíveis
  antes de verificar filtros, cores ou cálculos.
- #28: operadores por relation/data/número, adicionar/remover/resetar, separação
  entre filtros rápidos e permanentes e configurações independentes por view.
- #38: prévia sem gravação, cancelar/salvar, aplicação de cor em célula/linha,
  prioridade, thisRow/relation, diagnóstico de erro/null/tipo inválido e bindings
  após renomear/remover campos.
- #39: duas colunas com operações diferentes; resultados sobre linhas filtradas;
  moeda/datas/listas/zero/false/vazios e erro de fórmula; alinhamento, formato e
  congelamento; operações distintas entre views após reiniciar.

### 4. #29: independência, persistência e mapa de vínculos não exercitados

Em `scripts/verify-delivery2-ui.cjs:379–391`, são exigidos seção, aparência e
presença de controles. O script não renomeia a view nem verifica isolamento.
`backlinksMapAccessible` é literal `true`. `collapseWorks` é registrado, mas não
assertado. A condição visual `isUnboxed` também aceita fundo transparente OU
ausência de borda; não exige ambas as propriedades descritas no comentário.

Casos futuros para #44:

- Duas views com nomes, filtros e cálculos distintos; alterar uma e conferir a
  origem e a outra view.
- Ocultar título e recolher simultaneamente; reabrir/configurar por teclado.
- Navegar do mapa na origem à página/bloco correto; excluir view sem excluir
  linhas; manter diagnóstico de origem ausente/ciclo.
- Reiniciar e conferir estados locais, nomes e operações independentes.

### 5. #26, #27 e #30: afirmações positivas sem operações correspondentes

Em `scripts/verify-delivery1-ui.cjs:153–160`, o script confere o sumário estreito
e registra flip/shift e teclado como `true`, sem abrir menus junto às bordas,
medir alcance, aplicar zoom ou testar foco/Escape.

Para #27, o resultado coletado em `ticket27Result` não é assertado. Aplicação
HEX, preservação de texto, round trip e cancelamento são registrados como
constantes positivas, sem realizar o fluxo de escolha de cor.

Para #30, o script observa elementos DOM. A fixture referencia `sample.png`,
mas não cria esse arquivo; não realiza substituição ou recorte. Flags de
recorte não destrutivo, substituição e validação não provêm dessas operações.
Há testes complementares de validação/Markdown e da decisão de preservar ou
resetar crop pela proporção em `delivery1.test.ts` e
`delivery1-editor.test.ts`, além de cobertura de fundo em armazenamento.

Casos futuros para #44:

- #26: menus, fórmula e popovers aninhados perto de cada borda nas resoluções
  previstas e com zoom 125%/150%; rolagem interna, Escape e retorno de foco.
- #27: escolher preset/HEX por teclado; aplicar/cancelar/limpar em título e
  parágrafo dentro de colunas; preservar texto, undo/redo e reabertura.
- #30: criar imagem sintética válida; substituir por imagem de mesma e diferente
  proporção, conferir legenda/alinhamento/crop; cancelar e desfazer; diagnosticar
  upload inválido/arquivo ausente; conferir arquivo original e PDF/Markdown.

### 6. #31 e #40: renderização inicial extrapolada para edição completa

A entrega 1 testa recolher/expandir uma seção e contar sete colunas
pré-carregadas. Em `scripts/verify-delivery1-ui.cjs:233–260`, revelação de
ancestrais, impressão, recusa de oitava coluna, drop lateral e limpeza de
contêiner são registrados positivamente sem executar os respectivos fluxos.

Há testes complementares de round trip e revelação de ancestrais. Eles não
substituem a verificação da edição e navegação reais.

Casos futuros para #44:

- #31: H1–H6 opt-in, títulos aninhados em colunas/listas, irmãos e seção vazia;
  busca/sumário/link revelando ancestrais; desabilitar sem perda; undo/redo,
  reinício e exportação com conteúdo completo.
- #40: criar/mover colunas por mouse e menu/teclado, conferir posição e ordem;
  recusar oitava com explicação; remover contêiner vazio ao mover entre grupos;
  cancelar, undo/redo, larguras e acesso em janela estreita; salvar/reabrir.

### 7. #42: moeda e zero comprovados, paridade de autoria não comprovada

Em `scripts/verify-delivery3-ui.cjs:438–450`, o script verifica seletor e valores
já configurados. O JSON demonstra moeda e zero renderizados. Não compara
Formula com coluna tipada calculada, não altera formato nem confere preservação
de expressão/bindings. False aparece no resultado observado, mas não há uma
asserção específica para ele.

`delivery3.test.ts` cobre formatos e diagnósticos de saída incompatível no core.

Casos futuros para #44:

- Comparar as duas rotas de autoria para resultados equivalentes nos formatos
  suportados e suas opções válidas.
- Alterar formato preservando expressão e bindings; conferir ausência de
  controles de edição/default inadequados a resultados derivados.
- Conferir incompatibilidade, zero/null/false e persistência após reiniciar.

## Uso na validação integrada de #44

Nenhum dos três scripts relança o aplicativo, lê os arquivos salvos para
validar as alterações ou exporta PDF. Não usar seus campos `VERIFIED` como
aprovação automática dos critérios de reinício, undo/redo e exportação.

A matriz de #44 deve registrar, para cada requisito, o caso executado, a
asserção, o resultado observado e o artefato correspondente. Separar cobertura
de core, comando/sessão/armazenamento, interface e exportação; registrar
limitações e casos ainda não executados. Os cenários acima derivam dos tickets
e da spec existentes, sem ampliar seu escopo.

Além destas lacunas anteriores, #44 mantém seus critérios próprios de migração,
falha de gravação e recuperação, traduções PT/EN/ES, foco/contraste e medição
de 1.000 linhas/células. Este documento não os considera já verificados e não
substitui as revisões das entregas 4 e 5.
