# Revisão crítica interna — expansão de interação

Decisões de planejamento, não entrevista ou respostas atribuídas ao usuário.

- Não reabrir #8–#20 como se nada tivesse sido entregue: verificar regressões de UI e completar os contratos existentes.
- “Mesmas operações do Coda” precisa de inventário fechado: expandir, inserir antes/depois, selecionar, copiar, duplicar, mover/reordenar e lixeira. Não prometer todos os recursos futuros do Coda.
- Risco maior: ações em lote alterarem dados ocultos/derivados. Seleção segue IDs/ordem visível, valida antes de aplicar e tem undo único; linhas selecionadas e intervalo são conceitos diferentes.
- Separar navegação, clipboard e preenchimento em entregas completas sucessivas. Não construir primeiro um esquema sem UI como ticket isolado.
- Colagem de linhas requer mapeamento; ordem de colunas não é identidade. Relações e conteúdo são preservados ou a ação é recusada com prévia.
- A aparência não deve exigir novo storage: paleta, formato calculado, inversas e tokens reutilizam os módulos existentes.
- Recolhimento/ocultar título são locais à apresentação, enquanto ícone da propriedade pertence ao esquema. Não propagar nomes de view à origem.
- Critério de formatação por fórmula é puro/booleano; não usar eval ou mutação.
- Linking de inversas preenchidas precisa reconciliar pares e cardinalidade antes de escolher proprietário. Não limpar o lado que vira projeção sem conservar seus pares.
- Imagem recortada conserva o original; títulos recolhidos não excluem conteúdo de exportação.
- Dependências foram reduzidas a gates funcionais: overlay antes de novos popovers, navegação antes de seleção/lotes, seleção antes de fill/clipboard de linhas. Demais slices podem ser planejadas independentemente.
- Apenas documentação e tickets nesta rodada. ready-for-agent indica clareza e dependências, não autorização para iniciar implementação.
