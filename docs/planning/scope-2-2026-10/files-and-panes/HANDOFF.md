# Handoff — expansão de arquivos, web e painéis

**Limite vigente:** somente os 15 tickets aceitos entram na integração 1.3; os outros 24 permanecem pausados. Veja [EXECUTION.md](../EXECUTION.md).


**Snapshot de planejamento.** A autorização posterior dos 39 tickets está em
[EXECUTION.md](../EXECUTION.md) e supera os avisos históricos abaixo.

Este adendo amplia os trinta itens anteriores para 37 origens e os trinta tickets para 39. Leia também [handoff original](../HANDOFF.md), [spec](SPEC.md), [grilling](GRILLING.md), [aceitação](ACCEPTANCE.md), [tickets](TICKETS.md), AGENTS/ARCHITECTURE/CONTRIBUTING e políticas de commits/release. Baseline 11dc558bd0cf8de1d8fa8bf5b61eb0b9adeaa83f.

## Despacho futuro, após autorização

- Preferências: Sol 6.1 medium principal/revisor e Luna 6 max executor nas sessões definidas pela política; não despachar agora nem trocar modelo silenciosamente.
- Revalidar estado Git/GitHub e bloqueadores. Reutilizar scanner, plataforma, tabs e split; não criar segundo documento/session por painel. Atribuir responsabilidade explícita; evitar execução concorrente do host de abas, App e roteamento por tickets diferentes.
- T33 introduz alvo tipado com imagem funcionando. PDF/mídia/web o estendem. T37 estende split com notas funcionando; T38 conecta preenchimento e drag. Manter legado funcional durante migração; não começar por refatoração horizontal quebrando tudo.
- Coordenar restauração de scroll com #67 e integridade/gestos com #65/#57; são áreas compartilhadas, não dependências fictícias. Nenhum executor pode sobrescrever trabalho do outro.
- Grupos D10–D14 reúnem entregas, testes, traduções e correções antes do push; não publicar microcommits. D1–D9 continuam válidos.
- O gate novo depende da aceitação antiga #81 e dos oito novos tickets. Não bloquear #81 pelo novo gate, pois isso criaria ciclo. Status e relações nativas no GitHub são autoridade.

## Restrições

Sem redes ao varrer/restaurar abas inativas, sem acesso de sites ao vault/bridge, sem leitura integral de mídia grande, sem copiar originais para attachments, sem gravar conteúdo ao abrir. Sem credenciais, cookies, vault pessoal ou gravação privada em fixture/repo. Uma sessão bloqueada por Google não é corrigida com bypass nem UA forjado. Aplicativo específico usa seleção nativa e argumento separado, sem shell.

Provas posteriores são no pacote desktop isolado, nunca manipulando janelas pessoais. Nenhuma build, instalação ou release deve ser iniciada pela leitura deste plano.
