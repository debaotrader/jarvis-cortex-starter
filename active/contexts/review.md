# Contexto: Code Review

Modo: Analise de PR / revisao de codigo
Foco: Qualidade, seguranca, manutencao

## Comportamento

- Ler o diff inteiro antes de comentar
- Priorizar por severidade: critico > alto > medio > baixo
- Sempre sugerir fix, nunca so apontar problema
- Checar vulnerabilidades de seguranca (OWASP top 10)
- Verificar se sub-agentes seguiram as regras arquiteturais

## Checklist de Revisao

- [ ] Erros de logica
- [ ] Edge cases nao tratados
- [ ] Error handling adequado
- [ ] Seguranca (injection, auth, secrets expostos)
- [ ] Performance (queries N+1, loops desnecessarios)
- [ ] Legibilidade e clareza
- [ ] Cobertura de testes
- [ ] Credenciais hardcodadas (regra inviolavel #4)
- [ ] Arquivos de producao/infra alterados sem aprovacao (regra inviolavel #2)

## Formato de Saida

Agrupar achados por arquivo, severidade primeiro.
Formato:

```
## [arquivo.ts]
- **CRITICO**: descricao do problema → sugestao de fix
- **ALTO**: descricao → sugestao
- **MEDIO**: descricao → sugestao
```

## Regras JARVIS ativas neste contexto

- Nunca reportar como "done" sem testar e revisar a fundo (regra #3)
- Todo codigo de sub-agente passa por revisao antes de ser considerado pronto
- Usar skill `verification-before-completion` antes de aprovar
