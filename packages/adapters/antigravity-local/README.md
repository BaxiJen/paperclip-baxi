# Antigravity — Google Antigravity CLI

Plugin **externo** `@baxijen/paperclip-adapter-antigravity`, tipo
`antigravity_local`, para o fork BaXiJen. Não registra um built-in, não muda o
banco nem instala o CLI. Requer Node >=24.11 e `agy` instalado pelo operador.

## Conectar por chave na VPS

1. Compile o pacote na raiz do checkout:
   `pnpm --filter @baxijen/paperclip-adapter-antigravity build`.
2. Disponibilize o diretório compilado na VPS e, com acesso de administrador da
   instância, envie `POST /api/adapters/install` com:

   ```json
   { "packageName": "/caminho/absoluto/antigravity-local", "isLocalPath": true }
   ```

   Isso é instrução de instalação; nenhuma instalação/deploy foi feita neste trabalho.
3. Na criação do agente, selecione **Antigravity**. O `SecretPicker` existente
   pede `GEMINI_API_KEY`. Escolha/crie um segredo Google AI Studio. Bindings
   `secret_ref` e `user_secret_ref` são resolvidos pelo host, nunca pelo plugin.
4. Nos campos de configuração externos, seção **Conexão**, selecione chave de
   API. O endpoint HTTPS opcional usa `baseUrl`/`GOOGLE_GEMINI_BASE_URL`.
5. Configure `command` se `agy` não estiver no PATH do serviço systemd, por
   exemplo `/home/paperclip/.local/bin/agy`. Execute **Testar conexão**.
6. Faça uma tarefa pequena e confira resultado real, permissões, retomada e uso
   na VPS antes de habilitar trabalho autônomo.

Configuração ilustrativa, sem chave em texto:

```json
{
  "command": "agy",
  "connectionMode": "api_key",
  "env": {
    "GEMINI_API_KEY": { "type": "secret_ref", "secretId": "UUID-DO-SEGREDO", "version": "latest" }
  },
  "timeoutSec": 3600,
  "graceSec": 5,
  "dangerouslySkipPermissions": false,
  "sandbox": false
}
```

`cwd` é fallback: o workspace do Paperclip tem prioridade. `model` recebe um
slug de `agy models`; vazio não passa `--model`. `effort` aceita low/medium/high.
Sem ignorar permissões, ferramentas podem ser negadas silenciosamente pelo CLI;
saída SUCCESS não prova que uma ferramenta efetuou sua ação. Revise as regras
`permissions.allow` no settings do agente, ou autorize explicitamente
`dangerouslySkipPermissions`. `sandbox` é o sandbox do CLI, não um runner remoto.

## HOME, credenciais e sessões

HOME por empresa/agente:

```text
<raiz-da-instância>/adapter-homes/antigravity/<companyId>/<agentId>
```

A raiz segue `resolvePaperclipInstanceRootForAdapter`: normalmente
`~/.paperclip/instances/default`, ou `PAPERCLIP_HOME/instances/PAPERCLIP_INSTANCE_ID`.
Diretórios do adapter usam 0700; o arquivo
`$HOME/.gemini/antigravity-cli/settings.json` usa 0600. A escrita é uma mesclagem
atômica: no modo `api_key` seleciona `modelProvider: "gemini"`; no modo
`subscription` remove só `modelProvider`, preservando as demais chaves. JSON inválido
é rejeitado; links simbólicos na árvore do adapter ou no settings são rejeitados.
O adapter não escreve chaves em arquivos. Configuração, dados e cache XDG também
ficam sob esse HOME. Não herda chave Google, HOME nem XDG do usuário do servidor. Somente no
modo assinatura encaminha DBUS_SESSION_BUS_ADDRESS do serviço para o keyring. Essa separação não é uma fronteira de segurança entre processos com o
mesmo UID: contenção de ferramentas/usuários ainda é responsabilidade do operador.

O JWT do Paperclip vem exclusivamente de `ctx.authToken`. O env persistido do
agente permite apenas GEMINI_API_KEY e GOOGLE_GEMINI_BASE_URL; nomes são validados
separadamente do env enriquecido pelo host. TMPDIR/TMP/TEMP vêm do scratch do host.

Prompt e instruções vão em **uma linha JSON pelo stdin**, encerrado após envio.
Limite: 2 MiB de prompt. Nenhum prompt/chave vai em argv. stdout+stderr têm teto
de 4 MiB; timeout, abort e excesso de saída encerram o grupo com TERM/KILL.
Callbacks `onSpawn`, `onCancellationReady` e `onDispatch` seguem o Kiro.

Só há sucesso com exit 0 e resultado SUCCESS válido. As sessões usam
`--conversation`, nunca `-c`/`--continue`, com hash de empresa/agente/tarefa/cwd/
configuração/binding de segredo/HOME. Um ID retornado diferente do retomado falha
e limpa a sessão. Rotacionar o valor de um segredo com versão `latest` ou editar
instruções/settings no mesmo caminho exige reset manual da sessão.

`usage` mapeia input/output/cache; thinking já está incluído em output e não é
somado novamente. Thinking/total/duração/turnos ficam no resultado estruturado.
`usageBasis` é `per_run`: o result documentado descreve a execução; não há
prova de totais cumulativos da conversa ao usar `--conversation`. O gemini_local
repassa o usage do resultado sem declarar uma base; isso não prova acumulação.
O contrato distingue uso por execução de totais acumulados que exigem deltas.
O teste de retomada garante que dois resultados iguais mantêm o uso de cada run.
Custo monetário desconhecido é omitido, nunca inventado como zero.

O parser `./ui-parser` rende init, texto, ferramentas/resultados e erros.
Eventos `init`, `step_update` e `result` são publicados ao chegar cada linha
NDJSON completa, com redação da linha inteira antes do log. Isso protege segredos
fragmentados entre chunks. A captura final mantém o teto de 4 MiB; stderr e
prompt não são publicados. O teste com CLI falso só permite terminar depois de
receber o log intermediário redigido.

## Assinatura Google e login manual

Selecione **Assinatura Google (conta já conectada na VPS)** (`subscription`).
Não é necessária GEMINI_API_KEY; chave e endpoint configurados são ignorados
nesse modo. Salve o agente, copie seu ID no campo **ID do agente para testar
assinatura** (`diagnosticAgentId`) e execute **Testar conexão**. Esse campo existe
porque `testEnvironment` não recebe identidade de agente no contrato atual; não
altera a identidade usada por `execute`. Sem ID, o diagnóstico pede esse dado e
não consulta outro HOME. Em execução, o ID vem sempre do contexto autenticado.

O teste prepara o HOME do agente e remove atomicamente só `modelProvider`.
Se faltar autenticação, mostra o comando exato para rodar UMA vez na VPS com o
usuário do serviço: `env -u GEMINI_API_KEY -u GOOGLE_GEMINI_BASE_URL HOME=…
XDG_CONFIG_HOME=… XDG_DATA_HOME=… XDG_CACHE_HOME=… SSH_CONNECTION=… agy`.
Use o comando completo mostrado no diagnóstico (inclui caminhos e binário
configurados), abra a URL em outro computador e cole o código no terminal.
Depois execute o mesmo comando com `models`, também fornecido no hint. Não é
necessário editar settings. Repita o teste: sucesso informa
“Conta Google conectada; N modelos”, sem inferência nem gasto de créditos.
O escopo da sessão inclui o modo de conexão; trocar de modo inicia nova sessão.

No Linux, mantenha D-Bus de sessão e Secret Service (GNOME Keyring/KWallet)
ativos e desbloqueados para o usuário do serviço. Não há fallback garantido
para arquivo; HOME isolado não isola keyring por UID. O diagnóstico mantém esse
aviso, e erros de keyring continuam sendo falhas explícitas.

### Próximo passo: painel de login, depois da VPS

Qualificar primeiro login manual, persistência após reinício do serviço, keyring,
retomada e isolamento de contas na VPS real. Só depois implementar o painel de
login. O host ainda restringe provedores e promoção de credenciais e usa HOME
temporário no fluxo de login; declarar `loginCapability` agora exporia um painel
que não conclui esse fluxo. Nenhum login automático é simulado pelo plugin.

## Diagnóstico e descoberta

`testEnvironment` chama somente `--version`, `--help` e `models`, com timeout de
10 segundos por probe. Chave usa HOME descartável limpo ao final; assinatura
usa o HOME persistente do agente, que nunca é removido pelo diagnóstico. Não faz inferência nem
gasta créditos. Confere suporte às flags de stdin/timeout e mostra erros em
português. Não afirma autenticação paga verificada: segundo o Google, uma chave
não vazia pode ser aceita no startup e só falhar na primeira conversa.

O contrato global `listModels()`/`detectModel()` não recebe config nem identidade
de agente. A descoberta usa `agy` no PATH e um HOME descartável sem credenciais
ambiente. Caso a versão exija autenticação para listar, retorna lista vazia;
o campo permite digitar o slug, e Testar conexão usa o binário/chave configurados.
`agy models` não marca um modelo padrão, portanto detectModel retorna null em
vez de selecionar arbitrariamente a primeira linha. Nenhuma conta de outro
agente é consultada.

## Pacote e provas

`build.mjs` embute a versão workspace de adapter-utils com esbuild. O artefato
não depende da versão npm antiga dos helpers. `dist/ui-parser.js` é ESM de browser
sem imports de runtime, conforme `paperclip.adapterUiParser = 1.0.0`.
O bundle inclui LICENSE, THIRD-PARTY-NOTICES e as licenças geradas de dependências.
`test/bundle-smoke.mjs` copia os artefatos para fora da árvore de dependências e
exercita factory, execução e parser. Não publica pacote.

As fixtures são exemplos de saída real **publicados na documentação**, não
capturas próprias. O CLI falso Node não usa rede nem conta Google. Há testes de
stdin grande, flags, status, NDJSON corrompido, settings, HOME, env enriquecido,
segredos, timeout/abort/grupo de processos, probes gratuitos, sessões, contrato
externo e parser rico. Login automatizado fica para depois da qualificação real na VPS.

Fontes consultadas em 2026-10-06:

- [Headless e protocolo](https://antigravity.google/docs/cli/headless)
- [Instalação e chave de API](https://antigravity.google/docs/cli/install)
- [Keyring e Linux headless](https://antigravity.google/docs/cli/troubleshooting)
- [Changelog](https://www.antigravity.google/docs/changelog?tab=cli) — há versões
  recentes com exit 3 em erros estruturados e timeout padrão ilimitado; todo
  exit não zero falha e o plugin passa timeout explícito em qualquer versão.

Resultados de verificação pertencem à descrição do PR. Ainda é necessária
qualificação real na VPS.
