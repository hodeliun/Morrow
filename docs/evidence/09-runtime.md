# Revisão principal — aparência e edição

Sol 6.1 medium revisou e integrou a entrega Luna max. Check conjunto com relações, ícones e OKF: 211 testes, typecheck, lint e builds aprovados.

No Electron invisível e em perfil/vault sintéticos, foram exercitados os controles reais da interface:

- Capa: cancelar a posição deixou o arquivo intacto; salvar posição 100 persistiu e reabriu com recorte em 50% 100%.
- Nota: fonte 18 px, espaçamento 20 px e largura ampla salvos e mantidos após reabrir.
- Três colunas editáveis; seleção de texto na coluna central e aplicação de fundo azul pelo menu. O bloco mediu a mesma largura da coluna (279,33 px), com raio 8 px; a cor persistiu como comentário Markdown e reabriu corretamente.
- Padrão global: mudar o espaçamento para 40 não alterou notas existentes; uma nova página criada pela interface capturou esse padrão.
- Lote: prévia e aplicação em modo preservar mantiveram o estilo próprio; desfazer restaurou o destino. Modo substituir alterou a nota com estilo próprio; desfazer restaurou os dois arquivos exatamente ao conteúdo anterior.

Todas as janelas de teste permaneceram invisíveis. Evidências fora do Git: `local QA folder (excluded from Git)/style-result.png`, `style-result.json`, `style-batch-result.png` e `style-batch-result.json`. Fontes pessoais preservadas.
