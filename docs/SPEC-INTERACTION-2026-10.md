# Morrow — interação com páginas, tabelas e fórmulas

Status: especificação incremental, 27/10/2026. Complementa `SPEC.md`; não substitui contratos de dados existentes. Referência: demonstração local do usuário de 27/10/2026 (vídeo privado, não publicado no repositório).

## Problem Statement

É difícil descobrir e ajustar a apresentação de páginas e tabelas. Algumas escolhas exigem abrir painéis ou editar sintaxe manualmente, embora os valores e relações já existam no modelo. Opções numéricas confundem formatação, validação e sequência de criação. A pessoa precisa editar com retorno visual, filtros visíveis e ações previsíveis, preservando os arquivos Markdown e os dados atuais.

## Solution

Adicionar escolhas de cor personalizadas junto às cores rápidas; ampliar a área útil da página e redimensionar colunas de conteúdo; tornar as ações de coluna e filtros acessíveis no local onde se trabalha; melhorar a configuração numérica e a autoria de fórmulas; mostrar descrições e resultados vazios com clareza. Toda alteração persistida passa por comandos existentes, é traduzida, acessível e reabre corretamente.

## User Stories

1. Como autora, escolho uma cor pronta ou abro claramente um seletor de cor personalizada para texto, realce e fundo de bloco, para combinar minha página com a identidade do projeto.
2. Como autora, vejo a cor hexadecimal escolhida, posso redefini-la e ela permanece ao reabrir o Markdown, sem executar HTML arbitrário.
3. Como autora, entendo que a última amostra de cor do ícone abre uma paleta personalizada, inclusive por teclado.
4. Como autora, arrasto a divisória das colunas de texto da página para dar mais espaço a uma delas; consigo desfazer e reabrir com as proporções preservadas.
5. Como autora, escolho largura confortável, ampla ou total da área útil da nota, vejo a mudança antes de salvar e mantenho notas existentes como estão até alterá-las.
6. Como autora, clico no título de uma tabela inserida para renomear sem sair da nota e tenho um controle separado para abrir a tabela em página inteira.
7. Como autora, acesso um menu contextual pelo cabeçalho da coluna com editar tipo/formato, fórmula, descrição, ordenar, filtrar, inserir antes/depois, duplicar com/sem valores, congelar e ajustar largura ao conteúdo.
8. Como autora, escolho uma coluna de exibição da linha, usada nas relações e referências, sem alterar os valores armazenados.
9. Como autora, escolho altura da linha por visualização para textos longos não tornarem a tabela impraticável; posso expandir uma célula para ler tudo.
10. Como autora, vejo a barra de filtros em tabelas e visualizações vinculadas, com operadores coerentes com cada tipo, estado ativo e ação para limpar; cada visualização conserva seus filtros.
11. Como autora, distingo filtro permanente da visualização e filtro rápido temporário da barra, inclusive depois de reabrir a página.
12. Como autora, vejo um ícone de informação no cabeçalho quando uma coluna tem descrição e leio a descrição com mouse ou teclado.
13. Como autora, edito configuração numérica com controles explicados: localidade define separadores/símbolos de exibição; casas decimais define a apresentação; mínimo/máximo validam entradas; passo controla ajuste/validação, sem prometer sequência.
14. Como autora, posso optar por sequência automática para novos registros, com início e incremento definidos, sem sobrescrever valores explícitos ou linhas existentes e sem reutilizar números após exclusão por acidente.
15. Como autora, vejo uma prévia numérica e salvo/cancelo ajustes explicitamente quando houver vários campos pendentes.
16. Como autora, completo fórmulas com sugestões de campos, tabelas, relações e funções; vejo referências reconhecidas como tokens visuais editáveis, preservando uma expressão textual portátil.
17. Como autora, posso selecionar `thisRow.Relacao.Valor` por sugestões contextuais, incluindo nomes com espaços e relação múltipla; o cálculo retorna valor tipado ou lista conforme a relação.
18. Como autora, vejo prévia, tipo do resultado e diagnóstico de erro sem ter de criar uma linha falsa; célula vazia não é exibida como erro.
19. Como autora, uso uma função `IfError(expressao, alternativa)` para tratar um erro de cálculo de modo explícito, mantendo o erro visível quando não houver alternativa.
20. Como autora, posso encontrar a função de tratar erros e a projeção de relação na ajuda do editor e nos exemplos, sem memorizar a sintaxe completa.

## Implementation Decisions

- Reusar a arquitetura de documento, comando, sessão e persistência. Novos atributos de cor e largura são validados ao ler, não alteram notas antigas e sobrevivem ao round trip Markdown.
- Aceitar somente cores `#RRGGBB` (e `#RRGGBBAA` se a renderização/persistência atual suportar com segurança); a primeira entrega usa `#RRGGBB`. Contraste de foco e texto deve permanecer legível.
- Proporções das colunas da página pertencem ao bloco de colunas, não à preferência global nem à tabela de dados. Ajustes da largura da tabela já existem por visualização e não devem ser duplicados.
- Largura da nota é configuração por nota, com padrão herdado apenas na criação. A opção total deve respeitar margens mínimas e janelas estreitas.
- Renomeação de tabela inserida e projeção `thisRow.Relacao.Valor` já existem no código do fork. A entrega cobre descoberta, fluxo e regressões em builds atuais; não reimplementar o mesmo modelo.
- Separar **formato** (localidade, moeda, casas decimais), **validação/controle** (mínimo, máximo, passo) e **padrão/geração** (literal, fórmula, sequência). Passo não significa auto numeração. A sequência é reservada por banco e definida em comando atômico de criação, preservando unicidade em criações concorrentes e importações.
- Valor numérico é armazenado independente de localidade. Precisão de apresentação deve renderizar casas fixas; não arredondar silenciosamente o valor salvo. Mostrar o valor bruto ao editar quando a precisão visual ocultar dígitos.
- Menu contextual e painel existente de propriedade devem chamar as mesmas ações; evitar dois modelos de configuração. Congelamento, altura e filtros rápidos são locais à visualização; tipo e descrição pertencem ao esquema.
- Congelar colunas é limitado a prefixo contíguo a partir da coluna de exibição; rolagem horizontal deve manter cabeçalhos/células alinhados.
- Ajustar ao conteúdo mede valores renderizados com limite máximo e não altera outras visualizações. Duplicar coluna cria ID novo; cópia com valores preserva tipo e reporta erros de conversão sem perda.
- Editor de fórmulas continua armazenando texto e bindings por ID estável. Tokens são representação da expressão, não uma segunda linguagem. Edição/colar texto pode ser feita sem depender dos tokens.
- Resolver sugestões após ponto pelo tipo do receptor: linha, tabela, relação única ou múltipla. Nomes ambíguos exigem escolha explícita. Relação vazia resulta em `null`/lista vazia; projeção sobre vazio não vira erro sintático. Erros reais continuam diagnosticados.
- `IfError` captura somente erro de avaliação da primeira expressão, avalia a alternativa de modo preguiçoso e não converte vazio, `false` ou zero em erro. A função não permite efeitos colaterais.
- Conteúdo da demonstração pessoal não é fixture. Usar banco sintético de duas tabelas para aceitação.

## Addendum — coluna de exibição e atalhos do menu

A revisão do primeiro menu contextual mostrou que a história 8 ainda não estava coberta e que fórmula/formatação condicional só eram alcançadas pelo painel genérico. O ticket complementar `interaction-13-display-and-shortcuts.md` estabelece uma coluna de exibição padrão por banco, sem reescrever o título armazenado. A escolha explícita em uma relação continua prevalecendo sobre o padrão do banco. O mesmo ticket leva as ações de fórmula e formatação condicional ao menu existente, reutilizando os painéis já implementados.

## Testing Decisions

- Verificar comportamento no limite comando/sessão/reabertura, não detalhes de componentes. Casos: cor personalizada, larguras e proporções, menus por teclado, sequência com valor explícito/remoção/reabertura, formatação decimal, filtros isolados, duplicação, projeção de relação vazia/única/múltipla, `IfError` e erros reais.
- Reusar testes Vitest de comandos, Markdown, banco de dados e fórmulas. Adicionar teste de UI para fluxos visuais e foco, com perfil isolado e dados sintéticos; não abrir o perfil real.
- Executar `npm run check` na integração. Inspeção visual deve ocorrer de modo oculto ou somente na segunda tela autorizada pelo usuário.

## Out of Scope

- Paridade total com a sintaxe, automações ou produtos comerciais do Coda/Notion.
- Importar os dados da gravação, alterar vault pessoal, sincronizar contas ou mover janelas para a tela principal.
- Agrupamento de linhas e propriedades de autoria multiusuário nesta rodada.

## Further Notes — revisão crítica interna

- Evidência do código atual: redimensionamento de colunas de **tabela**, renomeação de tabela inserida, sugestões básicas de fórmulas, filtros por visualização e projeção relacional já existem. A gravação mostra lacunas de descoberta/ergonomia e pode usar build anterior; cada ticket começa confirmando o comportamento no HEAD do fork.
- Não confundir `null` com erro. O símbolo de vazio pode ser discreto, mas diagnósticos nunca devem desaparecer.
- Se uma ação exigir migração de metadados, ela deve ser aditiva e compatível com as páginas existentes.
