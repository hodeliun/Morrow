# Issue #6: fórmula, relação e filtros em escala

Medição reproduzível feita na branch `issue-6-scale-measurement`, a partir do
baseline `0f1ff6a88500214645235611c144456c770abcbd`.

## Fixture e comportamento verificado

`benchmarks/issue-6-scale-measurement.bench.ts` gera registros determinísticos,
sem dados pessoais. O cenário principal contém 1.000 transações ligadas a 50
categorias por IDs estáveis. Cada linha tem duas fórmulas: `Adjusted` multiplica
o valor pela propriedade da categoria relacionada; `Final` depende de `Adjusted`
e de outra propriedade da mesma categoria. A fixture também tem duas views
independentes: uma filtra estado e valor calculado; a outra filtra zona da
categoria relacionada e outro resultado calculado.

As verificações comparam todos os resultados calculados com valores esperados,
confirmam os conjuntos exatos das duas views e alteram apenas o filtro da view A.
Depois da mudança, a seleção da view B permanece idêntica. Uma edição imutável
do multiplicador de uma categoria altera corretamente as fórmulas das linhas
relacionadas.

## Método

- O núcleo real de `src/core/database.ts` é empacotado como um único módulo ESM
  para evitar a sobrecarga de getters do executor de módulos do Vitest. O pacote
  temporário fica em `node_modules/.cache/issue-6-core-benchmark/` e não é
  versionado.
- Cada cenário usa uma fixture criada antes das medições. Cada amostra recebe
  um novo objeto `WorkspaceState`, para começar com o cache vazio sem recriar
  milhares de páginas. O Vitest faz 10 aquecimentos e 100 execuções medidas por
  passada. Pré-cálculos e atualização imutável declarados abaixo ocorrem fora do
  intervalo cronometrado.
- “Primeiro cálculo” significa cache de fórmulas vazio em um estado novo; o
  processo Node e o compilador V8 já estão aquecidos. “Aquecido” repete as
  leituras no mesmo estado, com resultados de fórmula em cache.
- A edição pré-calcula o estado original, altera o multiplicador da primeira
  categoria e troca para um novo estado imutável. O intervalo mede a leitura das
  duas fórmulas em todas as 1.000 linhas após essa mudança.
- Os filtros são medidos após o cálculo das colunas. A troca de filtro aumenta
  o limite da view A de 180 para 220; a view B mantém sua própria configuração.
- A medição é do núcleo puro. Ela não inclui renderização React, início do app,
  IPC, leitura/escrita de arquivos ou interação com o vault.

Para repetir, na raiz do repositório:

```powershell
npm ci
npx vite build --config benchmarks/vite.core-benchmark.config.ts
npx vitest bench benchmarks/issue-6-scale-measurement.bench.ts --run --disableConsoleIntercept --experimental.viteModuleRunner=false
```

## Ambiente observado

- Windows `10.0.26200`, x64; AMD Ryzen 7 5700X, 16 processadores lógicos.
- Node.js `v24.15.0`, npm `11.12.1`, Vitest `5.0.4`, Vite `8.3.4`.
- Duas passadas independentes de 100 execuções medidas cada; valores em
  milissegundos. As colunas mostram a faixa entre as duas passadas. `p50` é a
  mediana; `p99` é o percentil 99 dentro de cada passada.

| Cenário | Linhas | p50 (ms) | p99 (ms) |
|---|---:|---:|---:|
| Primeiro cálculo, cache vazio | 250 | 2,02–2,04 | 3,61–3,99 |
| Primeiro cálculo, cache vazio | 500 | 4,12–4,15 | 7,67–7,70 |
| Primeiro cálculo, cache vazio | 1.000 | 7,53–7,57 | 11,32–11,62 |
| Primeiro cálculo, cache vazio | 2.000 | 15,37–15,45 | 20,74–21,18 |
| Fórmulas com cache aquecido | 1.000 | 4,09–4,14 | 7,02–9,78 |
| Edição de categoria e recálculo dependente | 1.000 | 7,44–7,48 | 11,71–11,94 |
| Aplicar filtro da view A | 1.000 | 2,59–2,60 | 5,90–6,48 |
| Aplicar filtro da view B | 1.000 | 3,17–3,26 | 6,94–7,05 |
| Alterar filtro da view A | 1.000 | 2,83–2,84 | 8,39–8,46 |

Os cenários de escala usam 13, 25, 50 e 50 categorias para 250, 500, 1.000 e
2.000 transações, respectivamente. Entre as passadas, duplicar o conjunto custa
aproximadamente 2,04× de 250 para 500 linhas, 1,83× de 500 para 1.000 e 2,04×
de 1.000 para 2.000. Isso é compatível com crescimento aproximadamente linear
nesta fixture; não é uma garantia para outras fórmulas ou workspaces.

## Leitura e limitações

Não apareceu uma varredura completa da tabela por célula nestas expressões: cada
fórmula lê propriedades da linha atual e resolve a relação pelo mapa de páginas;
as views fazem um percurso pelos registros. O custo mediano no alvo de 1.000
linhas ficou entre 7,53–7,57 ms para a primeira avaliação das duas fórmulas,
7,44–7,48 ms após a edição relacionada e 2,59–3,26 ms para aplicar cada filtro.

O cache de fórmula é indexado por identidade do `WorkspaceState` (`WeakMap`).
Uma troca imutável do estado não reaproveita resultados do estado anterior; a
próxima leitura percorre e recalcula as fórmulas solicitadas. Isso explica o
recálculo completo medido após a edição relacionada. Para 1.000 linhas, essa
execução foi próxima do primeiro cálculo e não mostrou custo relevante que
justifique uma correção neste ticket. Em 2.000 linhas, a mediana ficou em
15,37–15,45 ms e o p99 em 20,74–21,18 ms. A ampliação dobrou o custo mediano
aproximadamente; esta reprodução não mostrou degradação superlinear.

Os números descrevem este computador, a versão Node indicada e duas fórmulas
numéricas com relações simples. Não são meta de desempenho, perfil completo do
app nem evidência de comportamento de fórmulas agregadas que varrem outra tabela.
Não foi aberto ticket de remediação porque a escala observada foi aproximadamente
linear e a execução no alvo de 1.000 linhas não mostrou um gargalo relevante.
