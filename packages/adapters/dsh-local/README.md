# BaXiJen dsh local adapter

Plugin externo `@baxijen/paperclip-adapter-dsh`, tipo `dsh_local`.
Rótulo da integração: **DeepSeek Harness (dsh)**. Não é um projeto da DeepSeek.
Compatibilidade qualificada pelo fonte: `@deepseek-ai/dsh@0.2.1-alpha.1`.
O executável é dependência externa; este pacote não o instala nem o inclui.

## Conectar o agente

1. Instale o pacote construído pelo gerenciador de adapters externos. O schema
   aparece na configuração do agente e, neste fork, também na criação de dsh_local.
   Escolha DeepSeek, Anthropic, OpenAI, Kimi/Moonshot, GLM/Z.ai ou Outro.
2. Selecione um segredo existente no SecretPicker, ou digite a chave e clique
   **Salvar chave como segredo**. O botão usa o serviço de segredos existente:
   a chave vira um `secret_ref`; o teste e o agente recebem somente esse binding.
   O segredo criado é da organização e permanece disponível se a criação do agente
   for cancelada. Não é armazenado no adapterConfig como texto. Há links para os
   consoles dos provedores. Para API própria, obtenha a chave no seu gateway.
3. Use **Run test / Testar ambiente**. O servidor verifica Node no PATH, versão do
   dsh e faz um GET autenticado de modelos, sem inferência. Confira a lista curta
   no diagnóstico, escolha uma sugestão ou digite o ID no combobox e confirme com
   **Enter**. Salve o agente. O teste pode listar modelos antes de você escolher um.

Após salvar, a edição usa o schema genérico e **Variáveis de ambiente** para
vincular/criar segredos. `user_secret_ref` também funciona: o host resolve a chave
para o usuário responsável. Não oferecemos login OAuth nem copiamos credenciais
ambientais do usuário do serviço. A lista de provedores é curta e fixa; as sugestões de modelo não dependem de uma instalação local do CLI.

| Provedor | Variável no env do agente |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Kimi / moonshotai | `MOONSHOT_API_KEY` |
| GLM / zai | `ZAI_API_KEY` |
| Outro | `DSH_CUSTOM_API_KEY` |

**Outro** mostra campos condicionais para `providerId` (permanente, minúsculo),
`baseURL` e `protocol`: `openai-completions`, `openai-responses` ou
`anthropic-messages`. URL não aceita credenciais, query ou fragmento. HTTP local
é permitido para servidores próprios. O operador escolhe o destino da chave;
redirecionamentos HTTP na listagem são recusados. Provedores predefinidos usam
seus endpoints públicos usuais para o teste; a execução usa o catálogo pi-ai
instalado. Para outra região, plano/endpoint específico ou proxy, use Outro.

A listagem usa `GET {baseURL}/models` com Bearer, ou `/v1/models?limit=1000`
com `x-api-key` e `anthropic-version` para Anthropic (sem duplicar `/v1`).
Limites: 10 segundos, 1 MiB, sem paginação. HTTP 401/403 retorna
`adapter_auth_missing`. Falha de rede/listagem retorna aviso e permite o ID
manual; isso **não** confirma autenticação. A listagem não garante acesso à
inferência ou suporte ao esforço escolhido. As sugestões são exemplos; não
são uma lista de modelos que a conta necessariamente pode usar.

## Configuração e armazenamento

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "command": "dsh",
  "timeoutSec": 1800,
  "graceSec": 5,
  "env": {
    "DEEPSEEK_API_KEY": {
      "type": "secret_ref",
      "secretId": "ID_DO_SEGREDO",
      "version": "latest"
    }
  }
}
```

`reasoningEffort` é opcional. `cwd` é fallback: o workspace fornecido pelo host
prevalece. `instructionsFilePath`, `promptTemplate`, skills e ferramentas de
runtime seguem o contrato local do Kiro. O adapter exige o JWT local fornecido
pelo host e rejeita execução remota antes de preparar arquivos.

Cada empresa/agente recebe:

```
$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/adapter-homes/dsh/<company>/<agent>/
```

Esse diretório, com modo 0700, é o `DSH_HOME`. Os padrões são `~/.paperclip` e
`default`. O próprio dsh inicializa `profiles/headless/cordis.patch.yml` a partir
do template embarcado. Um overlay exclusivo 0600 é gerado a cada execução e
removido ao terminar, inclusive em erro. Seu formato é JSON (subconjunto válido
de YAML), uma lista de patches para `llm-deepseek` ou `llm-pi-ai` e
`agent-default-model`. O nativo usa a rota **deepseek-official**, não `deepseek`.
Catálogo e custom declaram o modelo selecionado; o catálogo fornece seus defaults.
Um ID novo em um catálogo com vários protocolos (por exemplo, OpenAI) pode exigir
"Outro / API compatível", com protocolo explícito, até o catálogo do dsh ser atualizado.

O overlay contém **apenas o nome** da variável `apiKeyEnv`. Seu valor existe no
ambiente do processo, resolvido pelo host. Os nomes do env configurado pelo
operador são validados separadamente de `ctx.config.env`, enriquecido pelo host.
Só a chave selecionada é repassada. `NODE_OPTIONS`, `GH_TOKEN`, `DSH_HOME` e
`PAPERCLIP_*` não podem ser definidos pelo env do agente. `TMPDIR/TMP/TEMP` vêm
exclusivamente de `context.paperclipScratch.dir`. O HOME do serviço é mantido
para ferramentas; o isolamento contratado é do DSH_HOME, não um sandbox do SO.

Não edite profiles/plugins em uso sem revisar a política do agente e resetar
sua sessão. O dsh persiste conversas e ferramentas em seu próprio home; o adapter
não pode impedir uma ferramenta arbitrária de ler o ambiente e escrever a chave
em arquivos. O adapter não escreve a chave e redige valores conhecidos em stdout,
resultado e diagnóstico. Isolamento por UID/permissões/ferramentas continua sendo
responsabilidade da implantação. Este plugin não altera as permissões padrão do dsh.

## Execução e sessão

```
dsh --profile headless --patch <overlay.yml> --json [--session-id <id>]
```

Os flags do launcher precedem os do app. A tarefa vai inteira por **stdin**, nunca
em argv; há um teto de prompt de 2 MiB e 4 MiB de saída combinada stdout/stderr.
Linhas completas de NDJSON são redigidas e publicadas ao vivo. A projeção do dsh
é por mensagem confirmada, não por token. `final` fornece a resposta completa,
sem o corte de 8 KiB dos eventos intermediários; acima do teto de saída o run falha
em vez de entregar uma resposta parcial como sucesso. O parser externo produz
texto, raciocínio, chamadas/resultados de ferramentas e diagnósticos.

Sucesso exige exit 0, sessão válida, `turn_end.reason.kind=completed` e um único
`final` válido. `error`, NDJSON corrompido, final vazio com exit 1, timeout ou sinal
não viram sucesso. Uso completo de `step_end` é somado com `usageBasis: per_run`;
uso incompleto e custo desconhecido são omitidos.

Sessões são vinculadas por hash a empresa, agente, tarefa, cwd real, command,
profile, overlay, caminho de instruções, prompt e binding de credencial. Alterar
conteúdo de instruções/profile ou rotacionar uma chave `latest` para outra conta
exige reset de sessão. Recusa explícita por sessão inexistente/cwd/preset faz
**uma** tentativa nova com aviso e contexto completo, somente antes de iniciar
trabalho; falha de autenticação, erro de ferramenta e timeout não são repetidos.

No Linux, subprocessos usam grupo próprio. `onSpawn`, `onCancellationReady` e
`onDispatch` são chamados antes de enviar o prompt. Abort/timeout/excesso de saída
encerram o grupo com SIGTERM e, após `graceSec`, SIGKILL, incluindo descendentes
que sobreviverem ao líder. Não há suporte qualificado para processos que criem
outro grupo/sessão por conta própria.

## Construir e instalar separadamente

```sh
~/.local/bin/pnpm --filter @baxijen/paperclip-adapter-dsh build
~/.local/bin/pnpm --filter @baxijen/paperclip-adapter-dsh test
~/.local/bin/pnpm --filter @baxijen/paperclip-adapter-dsh typecheck
~/.local/bin/pnpm --filter @baxijen/paperclip-adapter-dsh test:bundle
```

O esbuild embute o adapter-utils deste workspace, sem dependências npm de runtime.
O artefato inclui LICENSE, THIRD-PARTY-NOTICES e notices das dependências embutidas.
`./ui-parser` é um bundle de navegador sem imports e declara contrato `1.0.0`.
O smoke importa os bundles em um diretório temporário sem node_modules e executa
um CLI falso, sem conta de provedor.

Depois de copiar o pacote construído para um caminho acessível ao usuário do
serviço, um administrador pode instalar por `POST /api/adapters/install`:

```json
{"packageName":"/opt/paperclip-adapters/dsh-local","isLocalPath":true}
```

Este trabalho não faz instalação, commit, publicação npm, push ou deploy. O dsh
precisa estar no PATH do **systemd**, ou `command` precisa ser absoluto. CLI requer
Node ^22.19 ou >=24; o pacote usa o mínimo do host Paperclip (>=24.11). A versão do
CLI está intencionalmente limitada a 0.2.1-alpha.1 até qualificar outro protocolo.

## Evidência e validação pendente

Veja [plano e resultados](../../../doc/plans/2026-10-06-dsh-local.md).
Os testes usam formatos conferidos em `deepseek-ai/deepseek-harness`, fonte
0.2.1-alpha.1: `apps/cli/src/args.ts`, `packages/bundle/headless/src/{index,startup,json-stream}.ts`,
`packages/bundle/base/cordis.patch.yml`, catálogo de configuração e llm-pi-ai.
Referências HTTP: [DeepSeek modelos](https://api-docs.deepseek.com/api/list-models/),
[Anthropic modelos](https://platform.claude.com/docs/en/api/models/list).

Na VPS ainda é necessário provar: PATH/Node do serviço e primeira inicialização,
GET dos cinco provedores e API própria, modelo/esforço efetivamente usados,
retomada com leitura de arquivo novo, escopo entre dois agentes, permissões das
ferramentas e término de filhos em cancelamento. Sem essa prova, não se afirma
compatibilidade operacional com todas as contas, catálogos ou gateways.
