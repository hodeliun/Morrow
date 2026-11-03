# Execução autorizada — Aumento de Escopo 2

## Diretriz vigente — entregas sequenciais, 03/11/2026

O mantenedor determinou uma única entrega funcional ativa por vez, preferindo
uma issue ou o menor grupo inseparável. Validar, publicar, confirmar CI e encerrar
as issues dessa entrega antes de iniciar a seguinte. Os grupos históricos abaixo
não autorizam frentes simultâneas. Preservar o restante do WIP em pausa e reutilizar
evidências válidas; aceite local não equivale a entrega publicada.

O mantenedor autorizou continuidade automática entre essas entregas: não aguardar
nova mensagem após cada ticket. Interromper somente por bloqueio indispensável que
dependa dele ou pelo limite de quota semanal restante de 15%, com pausa segura.

A única entrega ativa é T21 (#72), desfazer e refazer dados com histórico limitado por banco durante a sessão.
O formato persistido 13 e seus contratos estritos
já foram publicados no T03. Cada
entrega inclui seus pré-requisitos de preservação e validação, em um commit
coerente, sem nova release ou instalação. Os outros tickets permanecem
preservados até sua vez.

Entregas integradas na main, com CI Windows/Linux e issues encerradas:

| Ticket | Capacidade | PR |
| --- | --- | --- |
| T20 #71 | Composição em colunas | #93 |
| T18 #69 | Tamanho individual de imagens | #94 |
| T33 #85 | Imagens existentes em abas próprias | #95 |
| T35 #87 | Áudio e vídeo locais | #96 |
| T12 #63 | Rodapé compacto das tabelas | #97 |
| T07 #58 | Painéis e seletores legíveis | #98 |
| T03 #54 | Nome e propriedade de exibição; fundação do formato 13 | #99 |
| T04 #55 | Ordem de colunas por visualização, incluindo Nome | #100 |
| T05 #56 | Seleção aditiva e menu compacto de ações de linha | #101 |
| T13 #64 | Títulos próprios e origem nas opções das visualizações | #102 |

A dependência histórica T11 (#62), já entregue na integração pública 1.3,
teve o encerramento reconciliado com seu relatório original em 03/11/2026.
Ela não acrescenta uma entrega à contagem das 24 retomadas.

Em 28/10/2026 o mantenedor autorizou explicitamente implementar todos os 39
tickets, incluindo o adendo de arquivos/web/painéis, com GPT 6 Luna max executor
e GPT 6.1 Sol medium revisor. Esta autorização posterior supera os avisos de
planejamento somente nos snapshots, handoffs e corpos históricos das issues.

Baseline de início: 3961657c3d4a27ce3697b7b1c3d0b513202f94bc.
Branch local: implementation/scope-2. Tracker: especificações #51/#82,
tickets #52–#81 e #83–#91. Não duplicar tickets nem reiniciar planejamento.

## Registro histórico da pausa após a integração oficial 1.3

Esta rodada preserva somente T01, T02, T06, T08, T09, T10, T11, T14, T15,
T16, T17, T19, T31, T32 e T37, aceitos antes da integração. A validação
integrada está registrada no [relatório da integração](../../integration/1.3.0-fork-1.2.0.md).
Os outros 24 tickets ficaram pausados nessa integração e exigiam nova orientação
do mantenedor. A retomada posterior está autorizada pela diretriz sequencial acima;
este registro histórico não a suspende. A retomada não autoriza release, instalação
ou uso de dados e aplicativos pessoais.

## Regras de entrega

- Somente fronteira de dependências concluídas; sem atribuições concorrentes nos
  mesmos módulos. Executor comunica necessidade de compartilhar um arquivo.
- D1–D14 são grupos de publicação, ajustáveis a entregas úteis e verificáveis.
  Nenhum push WIP, nenhuma correção de erro da própria implementação em commit
  remoto separado. Checkpoints locais podem ser consolidados antes de publicar.
- Revisão Sol e testes pertinentes precedem aceitação. Não fechar issues por
  presença de código; evidências reais, pacote isolado quando necessário.
- Preservar originais e arquivos não rastreados existentes. Não abrir/reiniciar
  instalação do usuário; testes em perfil e vault sintéticos, janelas ocultas.
- Build/testes autorizados para comprovar a implementação. Instalação pessoal e
  publicação de release não são parte deste pedido.

## Acompanhamento

### Encaminhamento de dúvidas

Diretriz explícita do mantenedor: **executor → revisor Sol → coordenador
principal → usuário, somente quando indispensável**. Dúvidas técnicas, testes,
interpretação da especificação, ownership e uso de ferramentas são encaminhados
ao revisor com evidências e recomendação; não geram perguntas diretas ao usuário.
O Sol decide dentro da autorização e registra a decisão técnica. Questões de
intenção, dados realmente inacessíveis ou permissões humanas ausentes chegam ao
usuário pelo principal, com justificativa. Não simular respostas nem substituir
autorizações humanas por aprovação do revisor. Perguntas já abertas devem ser
encaminhadas ao Sol; trabalho independente continua dentro da missão atribuída.

GitHub é autoridade para estado e dependências. Sessões executor/revisor são
registradas na continuidade local; despacho não equivale a conclusão. A aceitação
original #81 cobre os trinta tickets iniciais; #91 depende dela e do adendo.
