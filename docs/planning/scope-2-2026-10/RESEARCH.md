# Referências oficiais e limite da pesquisa

Consulta de planejamento em 28/10/2026. Referências inspiram comportamento; não autorizam copiar ativos proprietários.

- [Canvas control basics — Coda](https://help.coda.io/hc/en-us/articles/39555865536013-Canvas-control-basics): descreve controles no documento e um conjunto popular, não um catálogo fechado; distingue controles pessoais e colaborativos. O Morrow desta especificação permanece local, com valores persistidos e sem promessa de colaboração.
- [Basics of Coda formulas — Coda](https://help.coda.io/hc/en-us/articles/39555858394637-Basics-of-Coda-formulas): descreve fórmulas no canvas e referências a objetos. As cores da referência indicam origem/local dos dados; neste projeto, classes semânticas distintas são uma decisão de UX solicitada, não reprodução daquela semântica.

## Catálogo delimitado

| Existentes a completar | Acréscimos |
| --- | --- |
| texto, número, slider, select, checkbox, data, relation | seleção múltipla, escala, progresso, intervalo de datas |

A união dos controles já existentes com os mostrados na referência resulta em onze tipos. Paridade com todo Coda não é critério de conclusão. Inspeção do baseline encontrou NamedControl, CalculatedResult, bindings por ID, comandos de controle e serialização Markdown, além de ViewDef.order e journal de recuperação. Essas são evidências estáticas, não aceitação da instalação do usuário.
