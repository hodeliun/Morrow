# Handoff e conclusão da rodada — 27/10/2026

## Onde está o projeto

- Repositório público: <https://github.com/hodeliun/Morrow>.
- Diretório local: `C:\Users\clove\Projetos\Morrow Public Fork`.
- Branch de produto e padrão: `polaris`; `main` preserva a base original.
- Commit funcional validado desta release: `2accb21bf8174b08a1ef6cf37e2d8db208890590` (`2accb21`).
- Upstream: <https://github.com/Aarav2709/Morrow>; este fork conserva licença Apache-2.0 e atribuição.
- Ler `AGENTS.md` do repositório antes de trabalhar. Não publicar histórico do repositório privado nem dados pessoais.

## Produto e planejamento

- Base do produto e arquitetura: `docs/SPEC.md`, `docs/RESEARCH.md`, `docs/GRILLING.md`, `docs/FORMULAS.md`.
- Escopo incremental desta rodada: `docs/SPEC-INTERACTION-2026-10.md` e issue [#7](https://github.com/hodeliun/Morrow/issues/7).
- Tickets: issues [#8–#20](https://github.com/hodeliun/Morrow/issues); espelhos em `docs/tickets/`.
- Todas as issues da rodada (#7, #8–#20) tiveram seus critérios de aceitação verificados, evidências registradas e foram concluídas/fechadas.

## O que está implementado e validado em `polaris`

- Cores personalizadas para texto, realce e fundo de bloco; seletor de cor do ícone mais legível. Fundo hexadecimal claro escolhe texto escuro automaticamente (#8).
- Largura confortável/ampla/total por nota; 2 e 3 colunas de texto redimensionáveis por ponteiro (com listeners em `window`) ou teclado (`ArrowLeft`, `ArrowRight`, `Home`), botão de redefinir proporções (`.columns-reset`), desfazer (`Undo`), colapso em painel estreito e persistência no Markdown (#9).
- Título de tabela inserida editável no lugar (`Enter`/`blur` salvam, `Escape` cancela), botão separado para abrir página inteira; menu contextual acessível por clique direito e teclado (`Shift+F10`) no cabeçalho de coluna com inserir coluna antes/depois (#10).
- Duplicação de coluna com ou sem valores e opção de desfazer (#12); congelamento (`frozenThrough`), ajuste ao conteúdo e altura de linha por visualização com botão de expansão de célula e independência entre visualizações vinculadas (#11).
- Descrição da coluna no cabeçalho (#18), coluna de exibição padrão do banco com fallback ao título e precedência de override explícito na relação, além de atalhos diretos no menu para fórmula e formatação condicional (#20).
- Barra de filtros rápidos locais à visualização, distinta das regras salvas da visualização, com operadores coerentes por tipo, estado vazio, limpeza e isolamento entre duas visualizações vinculadas (#13).
- Formatação numérica com precisão/localidade (`2,00` em `pt-BR` preservando `2` bruto no Markdown), prévia, ajuda acessível e salvar/cancelar em lote com diagnóstico para `min > max` e `step <= 0` (#14); sequência automática configurada e exercitada pela UI com início/incremento, precedência de valor explícito, não reutilização após exclusão e persistência de `sequenceNext` após reabrir (#15).
- Editor de fórmulas com sugestões contextuais, destaque de referências, prévia e `IfError` (#16, #17); projeção tipada `thisRow.Relacao.Coluna` sobrevivendo a fechar/reabrir e à renomeação da coluna alvo (#17, #19).

## Estado verificado

- `npm run check` passou no commit `2accb21`: 46 arquivos de teste, 332 testes, tipos, lint e compilação.
- CI Linux e Windows do commit `2accb21` aprovados: <https://github.com/hodeliun/Morrow/actions/runs/40560710136>.
- Suíte completa de aceitação visual executada em perfil Electron oculto (`MORROW_HIDDEN=1`) e isolado com dados sintéticos em `C:\Users\clove\AppData\Local\Temp\morrow-qa-gemini-20261027` (relatório consolidado em `C:\Users\clove\AppData\Local\Temp\morrow-qa-gemini-report.json`).
- A instância isolada de teste foi encerrada. A instalação do usuário e os vaults pessoais não foram alterados.

## Pacote portátil

- Pré-lançamento: <https://github.com/hodeliun/Morrow/releases/tag/v1.2.0-polaris.4>.
- Executável local: `C:\Users\clove\Projetos\Morrow Public Fork\release\Morrow-Polaris-1.2.0-polaris.4-portable-x64.exe`.
- SHA-256: `57cf7dce864c0e0e169648b1b403254766d79b2ce9105b341c6ad9199a70f116` (também em `SHA256SUMS.txt` na release).
- Este executável aponta para `2accb21`, foi gerado e publicado; não foi instalado nem aberto sobre o perfil real do usuário. Não afirmar que o aplicativo instalado foi atualizado.

## Restrições de dados

O cofre pessoal ativo em `G:\Meu Drive\Polaris\Central Polaris` permaneceu preservado e intocado. Os arquivos do perfil de QA em `Temp` são descartáveis e sintéticos.
