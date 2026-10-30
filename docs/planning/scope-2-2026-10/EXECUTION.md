# Execução autorizada — Aumento de Escopo 2

Em 28/10/2026 o mantenedor autorizou explicitamente implementar todos os 39
tickets, incluindo o adendo de arquivos/web/painéis, com GPT 6 Luna max executor
e GPT 6.1 Sol medium revisor. Esta autorização posterior supera os avisos de
planejamento somente nos snapshots, handoffs e corpos históricos das issues.

Baseline de início: 3961657c3d4a27ce3697b7b1c3d0b513202f94bc.
Branch local: implementation/scope-2. Tracker: especificações #51/#82,
tickets #52–#81 e #83–#91. Não duplicar tickets nem reiniciar planejamento.

## Limite vigente após a integração oficial 1.3

Esta rodada preserva somente T01, T02, T06, T08, T09, T10, T11, T14, T15,
T16, T17, T19, T31, T32 e T37, aceitos antes da integração. A validação
integrada está registrada no [relatório da integração](../../integration/1.3.0-fork-1.2.0.md).
Os outros 24 tickets estão pausados e não devem ser despachados nem implementados
por inferência da autorização histórica abaixo. Uma nova orientação do mantenedor
é necessária para retomar essa fronteira. Esta atualização não autoriza release,
instalação ou uso de dados e aplicativos pessoais.

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
