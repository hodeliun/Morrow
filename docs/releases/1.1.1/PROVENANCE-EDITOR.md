# Proveniência das capturas do editor — Morrow fork 1.1.1

## Build e isolamento

- Versão do candidato: 1.2.1-fork.1.1.1.
- Commit candidato: e9a8d29cabd1356645eb871f62304c249526034f.
- Base Morrow: 1.2.1; commit 5e6392bb6425924abd30eec8a99b42aa8c953577.
- Hash do conjunto de fontes validado pelo gate: c3aa1d4ae55438b084a24cdb4a63bb641a2126c872ea30b84047b120402d0257 (258 arquivos).
- Fingerprint dos artefatos Electron: 0db322d906a61e149a0e5c59aac33f4ee7e4b02c40a4afe1e8a062010066b93b; reabertura: 0db322d906a61e149a0e5c59aac33f4ee7e4b02c40a4afe1e8a062010066b93b.
- Reexecução real em Electron oculto, com vault e perfil sintéticos isolados. O relatório da captura marcou todas as janelas como ocultas e registrou 0 pageerror.
- Os arquivos de origem das capturas e os perfis sintéticos foram removidos da pasta temporária após gerar os materiais finais.

## Roteiro reproduzível

1. Abrir a tabela sintética e as configurações da propriedade.
2. Abrir o seletor de ícones sobre as configurações e conferir o foco após fechá-lo.
3. Enviar o retrato raster sintético portrait-200x400.png por um input de arquivo interceptado pelo Playwright.
4. Conferir o retrato de 200 × 400 pixels como glifo de 14 × 14 no cabeçalho e no espaço de 32 × 32 das configurações.
5. Alterar o tipo da propriedade, reabrir o aplicativo e confirmar o ícone da propriedade e o ícone original da página.

O GIF usa estados reais capturados durante a sequência e na reabertura; não é uma animação de interface simulada.

## Arquivos, legendas e texto alternativo

- editor-icon-picker-layering.gif — GIF, 1000 × 858 px, 16 s, 318364 bytes, SHA-256 0a697b01be041f395153ea50de66bce83144e69371ec657dc83adc0f80b0f3f6. Legenda: “O seletor abre acima das configurações; após o envio, o retrato alto aparece ajustado no cabeçalho e continua salvo ao reabrir.” Texto alternativo: “Sequência da interface do Morrow mostrando o seletor de ícones sobre as configurações, o retrato sintético no cabeçalho e o ícone persistido após reabrir.”
- editor-icon-picker-layering.png — PNG, 208683 bytes, SHA-256 8b65457238d91769460755fda819f92cbab14e888b61ec8d9972db20908d5bdb. Legenda: “Seletor de ícones sobre as configurações da propriedade.” Texto alternativo: “Seletor de ícones aberto acima do painel da coluna na tabela sintética.”
- editor-icon-column-result.png — PNG, 62273 bytes, SHA-256 973c873a61cc3c7f80b1cb04a5e86d75a7c3382aa8608f6c75761a3ba73432bb. Legenda: “Retrato de 200 × 400 ajustado no cabeçalho da propriedade.” Texto alternativo: “Cabeçalho da coluna Value type test exibindo o retrato sintético em tamanho de glifo.”

As telas, propriedades e arquivos enviados são sintéticos; nenhuma vault pessoal foi usada.
