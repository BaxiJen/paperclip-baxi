# Antigravity local — plugin externo

## Contrato e escopo

Implementar `@baxijen/paperclip-adapter-antigravity`, tipo `antigravity_local`,
seguindo o Kiro e sua correção `ac0e81b31`. Sem alterações em built-ins,
tipos compartilhados, banco, telemetria, Dockerfile ou DeepSeek. Sem commit/push.

1. Confirmar CLI e contrato externo; estudar execução, secrets e login existentes.
2. Implementar stdin NDJSON, parser, sessões com escopo, HOME por empresa/agente,
   settings mesclados, descoberta de modelos e diagnóstico sem inferência paga.
3. Empacotar bundle autossuficiente, parser de transcript e licenças.
4. Adicionar somente identidade visual e chave no SecretPicker existente.
5. Verificar com CLI falso, pacote isolado, testes afetados, typecheck e gates.

## Revisão de 2026-10-06

- Habilitar `subscription` e manter `api_key` como padrão, com segredo obrigatório.
  Assinatura remove só modelProvider atomicamente e não injeta chave/endpoint.
- Login manual uma vez no HOME/XDG do agente, seguido de `agy models`.
  O diagnóstico usa `diagnosticAgentId` explícito pois o contrato não traz ID;
  execução usa a identidade do contexto. Nunca remover o HOME persistente.
- Manter aviso D-Bus/Secret Service e encaminhar somente o endereço do bus no
  modo assinatura. Qualificação do keyring/isolamento por UID depende da VPS.
- Adiar painel de login até prova real de login, persistência, retomada e
  isolamento na VPS. As restrições de provedores/promoção de credenciais e HOME
  temporário do host ainda exigem integração própria, sem loginCapability falsa.
- Publicar eventos reconhecidos por linha NDJSON completa com redação antes de
  ctx.onLog, durante a execução. Manter captura total limitada a 4 MiB.
- Usar usageBasis per_run: result descreve a execução, sem evidência de totais
  cumulativos da conversa. gemini_local não declara base; contrato distingue
  explicitamente per_run e session_cumulative. Cobrir retomada no teste.
- Remover VALIDATION.md; resultados vão na descrição do PR e resposta final.

## Evidência e verificação

- https://antigravity.google/docs/cli/headless
- https://antigravity.google/docs/cli/install
- https://antigravity.google/docs/cli/troubleshooting
- Fixtures são exemplos oficiais e CLI falso, não capturas da VPS.
- Rodar test/typecheck/build/test:bundle do pacote, testes UI afetados,
  typecheck UI e check:token-gates. Relatar bloqueios do sandbox sem contorno.
- Os 39 testes anteriores passaram fora do sandbox, conforme revisão recebida.
- Sem commit, push ou deploy. Qualificação real na VPS continua pendente.
