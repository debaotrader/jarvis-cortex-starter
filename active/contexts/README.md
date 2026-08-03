# Contextos Switcháveis

## Quando usar cada contexto

### dev.md — Modo Desenvolvimento
**Ativar quando:** implementando features, corrigindo bugs, escrevendo código.
**Prioridade:** Funcionar > Estar correto > Estar limpo.
**Saída:** código commitado e testado.

### review.md — Modo Code Review
**Ativar quando:** revisando PR, auditando código, validando qualidade.
**Prioridade:** Segurança > Correção > Performance > Manutenção.
**Saída:** lista de findings com severidade e fix específico.

## Como ativar
Mencionar ao JARVIS: "entra em modo dev" ou "modo review".
Ou carregar diretamente: "lê active/contexts/dev.md".
