# Proveniência da mídia de dados — Morrow fork 1.1.1

Demonstrações capturadas no aplicativo Electron compilado, usando somente um perfil e um cofre sintéticos. Os GIFs são sequências de estados reais da interface, mantidos por intervalos documentados; não representam gravação contínua.

## Build e captura

- Versão no pacote: `1.2.1-fork.1.1.1`
- Versão lida por `app.getVersion()`: `1.2.1-fork.1.1.1`
- Commit fonte: `e9a8d29cabd1356645eb871f62304c249526034f` (worktree compartilhado continha outras alterações em andamento; esta captura não alterou fonte do produto).
- Script de captura: `scripts/capture-release-data-1.1.1.cjs` — SHA-256 `53d4de7c503f4b485016192781950c211c1ba2ff42e02bb99fdf9a109a28d472`.
- Locale da fixture: português (`pt`); viewport: 1280 × 680; recorte: 1060 × 640px a partir de x=220, y=20.
- Electron: `44.7.0`; ffmpeg: `ffmpeg version 8.1.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers`.
- Janelas Electron visíveis durante a execução: 0; erros de página: 0; perfil e cofre temporários removidos: sim.
- Fingerprint combinado de `dist/` + `dist-electron/` antes: `8f2351d223f389dc447a5f8a3f566422a039c63c9a3d3b6fbb77842386c53590` (3596 arquivos); depois: `8f2351d223f389dc447a5f8a3f566422a039c63c9a3d3b6fbb77842386c53590` (3596 arquivos). Os fingerprints e o hash de `dist-electron/main.cjs` coincidem; o aplicativo não foi recompilado.
- Hash de `dist-electron/main.cjs`: `5e462be3b78a1ac494425f57d11acd94fcf9ed323abd6f7ded8fe81315a7bb50`.

## Demonstrações

### Relação inversa

- GIF: [data-01-relacao-inversa.gif](assets/data-01-relacao-inversa.gif) — 1060 × 640px, 16.26s, 8 fps, 90156 bytes, SHA-256 `9f458ab4900122796fd2806a078d29b854a533a89b63125ad38d1e3ad9a5e5ad`.
- Legenda: Criar uma relação inversa em Livros e conferir os vínculos nos dois bancos, inclusive depois de reabrir o aplicativo.
- Texto alternativo: A interface abre a configuração da coluna Autor, seleciona Autores e cria a coluna inversa Livros. Depois, a tabela Autores mostra os livros ligados a Lia Nogueira e Caio Marfim, e os mesmos vínculos continuam visíveis após reabrir.
- Captura complementar: [data-01-relacao-inversa.png](assets/data-01-relacao-inversa.png) — 35646 bytes, SHA-256 `685f1a95caef3fc8c4f2c52a206caf86a6d44bb7e3bb719103f79e8fdc17cada`.
- Cenário: valores legados de texto em Autor são reconciliados ao criar a relação; Lia fica ligada a dois livros e Caio a um. O ID da coluna inversa é o gerado pela interface e é lido dos arquivos salvos.

### Selecionar, inserir e desfazer linha

- GIF: [data-02-linhas-e-desfazer.gif](assets/data-02-linhas-e-desfazer.gif) — 1060 × 640px, 16.38s, 8 fps, 130232 bytes, SHA-256 `d6ffcd7006bd0b875e016a4898d6ec024d155f4bca5532ae8737bbd9b6b8fb86`.
- Legenda: Selecionar uma linha pela alça de seis pontos, abrir as ações com Shift+F10, inserir antes da linha e desfazer.
- Texto alternativo: A linha A Ilha de Lume é selecionada pela alça de seis pontos. O menu contextual mostra Inserir linha antes; uma linha aparece e o aviso Desfazer a remove, restaurando as três linhas originais.
- Captura complementar: [data-02-linha-apos-desfazer.png](assets/data-02-linha-apos-desfazer.png) — 37461 bytes, SHA-256 `ce1f1819e4816b87886be47b691f18e2771d39a9533606e7070d588adb402d42`.
- Cenário: cliques e teclado normais na interface, sem uso da área de transferência; o journal termina como desfeito.

Os dados fictícios e os nomes são criados apenas para esta captura. Nenhuma captura contém perfil, vault ou registros pessoais.
