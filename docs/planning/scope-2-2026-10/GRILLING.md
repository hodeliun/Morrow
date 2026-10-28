# Grilling interno — Aumento de Escopo 2

28/10/2026. Análise interna de planejamento, não entrevista ou respostas atribuídas ao usuário. Implementação não autorizada.

## 1. Qual versão falhou?

A gravação não identifica a tela Sobre. O baseline de planejamento é 1.2.1-fork.1.1.1 no commit registrado. Cada correção deverá reproduzir o cenário na versão exata testada; falha observada não prova causa nem reabre issues antigas automaticamente.

## 2. Criar novos motores?

Não. Controles, resultados inline, bindings por ID, interpretador e ordem por view já existem. Completar contratos e UX nesses módulos reduz incompatibilidades e evita substituir lógica que funciona.

## 3. Nome pode ser excluído como qualquer propriedade?

Nome representa o título obrigatório da linha. Editar seus valores e alias de cabeçalho, restaurá-lo como display e indicar a escolha por olho; excluir propriedades comuns pelo contexto. Remoção do título obrigatório fica indisponível com explicação. Esta restrição é decisão de integridade, não fala atribuída ao usuário.

## 4. Erro de clipboard é necessariamente permissão?

É mensagem observada, não diagnóstico fechado. Planejar adaptador desktop restrito, clipboard externo real e proteção contra cache obsoleto; não afrouxar segurança do navegador para fazer teste passar.

## 5. Enter salva ou apenas abre edição?

Escolha de planejamento: digitação inicia edição, Enter confirma valor válido e avança uma linha, Shift+Enter insere quebra no texto, Escape cancela e blur confirma valor válido. Preservar IME. Ajustável apenas com evidência posterior, sem inventar resposta do usuário.

## 6. Arrastar coluna altera todo o banco?

Não: coluna de propriedade usa ordem existente da view; layout de documento usa pesos relativos separados. Arrastar célula seleciona células; somente handle move o bloco.

## 7. Histórico deve ser por view ou por banco?

Dados: dez ações por banco de origem, compartilhadas entre views. Configuração: dez por view. Ação contextual mais recente informa o proprietário; desfazer de draft fica no editor. Isso evita duas views desfazerem versões incompatíveis dos mesmos dados.

## 8. Histórico sobrevive ao reinício?

Ampliação inicial é limitada à sessão. Preservar journal persistido de recuperação existente, inclusive conflitos e limite de tamanho. Não prometer dez ações após reiniciar. Teto global inicial de 32 MiB é suposição de planejamento a validar, com descarte só de entradas concluídas antigas.

## 9. Como resolver conflitos externos e redo?

Validar estado esperado antes de aplicar inversa; conflito produz diagnóstico/recuperação, não sobrescrita. Nova edição invalida redo do escopo afetado, não de todos os bancos sem motivo.

## 10. Qual regra condicional vence?

Última regra correspondente por atributo (fundo, texto, negrito, itálico). Expressão deve resultar em booleano ou diagnóstico. Preservar regras legadas de fundo e preselecionar contexto correto da coluna.

## 11. Abrir configuração depois de criar?

Adotar sugestão como padrão na criação manual. Não interromper importação/duplicação. Cancelar fecha configuração e não apaga a coluna que acabou de ser criada.

## 12. Como remover coluna de layout com conteúdo?

Mostrar confirmação e prévia; retirada do contêiner conserva filhos no fluxo normal após o grupo. Apagar conteúdo é ação destrutiva distinta. Escape, undo e round-trip devem conservar IDs e blocos embutidos.

## 13. Canvas significa arquivo JSON Canvas?

Não: aqui é área de escrita do documento. Não aplicar recursos do editor de notas ao módulo de diagramas por confusão de nomes.

## 14. Todos os controles do Coda?

Escopo finito: texto, número, slider, select, checkbox, data, relation, seleção múltipla, escala, progresso e intervalo de datas. Os sete primeiros já existem. Sem Packs, colaboração personalizada, automações ou promessa de paridade integral.

## 15. Como representar intervalo de datas?

Par ordenado de datas ISO sem hora ou vazio, compatível com lista tipada atual. Presets inclusivos e finitos: hoje, últimos sete dias, mês atual, próximos sete dias e personalizado. Selecionar materializa datas; abrir não recalcula nem grava. Não confundir lista com relation.

## 16. Nomes ou IDs nas fórmulas?

Nome serve à descoberta; vínculo usa IDs estáveis com escopo de página e seleção explícita entre páginas. Duplicatas exigem desambiguação; excluir não deve religar por aproximação. Reutilizar diagnósticos de ciclos e limites de avaliação.

## 17. Cor das fórmulas deve copiar semântica do Coda?

Referência oficial usa cores por origem/local. O pedido deste escopo escolhe classes de referência (propriedade, tabela/relation, controle, resultado, função), com informação não dependente só de cor. Registrar a diferença, sem atribuir equivalência falsa ao Coda.

## 18. Padrão global pode mudar todas as notas?

Não nesta entrega: fundo de resultados é padrão para novas notas, registrado na criação, com override por nota. Legado ausente resolve apresentação atual sem escrita ao abrir. Largura total de bancos segue a mesma proteção a preferências existentes.

## 19. Como evitar perda de dados sem causa conhecida?

Ticket de integridade exige distinguir bloco oculto/movido/excluído, inspecionar IDs e disco, reproduzir com conteúdo sintético e verificar undo/reabertura. Não encerrar só porque outro ambiente não reproduziu.

## 20. O que prova conclusão?

Cenários demonstráveis em pacote desktop identificado, persistência/reabertura e regressões no maior limite público disponível, não presença de um botão. Matriz cobre trinta fontes e seus subcritérios. Aceitação integrada bloqueada por todos os tickets.

## 21. Como publicar sem expor material pessoal?

Descrição sanitizada e fixtures sintéticas no GitHub. Vídeo, capturas, transcrição e caminhos pessoais ficam no vault. Planejamento não autoriza implementar, instalar, publicar release nem despachar executores.

## 22. Trinta tickets significam trinta commits?

Não. Nove grupos de entrega propostos, ajustáveis por risco e resultado final; checkpoints locais são consolidados antes do primeiro push. Documentação desta rodada é um único commit. Não reescrever histórico já publicado.

Riscos residuais: diagnóstico dos defeitos exige a reprodução futura; esquema final precisa obedecer compatibilidade e limites atuais. Nenhum teste novo do produto foi executado nesta etapa.
