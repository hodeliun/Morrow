# Plano de mídia e validação — Morrow fork 1.1.1

**Registro histórico de planejamento, anterior à execução.** Nesse momento,
o issue #49 estava bloqueado por #46, #47 e #48, e nenhuma captura, build,
validação de UI ou pacote havia sido produzido nesta etapa. Os exemplos abaixo
preservam os cenários e nomes planejados, não o estado atual da release.

O material final revisado está descrito em [NOTES.md](NOTES.md),
[PROVENANCE-DATA.md](PROVENANCE-DATA.md) e
[PROVENANCE-EDITOR.md](PROVENANCE-EDITOR.md): dois GIFs de dados e um de editor,
com quatro PNGs complementares. Os nomes reais em `assets/` substituem os nomes
reservados abaixo. A aprovação dessas mídias não substitui os gates de auditoria,
CI, empacotamento e publicação.

## Capturas propostas

Gravar a interface real da versão final em perfil isolado com dados sintéticos.
Os GIFs devem mostrar ações completas, resultado e, quando relevante,
persistência após reabrir. Capturar só depois dos gates e do smoke test dos
artefatos, usando a mesma versão e commit revisados. Não usar mockups, animação
gerada, dados pessoais ou imagens de vaults reais.

| Arquivo planejado | Demonstração | Duração alvo |
|---|---|---:|
| `assets/01-relacao-inversa.gif` | Em um banco sintético, criar relação inversa, mostrar os dois lados e confirmar que valores existentes permanecem após salvar e reabrir. | 12–18 s |
| `assets/02-linhas-e-desfazer.gif` | Inserir antes/depois de uma linha, desfazer uma inserção, inserir de novo e demonstrar seleção pelo grip, menu contextual e recuperação após reabrir. | 15–20 s |
| `assets/03-icone-e-camadas.gif` | Abrir o seletor de ícones pelo painel da coluna, enviar uma imagem sintética alta, mostrar o diálogo acessível acima do painel e o ícone ajustado no cabeçalho; fechar com Escape e mostrar o foco restaurado. | 12–18 s |
| `assets/04-views-e-rodape.gif` | Mostrar barra compacta e indicador de filtro ativo; comparar tabela inline e vinculada do mesmo banco, alterar largura/rolagem e mostrar nome e cálculos alinhados. | 15–20 s |

Capturas estáticas complementares, com legenda e texto alternativo:

- `assets/01-relacao-inversa-persistida.png` — os dois lados da relação depois
  da reabertura.
- `assets/02-linha-apos-undo.png` — valores e contagem corretos depois da
  sequência inserir/desfazer/inserir.
- `assets/03-icone-ajustado.png` — o mesmo ícone sintético no diálogo, painel e
  cabeçalho, sem cobrir controles.
- `assets/04-inline-e-vinculada.png` — comparação no mesmo viewport e com a
  mesma configuração, incluindo rodapé e indicador de filtro.

Os nomes são reserva de planejamento; os arquivos ainda não existem. Depois do
upload, substituir referências por URLs da release/tag imutável
`v1.2.1-fork.1.1.1`, não por links temporários ou arquivos de uma execução
anterior. Cada imagem precisa de legenda, texto alternativo e explicação textual
equivalente nas notas.

## Preparação do gate #49

1. Aguardar a conclusão e revisão dos issues #46–#48; manter #49 bloqueada até
   lá. Fixar o commit candidato e a versão efetiva antes de coletar evidências.
2. Executar a checagem do repositório e CI no candidato; repetir os cenários
   reais dos três grupos de correção em Electron com vault e perfil sintéticos,
   escondidos e isolados. Após cada ação importante, conferir persistência,
   reabertura, foco, erros do renderer e conteúdo.
3. Fazer uma nova auditoria dos vinte critérios originais no build final. Marcar
   cada critério como passou, parcial ou falhou com reprodução e evidência; não
   transformar rótulos da UI ou status de tickets em prova de comportamento.
4. Construir os pacotes Windows x64 previstos e inspecionar o payload NSIS sem
   executar o instalador. Não iniciar wizard nem modo silencioso: isso pode
   alterar o registro e a instalação pessoal. **Não lançar ainda o executável
   `win-unpacked` nem o portátil.** No código atual, builds empacotados ignoram
   `MORROW_USER_DATA` e `MORROW_HIDDEN`; o tratamento de segunda instância pode
   focar a janela da instalação do usuário. Não tentar contornar isso com
   `APPDATA` ou argumentos não documentados.

   Antes de qualquer smoke test empacotado, o gate #49 precisa de uma seam
   explícita, revisada e comprovada para apontar o perfil a um diretório isolado
   e manter a execução oculta sem focar uma instalação existente. Só então
   conferir o caminho de dados antes de abrir o vault sintético, e validar
   **Sobre**, versão da base/fork e os fluxos cobertos pelas capturas. Para o
   portátil, `PORTABLE_EXECUTABLE_DIR` sozinho não prova isolamento: confirmar
   também a localização efetiva dos dados. Se a seam segura não estiver pronta,
   não executar os pacotes e manter a publicação bloqueada.
5. Gravar os GIFs e screenshots depois do smoke test, na mesma versão candidata.
   Usar `ffmpeg` para recortar e reduzir taxa/resolução mantendo texto legível;
   guardar as gravações-fonte em `docs/evidence/stabilization-1.1.1/<commit>-<run-id>/`
   e anotar versão, commit, cenário, dimensões e ferramentas de conversão.
   Revisar os arquivos finais visualmente antes do upload.
6. Só depois de verificar nomes, SHA-256, assinatura quando aplicável, URLs,
   tag alvo e estado publicado, substituir os placeholders em `NOTES.md`.

## Estrutura de evidências sem sobrescrever o histórico

O material `original-scope-*` de 28/10 é baseline histórico: alguns scripts e
relatórios registram `partial` deliberadamente, e certos caminhos de saída são
fixos. Não reexecutar esses scripts com destino antigo nem editar os resultados
para fazê-los parecer aprovação da 1.1.1.

Para a validação futura, criar um novo harness de estabilização que reutilize
fixtures e funções de `verify-original-scope-2026-10.cjs`,
`verify-original-page-scope-2026-10.cjs`,
`verify-original-inline-visual-2026-10.cjs`, `verify-prior-deliveries-ui.cjs`,
`verify-delivery4-ui.cjs`, `verify-delivery5-ui.cjs` e
`verify-interaction-final-ui.cjs`, mas grave relatório e capturas em um destino
novo, por exemplo
`docs/evidence/stabilization-1.1.1/<commit>-<run-id>/`. Os scripts antigos são
referência, não a evidência do novo candidato. Não alterar scripts nesta etapa
preparatória.

Na UI compacta resultante do issue #48, localizar opções pelo controle
acessível **Opções**/`menuOptions` e pelos indicadores ativos. Evitar seletores
que presumem os seis botões antigos da barra ou textos/posições fixos. Cobrir
teclado, mouse e viewport; preferir roles/nomes acessíveis ou seletores estáveis
que o gate #48 mantenha intencionalmente.

Para cada execução, guardar o hash do commit, versão mostrada em **Sobre**,
configuração de locale/viewport, nome e hash dos fixtures sintéticos, resultados
por critério e páginas capturadas. Preservar falhas e reruns como arquivos
separados e relacioná-los no relatório final; não substituir o baseline nem
misturar capturas de builds diferentes.
