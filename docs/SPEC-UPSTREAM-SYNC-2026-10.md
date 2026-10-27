# Sincronização com Morrow e versões independentes

Status: aprovado pelo pedido de atualização de 27/10/2026. Base oficial alvo: Morrow 1.2.1, commit `5e6392bb6425924abd30eec8a99b42aa8c953577`.

## Problem Statement

O fork mostra `1.2.4`, embora ainda se baseie no código oficial 1.2.0. Isso impede distinguir a base oficial das melhorias do fork e deixa correções recentes de bugs fora do produto.

## Solution

Integrar a linha oficial até 1.2.1 sem substituir as funções próprias. Manter duas referências explícitas: **base Morrow** (versão e commit upstream) e **modificações do fork** (versão independente). Mostrar ambas em Sobre, manter um changelog do fork e registrar cada sincronização upstream com seus grupos de correções. O número técnico do pacote combina as duas séries para que cada artefato seja identificável.

## User Stories

1. Como usuária, vejo a versão oficial usada como base e o commit correspondente para saber quais correções herdamos.
2. Como usuária, vejo uma versão própria do fork para distinguir nossas funcionalidades do projeto original.
3. Como usuária, consulto o changelog do fork e identifico o que foi adicionado ou corrigido a cada lançamento.
4. Como usuária, recebo as correções oficiais 1.2.1 sem perder bancos de dados, fórmulas, relações e personalização do fork.
5. Como mantenedora, consigo apontar exatamente a revisão upstream incorporada e preparar a próxima atualização sem adivinhar o ponto de partida.
6. Como mantenedora, só publico uma nova versão quando testes, compilação e cenários sintéticos de regressão passam.

## Implementation Decisions

- Merge normal de `upstream/main` em uma branch temporária baseada na `main` do fork. Isso preserva a ancestralidade oficial para atualizações futuras. Não reescrever histórico nem usar force push.
- A versão própria inicial é `1.0.0`, primeira versão com essa convenção; ela não tenta reescrever os lançamentos anteriores. A versão técnica do pacote será `1.2.1-fork.1.0.0` (SemVer válido), enquanto os metadados guardam `1.2.1`, o commit upstream e `1.0.0` separadamente.
- `CHANGELOG-FORK.md` descreve as alterações do fork e a sincronização da base; `AGENTS.md` e a tela Sobre apresentam as duas séries sem afirmar que `1.2.4` era uma versão oficial.
- Ao resolver conflitos, preservar ambos os comportamentos quando compatíveis. Onde houver incompatibilidade, priorizar a correção de bug oficial e manter o contrato adicional do fork com testes.
- O nome do aplicativo continua Morrow, conforme a preferência já aplicada. A identificação de fork fica nas versões e no changelog.

## Testing Decisions

- `npm run check` é o gate completo: tipos, lint, testes e build.
- Cobrir regressões representativas das correções upstream: editor, importação, histórico, campos de banco e exportação conforme testes existentes e novos testes de comportamento quando houver lacuna.
- Usar apenas dados sintéticos e perfil isolado para teste de interface. Verificar que relações, fórmulas, filtros e defaults do fork continuam funcionando.
- Conferir CI da `main` após publicação e o pacote gerado antes de declarar atualização disponível.

## Out of Scope

- Copiar conteúdo pessoal, alterar o vault do usuário, instalar o aplicativo na máquina ou propor as mudanças ao repositório oficial.
- Compatibilidade funcional total entre o fork e releases futuras ainda não publicadas.

## Further Notes

Antes da integração, a simulação de merge apontou 6 conflitos (README, manifesto e lockfile, campo de propriedade, menu de editor e CSS do editor). O estado e a aceitação finais devem registrar como foram resolvidos.
