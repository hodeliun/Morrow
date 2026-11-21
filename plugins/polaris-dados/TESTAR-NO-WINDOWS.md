# Testar o piloto Polaris Dados no Windows

Este candidato experimental usa Morrow 2.1.0 e inclui o piloto Polaris Dados com edição de números e texto. O ZIP inclui um executável compilado nativamente no Windows. O build verifica o ZIP, os hashes e o launcher em PowerShell 5.1 e 7. A abertura da interface no Windows e a paridade integral com o fork seguem pendentes de teste.

## Requisitos

- Windows x64.
- Microsoft Edge WebView2 Runtime instalado.
- Espaço livre para extrair o ZIP e guardar o estado do teste.

O launcher configura `WEBVIEW2_USER_DATA_FOLDER` para uma pasta dentro de `PilotState`. A [documentação Microsoft sobre a variável de dados do WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.3967.48) explica essa substituição. O backend do Morrow, os dados WebView2 e o cofre de teste ficam no `PilotState` ao lado do launcher.

O Tauri e o plugin de estado da janela ainda podem gravar pastas ou metadados com o identificador do piloto no perfil Windows, como em `AppData\Roaming`. Por isso, o pacote não afirma isolamento total do perfil Windows.

## Preparar e abrir

1. Baixe o ZIP do artefato GitHub Actions e extraia-o uma vez para uma pasta temporária. Esse arquivo externo contém outro ZIP com o pacote.
2. Extraia o ZIP interno diretamente para uma pasta nova e curta, por exemplo `Downloads\MorrowPiloto`. O executável, `windows-launch.cmd` e `DemoVault` devem ficar juntos na raiz dessa pasta. Não execute o aplicativo de dentro de nenhum ZIP.
3. Não extraia para dentro de um cofre pessoal nem abra um cofre pessoal neste teste.
4. Salve e feche qualquer outro Morrow aberto. O launcher recusa iniciar se encontrar outro processo `morrow.exe`.
5. Clique duas vezes em `windows-launch.cmd` e aguarde o seletor de cofres ou a tela Welcome.
6. Pela interface do Morrow, abra a pasta `PilotState\DemoVault`, dentro da pasta onde você extraiu o pacote. Essa é a cópia de teste editável. A pasta `DemoVault` no nível superior do pacote é o modelo original; deixe-a intacta.
7. Em Settings/Configurações, habilite plugins locais e o plugin Polaris Dados. Se necessário, recarregue a nota.

O launcher cria `PilotState\DemoVault` na primeira execução. As próximas execuções reutilizam essa cópia para manter as alterações. Se o launcher recusar uma pasta, aparecer um cofre pessoal ou surgir uma tela inesperada, feche o aplicativo e informe o que aconteceu. Não apague nem tente reparar a pasta recusada.

## Fluxo curto

1. Abra a nota `Inventory` no cofre `PilotState\DemoVault`.
2. Confira que `Quantity` é 2, `Price` é 10 e `Total` calculado é 20.
3. Edite `Quantity` para 3 e confirme em **Save**. Confira que `Total` muda para 30.
4. Abra a nota `Views` (com o cabeçalho `Origin Views`) e confira as duas visualizações vinculadas (`Origin primary stock` e `Origin low stock`). Ambas usam os dados de `Inventory.md` e mantêm título, filtro e ordem de colunas próprios.
5. Feche o Morrow normalmente e clique em `windows-launch.cmd` outra vez. Reabra `PilotState\DemoVault` pela interface e confira que `Quantity` continua 3, `Total` continua 30 e as duas visualizações permanecem.

## Edição de texto

1. Em `Inventory`, edite a célula `Name` e digite duas linhas. Use **Enter** para inserir a quebra de linha e **Escape** para cancelar. Verifique que a célula continua com o valor anterior.
2. Abra outro rascunho em `Name`. Alterne o modo de leitura e volte ao modo de edição. O texto digitado deve continuar no rascunho.
3. Confirme em **Save** ou **Salvar**. Confira em `Views` que as duas visualizações exibem o novo texto. Se a view `Origin low stock` estiver vazia, ajuste `Quantity` para pelo menos 3 no exercício anterior.
4. Feche o Morrow normalmente, abra o mesmo cofre de demonstração pelo launcher e confira o texto nas duas visualizações.

## Limites deste candidato

- Este pacote experimental cobre o piloto de tabelas e fórmulas do Polaris Dados. A migração dos demais recursos do fork está em andamento.
- Build e checks automáticos não equivalem a abrir o aplicativo. O teste da interface no Windows ainda depende da observação de Carlos; o restante do port permanece pendente.
- `BUILD-INFO.json` registra `appLaunched: false` e `windowsRuntimeTested: false`. O hash do executável pode variar entre builds nativos; compare o recibo e o artefato do mesmo run.
