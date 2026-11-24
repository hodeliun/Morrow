# Testar o piloto Polaris Dados no Windows

Este candidato experimental usa Morrow 2.2.0 e inclui o piloto Polaris Dados com edição de números, texto e caixas de seleção, além de uma demonstração visual do plugin Polaris Documento. O pacote Windows é compilado nativamente. Seus checks verificam o ZIP, os hashes e o launcher em PowerShell 5.1 e 7. A abertura da interface no Windows e a paridade integral com o fork seguem pendentes de teste e aceite.

## Requisitos

- Windows x64.
- Microsoft Edge WebView2 Runtime instalado.
- Espaço livre para extrair o ZIP e guardar o estado do teste.

O launcher passa o armazenamento do backend do Morrow para `PilotState\MorrowUserData` e o perfil WebView2 para `PilotState\WebView2UserData`. O build de piloto usa o identificador isolado `app.morrow.polaris-dados-pilot`. Nesse build, o Tauri e a preparação opcional de ortografia usam o mesmo diretório WebView2. A [documentação Microsoft sobre a variável de dados do WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.3967.48) explica como ela substitui o diretório informado à API.

Esses caminhos descrevem a configuração do piloto. Somente uma execução nativa no Windows confirma o comportamento efetivo do WebView2. O Tauri e o plugin de estado da janela ainda podem gravar outros metadados do identificador do piloto no perfil Windows, como em `AppData\Roaming`. Por isso, o pacote não afirma isolamento total do perfil Windows.

## Preparar e abrir

1. Baixe o ZIP do artefato GitHub Actions e extraia-o uma vez para uma pasta temporária. Esse arquivo externo contém outro ZIP com o pacote.
2. Extraia o ZIP interno diretamente para uma pasta nova e curta, por exemplo `Downloads\MorrowPiloto`. O executável, `windows-launch.cmd` e `DemoVault` devem ficar juntos na raiz dessa pasta. Não execute o aplicativo de dentro de nenhum ZIP.
3. Não extraia para dentro de um cofre pessoal nem abra um cofre pessoal neste teste.
4. Salve e feche qualquer outro Morrow aberto. O launcher recusa iniciar se encontrar outro processo `morrow.exe`.
5. Clique duas vezes em `windows-launch.cmd` e aguarde o seletor de cofres ou a tela Welcome.
6. Pela interface do Morrow, abra a pasta `PilotState\DemoVault`, dentro da pasta onde você extraiu o pacote. Essa é a cópia de teste editável. A pasta `DemoVault` no nível superior do pacote é o modelo original; deixe-a intacta.
7. Em Settings/Configurações, habilite plugins locais e o plugin Polaris Dados. Se necessário, recarregue a nota.

O launcher cria `PilotState\DemoVault` na primeira execução. As próximas execuções reutilizam essa cópia para manter as alterações. Se o launcher recusar uma pasta, aparecer um cofre pessoal ou surgir uma tela inesperada, feche o aplicativo e informe o que aconteceu. Não apague nem tente reparar a pasta recusada.

## Demonstração visual Polaris Documento

1. Em Settings/Configurações → Plugins, permita plugins locais e confirme que **Polaris Documento** está habilitado. O modelo `DemoVault` já deixa o plugin habilitado; essa preferência local ainda pode exigir sua confirmação.
2. Na árvore de arquivos lateral de `PilotState\DemoVault`, abra `Links`. Compare os links resolvido, ausente (alvo na lixeira) e não resolvido. O link externo deve manter a aparência normal do Morrow.
3. Abra `Relations` pela mesma árvore lateral e confira a linha `Relation sample`. Ela mostra uma relação nativa para `Resolved target` e outra para `Gone target`, cujo alvo sintético está na lixeira.
4. Em Settings/Configurações → Appearance/Aparência → Theme/Tema, alterne entre os temas claro e escuro e confira novamente `Links` e `Relations`.
5. Com foco no editor, use **Tab** até um chip de relação em `Relations` para conferir o contorno de foco. A navegação e as ações dos links e relações continuam pertencendo ao Morrow.
6. Em Settings/Configurações → Plugins, desabilite **Polaris Documento**. Os estilos do plugin devem sair; os links e as relações continuam disponíveis com a apresentação padrão do Morrow. Habilite-o novamente e confirme que a apresentação do plugin voltou.

### Editar o estilo de uma nota

1. Abra `Links` no modo de edição e clique em **Estilo da página** (**Page style**).
2. Altere a fonte, o tamanho do texto, a entrelinha, o espaçamento ou a largura. Confira a prévia no painel. Role até as ações, se necessário, e pressione **Cancelar**. A página deve manter o estilo inicial.
3. Reabra o painel, escolha **Monoespaçada** e **Larga**, e clique em **Salvar**. Feche e reabra a nota para confirmar que o estilo ficou salvo.
4. Use **Restaurar** para aplicar o estilo padrão do perfil à nota. Abra duas notas em painéis diferentes e confirme que alterar uma delas preserva o estilo da outra.

### Escolher o estilo padrão das notas novas

1. Em **Configurações → Aparência → Padrão para novas páginas**, escolha a fonte, o tamanho, a entrelinha, o espaçamento e a largura.
2. Clique em **Salvar padrão** e crie uma nota nova. Confira o estilo salvo na nota e compare com a aparência anterior de `Links`. Bancos novos usam largura total e o canvas mantém suas opções próprias.
3. Mude outro valor no painel e use **Descartar alterações** para voltar ao último padrão salvo. Feche e reabra o piloto, crie outra nota e confirme que o padrão continuou disponível.
4. Clique em **Restaurar padrão do perfil** para voltar à fonte e à largura gerais na criação de novas notas. Se criar uma nota a partir de um template com estilo próprio, confira que a nota herdou esse estilo.

### Ver a prévia de estilo nas notas existentes

Em **Configurações → Aparência**, salve um padrão e abra **Prévia das páginas existentes**. Escolha **Preservar estilos existentes** ou **Sobrescrever estilos representáveis** e clique em **Pré-visualizar páginas**. Confira a contagem e a amostra de até quatro títulos. Abra uma nota após a prévia para conferir o estilo anterior. Alterar o modo ou salvar outro padrão pede uma nova prévia.

### Aplicar o estilo nas páginas de demonstração

Use o cofre `PilotState\DemoVault`. Em **Configurações → Aparência**, salve um padrão, escolha o modo da prévia e clique em **Pré-visualizar páginas**. Abra **Aplicar às páginas existentes** e confira a contagem da confirmação. Clique em **Cancelar** para voltar à prévia. Abra a confirmação novamente e escolha **Aplicar estilos**.

O resultado traz as contagens de **Confirmadas**, **Recusadas** e **Não tentadas**, com detalhes por página. Em caso de recusa, gere outra prévia. Abra uma das notas confirmadas e confira o estilo e os demais campos YAML.

### Cores HEX e estilos salvos

1. Com **Polaris Documento** ativo, selecione algumas palavras no editor e abra a paleta **Cor**. Aplique `#225588` à linha de texto e `#eedc93` à linha de realce. Reabra a paleta para restaurar a cor padrão e use **Ctrl+Z** para recuperá-la.
2. Salve e reabra a nota. Alterne entre os temas claro e escuro. Desabilite o Documento e confira que os campos HEX saem da paleta e as cores aplicadas permanecem no texto.
3. Para conferir um estilo salvo por nota, crie `Exemplo de estilo.md` em `PilotState\DemoVault` com o conteúdo abaixo. Habilite o Documento e abra a nota nos modos de edição e leitura.

```markdown
---
morrowNoteStyle:
  font: serif
  fontSize: 20
  lineHeight: 1.8
  blockSpacing: 12
  width: wide
---

# Exemplo de estilo

Primeiro parágrafo.

Segundo parágrafo.
```

O build verifica os hashes do bundle, manifesto, README e licença de ambos os plugins dentro do ZIP extraído, além da lista SHA-256 completa do pacote. Essa verificação não abre a GUI do Windows nem equivale ao aceite visual nessa plataforma.

### Fundo de bloco de uma nota do fork antigo

Abra `Links` e confira o fundo do parágrafo **Legacy HEX background**. O parágrafo **Plain neighbor** mantém o fundo normal. Desative o Polaris Documento e alterne entre os temas claro e escuro. Edite o parágrafo vizinho, salve e reabra a nota. A cor legada deve permanecer.

### Fundos de listas e tarefas antigas

Em `Links`, **List item with native background** usa o amarelo nativo do item. O azul HEX aparece em **Legacy list paragraph**, **Legacy task paragraph** e **Old nested list paragraph**. **Legacy numbered paragraph** fica roxo. Edite **Plain neighbor**, salve e reabra a mesma nota para conferir os fundos e a tarefa marcada.

### Escolher um fundo HEX de bloco

Em `Links`, passe o cursor pela margem de um parágrafo ou do título **Legacy collapsible title** e abra o menu do bloco. Entre em **Cor** e digite `#336699` no campo HEX do fundo. Use **Fundo padrão** no mesmo menu para limpar a cor. Use **Ctrl+Z** para recuperar o fundo. Reabra a nota para conferir a cor salva. Ao desativar o Polaris Documento, o campo HEX desaparece e as cores salvas permanecem.

### Título colorido de um recolhimento antigo

Em `Links`, localize **Legacy collapsible title**. Use a seta para recolher e expandir o texto abaixo. Edite o título, desfaça e refaça a alteração. Feche e reabra a nota para conferir o fundo azul e o negrito.

### Cálculo de fórmula antiga no texto

1. Abra `Resolved target` com o Polaris Dados ativado. A fórmula `2 + 3` exibe **Legacy total 5** no parágrafo.
2. Desative o Polaris Dados. O texto salvo **Legacy total** volta no mesmo lugar. Edite **Editable neighbor**, salve e reabra. O texto salvo permanece.
3. Reative o plugin para recuperar **Legacy total 5**. A cópia de `Resolved target.md` em `PilotState\DemoVault` mantém o marcador original. O valor calculado fica na interface.

### Criar uma fórmula dentro da nota

1. Em `Resolved target`, comece um parágrafo, digite `/formula` e escolha **Fórmula inline**.
2. Escreva `6 * 7`, dê o nome **Total novo** e confirme em **Salvar**. O parágrafo deve mostrar **Total novo 42**.
3. Use desfazer para voltar ao comando e refazer para restaurar o resultado. Salve e reabra a nota para conferir o **42**. Ao desativar o Dados, a nota mostra **Total novo**.

### Editar uma fórmula já inserida

1. Em `Resolved target`, clique no botão **Editar fórmula** junto ao resultado **Legacy total 5**. O formulário abre com a expressão e o nome já preenchidos. O campo de expressão aceita várias linhas. Use Ctrl+Enter para salvar a partir desse campo.
2. Altere a expressão de `2 + 3` para `6 * 7` e salve. O resultado passa a **Legacy total 42**. Desfazer volta a **Legacy total 5** e refazer restaura **Legacy total 42** no mesmo ponto da nota.
3. Reabra o formulário e altere o nome. Salve e reabra para ver o novo nome junto ao valor. Apague o campo **Nome** para mostrar apenas o valor. Ao desativar o Polaris Dados, a nota volta ao texto de reserva salvo no marcador. Use **Cancelar** ou **Escape** para sair sem gravar.

## Fluxo curto

1. Abra a nota `Inventory` no cofre `PilotState\DemoVault`.
2. Confira que `Quantity` é 2, `Price` é 10 e `Total` é 20. A coluna `Inventory quantity` soma `Quantity` de todo o banco e começa em 2.
3. Edite `Quantity` para 3 e confirme em **Save**. Confira que `Total` muda para 30 e `Inventory quantity` muda para 3.
4. Abra a nota `Views` (com o cabeçalho `Origin Views`) e confira as duas visualizações vinculadas (`Origin primary stock` e `Origin low stock`). Ambas usam os dados de `Inventory.md` e mantêm título, filtro e ordem de colunas próprios. A coluna `Inventory quantity` usa todas as linhas do banco, inclusive as que o filtro da view oculta.
5. Feche o Morrow normalmente e clique em `windows-launch.cmd` outra vez. Reabra `PilotState\DemoVault` pela interface e confira que `Quantity` e `Inventory quantity` continuam em 3, `Total` continua em 30 e as duas visualizações permanecem.

Em `Inventory`, desmarque `Included` e salve. `Included quantity` deve cair para 0 e `Inventory quantity` deve continuar em 3. Desfaça a alteração para recuperar o subtotal. As views vinculadas usam os mesmos valores, inclusive quando um filtro da view oculta uma linha do banco.

## Edição de texto

1. Em `Inventory`, edite a célula `Name` e digite duas linhas. Use **Enter** para inserir a quebra de linha e **Escape** para cancelar. Verifique que a célula continua com o valor anterior.
2. Abra outro rascunho em `Name`. Alterne o modo de leitura e volte ao modo de edição. O texto digitado deve continuar no rascunho.
3. Confirme em **Save** ou **Salvar**. Confira em `Views` que as duas visualizações exibem o novo texto. Se a view `Origin low stock` estiver vazia, ajuste `Quantity` para pelo menos 3 no exercício anterior.
4. Feche o Morrow normalmente, abra o mesmo cofre de demonstração pelo launcher e confira o texto nas duas visualizações.

### Confirmar texto pelo teclado ou ao sair da célula

Em `Inventory`, edite **Name**, use **Enter** para inserir uma quebra de linha e **Ctrl+Enter** para salvar. O foco deve voltar à mesma célula. Em `Views`, edite **Name** na view vinculada e clique no título da nota para confirmar sem voltar o foco à grade. Abra outro rascunho e clique em **Cancelar** para descartar. Reabra o cofre e verifique o valor salvo na origem.

### Começar pelo primeiro caractere

Com o foco no botão de edição de **Name** em `Inventory` ou `Views`, digite `Q`. O campo abre com esse caractere e o cursor depois dele. Digite mais texto e confirme com **Ctrl+Enter**, ou pressione **Escape** para preservar o valor anterior.

### Somar preços com filtro de texto

Em `Inventory`, abra o cofre de demonstração em uma pasta nova e role a grade até **Widget price subtotal**. Com **Name** igual a `Widget` e **Price** igual a `10`, o subtotal mostra **10**. A fórmula é `Inventory.Filter(CurrentValue.Name = "Widget").Price.Sum()`. Troque **Name** para `widget` e confirme com **Ctrl+Enter**. O subtotal fica em **0**. Use **Ctrl+Z** na grade para voltar a **10**. Se já alterou **Price**, o subtotal mostra o preço atual da linha. O filtro de texto compara maiúsculas e minúsculas.

### Conferir o formato decimal de uma fórmula

Abra `Inventory` no cofre de demonstração. Com `Quantity` em **2**, `DecimalResult` mostra **(1.234,6)** e `DecimalRawCheck` mostra **42**. A segunda fórmula compara o valor antes do arredondamento.

Altere `Quantity` para **3** e salve. Os resultados passam a **(1.851,8)** e **17**. Abra `Views` e confira os mesmos valores na primeira visualização vinculada. Reabra o aplicativo para conferir que a edição permanece.

### Conferir moeda em uma fórmula

Na linha `Widget` de `Inventory`, com `Price` em **10** e `Quantity` em **2**, `CurrencyResult` mostra **($1,234.57)** e `CurrencyRawCheck` mostra **42**. O formato usa dólares, localidade dos Estados Unidos e duas casas decimais por padrão. Altere `Quantity` para **3** e confira **($1,851.85)** e **17** em `Inventory` e na primeira visualização de `Views`.

### Navegar na grade sem o mouse

Em `Checklist`, use **Tab** até a região do Polaris Dados e pressione uma seta. A primeira seta coloca o foco na primeira célula. Use as quatro setas para percorrer as linhas e colunas. Nas bordas, o foco permanece na última célula alcançada. Em `Checklist Views`, repita em cada visualização e confira que o foco segue apenas as linhas e a ordem de colunas daquela tabela.

Em `Inventory`, chegue até a célula calculada **Total** com as setas. Ela recebe foco para leitura. Volte para **Name**, digite um caractere para abrir o rascunho e confira que a seta esquerda passa a mover o cursor pelo texto. Pressione **Escape** para descartar. Use **Tab** para continuar pelos controles da tela.

### Abrir uma nota pelo título da linha vinculada

Abra `Views`. Na visualização vinculada, use **Tab** para chegar à região da grade e pressione uma seta para focar o título da primeira linha. Pressione **Alt+Enter** para abrir a nota dessa linha no painel em foco. Se houver um segundo painel, confira que ele mantém a nota anterior.

## Edição de caixas de seleção

1. Abra `Checklist` e edite **Reviewed** na linha `Unchecked`, identificada pela coluna **Sample**. Pressione **Espaço** com o foco na caixa, confirme em **Salvar** e confira **Verdadeiro** (**True**).
2. Abra `Checklist Views`. As duas views usam a mesma tabela. Em **Review queue**, edite `Unchecked`, desmarque e salve. Confira **Falso** (**False**) para a mesma linha em **Review summary**.
3. Nas linhas `Null` e `Missing`, abra a edição e pressione **Escape** ou **Cancelar**. Os valores devem continuar como **Vazio** (**Blank**) e **Ausente** (**Missing**), respectivamente.
4. Feche o aplicativo normalmente, abra `PilotState\DemoVault` pelo launcher e confira que `Unchecked` continua desmarcada nas duas views.

## Abrir notas e bancos em até quatro painéis

1. Abra a nota `Resolved target` e clique em **Escolher layout dos painéis** na barra de abas.
2. Experimente **Um painel**, **Duas colunas**, **Um à esquerda, dois à direita** e **Dois por dois**.
3. Num painel vazio, clique em **Abrir uma nota ou banco aqui**. Escolha `Inventory` e confira se o banco abriu no painel que você escolheu. Preencha outros painéis com notas.
4. Volte a duas colunas e depois à grade. Confira se as notas e os bancos desanexados voltam aos painéis.
5. Em **Configurações → Geral → Ao abrir o Morrow**, escolha **Onde parei**. Volte à grade, selecione o painel que quer retomar e feche o aplicativo normalmente. Abra o mesmo `PilotState\DemoVault` e confira o arranjo, as abas e o painel selecionado.

### Divisórias dos painéis

No layout **Dois por dois**, arraste a divisória central e depois uma divisória horizontal. Pressione **Esc** durante outro arraste para cancelar. Com a divisória em foco, use as setas no eixo da divisão, **Home** para 20% e **End** para 80%. Com **Onde parei**, feche e reabra para conferir as proporções gravadas. Abra a mesma nota em dois painéis, deixe uma seleção de texto no painel que quer retomar e feche normalmente. Ao reabrir, confira a seleção e o painel ativo.

## Catálogo na barra lateral

Em pacotes com o Polaris Arquivos, procure a seção **Arquivos** (**Files** em inglês) logo abaixo da árvore de notas. Expanda **Material** para encontrar `Inventario.txt` e abra **Subpasta** para ver `Planilha.csv`. Abra **Filtrar arquivos** na seção e ative **Incluir arquivos sem extensão** para mostrar `LEIAME`. Navegue para outra nota e confira se as pastas continuam expandidas. O botão **Arquivos** no menu principal abre a página de anexos e das notas que os usam.

### Abrir ou mostrar um arquivo do catálogo

Na seção **Arquivos**, expanda **Material** e clique em `Inventario.txt` para abri-lo no aplicativo do sistema. Use **Mostrar na pasta** ao lado do nome para localizá-lo no Explorador. O Windows usa o aplicativo associado à extensão.

## Verificações opcionais da base 2.2

Use somente conteúdo sintético. O modo de leitura é uma preferência global. Para conferir a restauração de rolagem em divisão, ative **Reading mode / Modo de leitura**, abra a mesma nota longa nos dois painéis e defina posições de rolagem diferentes. Navegue para fora da nota e reabra-a em cada painel. Confirme que cada painel restaura sua própria posição.

Em outra nota sintética, teste o embed `![[Banco de exemplo#Nome da visualização]]` somente se já existir um banco nativo com essa visualização. Confira que o embed mostra a visualização indicada. Essas verificações complementam o fluxo Polaris Dados e podem exigir conteúdo sintético adicional.

## Limites deste candidato

- Este pacote experimental cobre o piloto de tabelas e fórmulas do Polaris Dados. A migração dos demais recursos do fork está em andamento.
- Build e checks automáticos não equivalem a abrir o aplicativo. O teste da interface no Windows ainda depende da observação de Carlos; o restante da paridade permanece pendente.
- `BUILD-INFO.json` registra `appLaunched: false` e `windowsRuntimeTested: false`. O hash do executável pode variar entre builds nativos; compare o recibo e o artefato do mesmo run.
