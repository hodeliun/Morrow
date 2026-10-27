# Handoff para continuidade no Gemini — 27/10/2026

## Onde está o projeto

- Repositório público: <https://github.com/hodeliun/Morrow>.
- Diretório local: `C:\Users\clove\Projetos\Morrow Public Fork`.
- Branch de produto e padrão: `polaris`; `main` preserva a base original.
- Commit funcional validado: `c16aa05d2dfc371e031f338b056b082a672dbe8f`.
- Upstream: <https://github.com/Aarav2709/Morrow>; este fork conserva licença Apache-2.0 e atribuição.
- Ler `AGENTS.md` do repositório antes de trabalhar. Não publicar histórico do repositório privado nem dados pessoais.

## Produto e planejamento

- Base do produto e arquitetura: `docs/SPEC.md`, `docs/RESEARCH.md`, `docs/GRILLING.md`, `docs/FORMULAS.md`.
- Escopo incremental desta rodada: `docs/SPEC-INTERACTION-2026-10.md` e issue [#7](https://github.com/hodeliun/Morrow/issues/7).
- Tickets: issues [#8–#20](https://github.com/hodeliun/Morrow/issues); espelhos em `docs/tickets/`.
- #8 e #18 estão fechadas. #9–#17, #19 e #20 seguem abertas para conferir todos os critérios de aceitação e registrar evidência, embora haja implementação em `polaris`. Não tratar issue aberta como recurso ausente nem fechá-la sem conferir o texto do ticket.

## O que já está implementado em `polaris`

- Cores personalizadas para texto, realce e fundo de bloco; seletor de cor do ícone mais legível. Fundo hexadecimal claro escolhe texto escuro automaticamente.
- Largura confortável/ampla/total por nota; colunas de texto redimensionáveis por ponteiro ou teclado e salvas no Markdown.
- Título de tabela inserida editável no lugar, botão separado para abrir; menu contextual acessível no cabeçalho de coluna.
- Duplicação de coluna com ou sem valores e opção de desfazer; congelamento, ajuste ao conteúdo e altura de linha por visualização.
- Descrição da coluna no cabeçalho, coluna de exibição da tabela e opção de exibição específica para relação.
- Barra de filtros rápidos locais à visualização, distinta das regras salvas.
- Formatação numérica com precisão/localidade, prévia, ajuda e salvar/cancelar; sequência automática com contador persistente.
- Editor de fórmulas com sugestões, destaque de referências, prévia e `IfError`; projeção tipada `thisRow.Relacao.Coluna` para trazer dados de outra tabela.

## Estado verificado

- `npm run check` passou no commit `c16aa05`: 46 arquivos de teste, 332 testes, tipos, lint e compilação.
- CI Windows do commit passou: <https://github.com/hodeliun/Morrow/actions/runs/40541137249>.
- Testes visuais foram feitos com perfil Electron oculto e dados **fictícios** em `C:\Users\clove\AppData\Local\Temp\morrow-qa-34c1d3b-20261027`. Confirmado: projeção de relação, coluna de exibição, precisão `15,00`, congelamento, ajuste de largura, altura de linha, duplicação/desfazer, foco inicial do editor de fórmula, `IfError(1 / 0, 42) = 42`, filtro rápido com resultado vazio e limpeza, largura total, cor personalizada legível e divisória de colunas que muda/salva a largura no Markdown.
- A sequência automática tem testes de núcleo e persistência, mas **o fluxo completo de configuração e criação pela interface ainda não foi concluído**. Na cópia fictícia existe uma coluna `Seq` recém-criada em `People.md`, ainda em preenchimento padrão comum; não usar isso como prova de sequência.
- O cenário de duas visualizações vinculadas com filtros separados, navegação por teclado em todos os menus, persistência após nova abertura para todos os controles e uso manual do executável final ainda merecem uma passagem de aceitação. Testes de núcleo cobrem vários desses comportamentos.
- A instância isolada de teste foi encerrada. A instalação do usuário e os vaults pessoais não foram alterados nesta rodada.

## Pacote portátil

- Pré-lançamento: <https://github.com/hodeliun/Morrow/releases/tag/v1.2.0-polaris.3>.
- Executável local: `C:\Users\clove\Projetos\Morrow Public Fork\release\Morrow-Polaris-1.2.0-polaris.3-portable-x64.exe`.
- SHA-256: `fa55aedafd2a284918a75c33259dba79c2bb52aa31041911d0cbd7512c37d4bd` (também em `SHA256SUMS.txt` na release).
- Este executável foi gerado e publicado; **não foi instalado nem testado manualmente como distribuição final**. A release aponta para `c16aa05`. Não afirmar que o aplicativo instalado está atualizado.

## Próximos passos sugeridos

1. Abrir #19 e as issues dependentes; concluir a aceitação visual faltante em um perfil isolado com dados sintéticos, começando pela sequência automática e por duas visualizações vinculadas.
2. Registrar em cada issue a evidência e qualquer falha encontrada. Corrigir falhas reais em `polaris`, rodar `npm run check` e CI. Se mudar o código após `c16aa05`, gerar uma nova versão portátil; não alterar a release já publicada como se o hash ainda fosse o mesmo.
3. Fechar cada issue somente após cumprir seus critérios; então atualizar #19 e #7. Verificar `git status` limpo antes e depois.
4. Para qualquer interação visível, respeitar a preferência do usuário: usar apenas a segunda tela. Preferir perfil oculto/isolado e nunca abrir ou reiniciar o aplicativo pessoal sem necessidade.

## Restrições de dados

O cofre pessoal ativo está em `G:\Meu Drive\Polaris\Central Polaris` e deve permanecer preservado. Não copiar ou anexar notas, perfis, imagens, tokens ou capturas pessoais ao repositório público. Os arquivos do perfil de QA acima são descartáveis e sintéticos.
