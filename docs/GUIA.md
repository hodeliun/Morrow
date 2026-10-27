# Guia do Morrow Polaris

Este guia acompanha o cofre sintético `demo/vault/`. Os nomes, valores e artes
foram criados para demonstração; não representam registros pessoais. Abra esse
cofre em uma pasta separada da instalação original do Morrow.

## RPG: Asha

1. Abra **Asha — demonstração**. A página reúne retrato, características e
   navegação em colunas editáveis. O cabeçalho arredondado e a capa podem ser
   alterados sem modificar o arquivo de arte.
2. Abra **Místico** e **Artefatos**, as páginas filhas de Asha.
3. Compare **Todos os artefatos** em **Artefatos de demonstração** com a
   visualização **Artefatos ativos** dentro da página de Asha. Elas mostram as
   mesmas linhas com filtros independentes.
4. Abra **Recursos de demonstração** e selecione o **Anel de Vidro**. O custo calculado deve
   acompanhar o valor da coluna Base quando ela mudar.

## Entretenimento

Em **Entretenimento de demonstração**, experimente as visualizações de tabela, quadro e galeria.
As três linhas cobrem os estados Planejado, Em andamento e Concluído; progresso,
nota, categoria e datas ajudam a comparar os registros. Crie uma linha para
observar os valores padrão. Um valor vazio de nota permanece diferente de zero.

## Finanças

1. Abra **Painel financeiro**. Os controles iniciam em dezembro de 2026; o total
   mensal é **R$ 100,00** e o total pendente é **R$ 60,00**.
2. Mude os controles para janeiro de 2027. A visualização deve mostrar uma linha
   e o total mensal **R$ 25,00**. As datas das transações não mudam.
3. Em **Planejador de parcelas**, a linha **Compra demonstrativa** tem uma ação para criar
   três parcelas de R$ 100,00 a partir de dezembro de 2026. Confira a prévia e
   execute uma vez. Os valores devem somar R$ 100,00, distribuídos como
   R$ 33,34, R$ 33,33 e R$ 33,33.
4. Reabra o cofre para confirmar que relações, controles, visualizações e linhas
   continuam presentes.

## Exportar para Markdown

Use **Exportar como Markdown** para gerar um pacote legível fora do aplicativo.
Cada página inclui seus metadados e conteúdo; bancos incluem uma tabela estática
com os valores atuais. Fórmulas, controles e visualizações mantêm seus marcadores
e recebem um retrato textual dos valores. Um editor Markdown comum exibe esse
retrato, mas não recalcula fórmulas nem atualiza visualizações.

## Renomear uma tabela inserida na página

Clique no título da tabela para editá-lo sem sair da página. Pressione **Enter**
ou clique fora para salvar; **Esc** descarta a alteração. O ícone de expandir à
direita continua abrindo a tabela como página inteira.

## Copiar e colar um banco de dados

Use o ícone de copiar no cabeçalho da tabela inserida na página ou **Copiar banco
de dados** no menu da página do banco. Posicione o cursor numa página editável e
pressione **Ctrl+V**. Escolha:

- **Duplicar sem registros:** novo banco com colunas e visualizações, vazio.
- **Duplicar com registros:** novo banco com suas próprias linhas e valores.
- **Visualização do original:** mesmas linhas, com filtros e layout próprios nesta página.

O comando de cópia funciona dentro do mesmo cofre aberto. Relações entre linhas
copiadas passam a apontar para as cópias correspondentes; referências externas
continuam apontando para seus alvos existentes.

## Limites conhecidos

- O catálogo de ícones usa Lucide, com licença ISC, e aceita ícones próprios.
  O conjunto exato do Notion não foi incluído porque não confirmamos uma licença
  de redistribuição.
- As visualizações exportadas são retratos do momento da exportação.
- Os exemplos não conectam contas, bancos ou serviços externos.
- A arte do cofre é local e sintética; não é uma coleção de imagens de terceiros.
