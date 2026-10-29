# T35 — Reproduzir áudio e vídeo locais em abas

**GitHub:** https://github.com/hodeliun/Morrow/issues/87

## Parent

https://github.com/hodeliun/Morrow/issues/82

Continuação de https://github.com/hodeliun/Morrow/issues/51 (sem substituir os 30 itens anteriores).

## What to build

Usar player básico para mídia existente em pasta comum do vault.

**Planejamento somente. Implementação aguarda autorização posterior; ready-for-agent não é despacho.**

## Acceptance criteria

- [ ] Player tem play/pausa, posição/duração, seek, volume e velocidade; vídeo tem tela cheia e alternativa por teclado.
- [ ] Servir bytes sob demanda com Range/206/416, MIME, HEAD e cancelamento corretos; arquivo grande não é lido inteiro para começar; não copiar/transcodificar.
- [ ] Testar reprodução e seek de WAV/PCM e WebM/VP8+Opus no pacote; registrar resultado de MP4/H.264/AAC e demais amostras sem inferir suporte da extensão.
- [ ] Formato/codec inválido mostra diagnóstico e opção externa; mover/remover arquivo trata erro sem perda de documento.
- [ ] Ocultar/fechar aba ou trocar vault pausa mídia e libera recursos; restaurar aba/layout não inicia autoplay nem mantém áudio invisível.
- [ ] Originais não recebem escrita; placeholders mostram disponibilidade real; nada de baixar codecs ou iniciar rede automaticamente.

## Blocked by

- https://github.com/hodeliun/Morrow/issues/85

## Verification

Mídia sintética pequena e grande (>100 MiB), intervalos inválidos, seek inicial/final, codec incompatível, quatro superfícies mistas e interrupção/close.

## Traceability and delivery

Origem: S2-34. Grupo D11 — Visualizadores locais de imagens, PDF e mídia. Um ticket não significa um commit separado.

Preservar arquitetura, comandos/sessão, YAML/Markdown e binários; abrir não grava originais. Sem nova dependência runtime nem acesso remoto à bridge. PT/EN/ES, temas, teclado, readonly e painel estreito fazem parte da entrega. Exemplos/evidências públicos somente sintéticos.

[Spec](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/SPEC.md) · [Grilling](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/GRILLING.md) · [Aceitação](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/ACCEPTANCE.md) · [Handoff](https://github.com/hodeliun/Morrow/blob/3961657c3d4a27ce3697b7b1c3d0b513202f94bc/docs/planning/scope-2-2026-10/files-and-panes/HANDOFF.md)

<!-- morrow-scope-2-files-and-panes:T35 -->
