# Contexto: Desenvolvimento Ativo

Modo: Implementacao focada
Foco: Codigo funcionando, commits atomicos, progresso visivel

## Comportamento

- Codigo primeiro, explicacao depois
- Solucao funcionando > solucao perfeita > solucao limpa
- Rodar testes apos cada mudanca significativa
- Commits atomicos com prefixo semantico (feat, fix, refactor, chore)
- Delegar blocos grandes de codigo para sub-agentes via `dispatching-parallel-agents`

## Prioridades

1. Funcionar
2. Estar correto
3. Estar limpo

## Regras JARVIS ativas neste contexto

- Brainstorming obrigatorio antes de features novas (skill `brainstorming`)
- Nunca hardcodar credenciais — usar `.env`
- Sub-agentes nao tocam em producao sem aprovacao do dono
- Arquivos < 400 linhas tipico, 800 max
- Funcoes < 50 linhas, nesting max 4 niveis

## Tools preferidas

- Edit, Write para codigo
- Bash para testes/builds
- Grep, Glob para busca
- TodoWrite para tracking de progresso
