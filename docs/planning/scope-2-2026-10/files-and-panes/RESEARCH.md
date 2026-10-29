# Referências oficiais — pesquisa de planejamento

Consulta em 28/10/2026. Inferência arquitetural: aproveitar recursos do Electron já incluído é preferível a adicionar um player ou framework. Isso precisa de validação no pacote do fork, não prova compatibilidade de runtime.

- [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view): superfície nativa de conteúdo web, com bounds controlados pelo processo principal. Fundamenta abas web isoladas e a necessidade de gerenciar geometria e ciclo de vida.
- [Segurança do Electron](https://www.electronjs.org/docs/latest/tutorial/security/): recomenda isolamento, sandbox, controle de navegação, permissões e ausência de Node/bridge privilegiada para conteúdo remoto. Este plano aplica esse limite também aos viewers não confiáveis.
- [WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences): descreve sessões/partições e isolamento. Sessão de sites deve ser separada dos renderers de notas e recursos locais.
- [shell](https://www.electronjs.org/docs/latest/api/shell): openPath delega ao aplicativo padrão e retorna erro; openExternal abre URLs externamente. Não é API de escolha universal de aplicativo específico: seleção e lançamento restrito precisam de contrato próprio.
- [Políticas OAuth Google — browsers](https://developers.google.com/identity/protocols/oauth2/policies#browsers): fluxos Google OAuth não devem ser enviados a agentes embutidos controlados pelo desenvolvedor. Portanto, não prometer login Google interno ou bypass; indicar limitação e fallback externo.

## Evidência estática no baseline

Inspeção encontrou scanner com outros arquivos, mas árvore de pastas focada em páginas; suporte a MD e JSON Canvas; pasta de anexos e protocolo local; PDF/plugins habilitados na janela; abas main/side com históricos e separador persistido. Conteúdo remoto hoje é desviado para navegador externo. São pontos de extensão, não prova de funcionalidade entregue. Não existe motivo para reiniciar a arquitetura do zero.
