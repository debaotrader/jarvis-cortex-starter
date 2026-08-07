---
name: orchestrate
description: Orquestracao sequencial de agentes para workflows complexos no JARVIS.
---

# Orchestrate — Pipelines Multi-Agente

Workflow sequencial de agentes com documentos de handoff estruturados entre cada fase.

## Uso

Invocar diretamente como skill ou via delegacao do JARVIS:

```
orchestrate [tipo] [descricao da tarefa]
```

## Tipos de Pipeline

### feature
Pipeline completo de implementacao:
```
brainstorming -> writing-plans -> subagent-driven-development -> requesting-code-review -> verification-loop
```

### bugfix
Pipeline de investigacao e correcao:
```
systematic-debugging -> subagent-driven-development -> requesting-code-review
```

### refactor
Pipeline de refatoracao segura:
```
writing-plans -> subagent-driven-development -> requesting-code-review -> verification-loop
```

### security
Revisao focada em seguranca:
```
verification-loop (security scan) -> requesting-code-review -> writing-plans (remediation)
```

## Padrao de Execucao

Para cada agente no pipeline:

1. **Invocar skill/agente** com contexto do anterior via documento de handoff
2. **Coletar saida** como handoff estruturado
3. **Passar para o proximo** na cadeia
4. **Agregar resultados** em relatorio final

### Regras JARVIS durante execucao

- Sub-agentes NAO tocam em producao (regra inviolavel #2)
- Todo codigo de sub-agente passa por revisao antes de merge (regra #3)
- Credenciais sempre via `.env`, nunca hardcodadas (regra #4)
- Acoes perigosas (commits em master, alteracao de envs) exigem aprovacao do dono (regra #5)

## Formato do Documento de Handoff

Entre fases, criar documento de handoff:

```markdown
## HANDOFF: [fase-anterior] -> [proxima-fase]

### Contexto
[Resumo do que foi feito]

### Descobertas
[Decisoes-chave ou achados]

### Arquivos Modificados
[Lista de arquivos tocados]

### Questoes Abertas
[Itens nao resolvidos para a proxima fase]

### Recomendacoes
[Proximos passos sugeridos]
```

## Exemplo: Pipeline Feature

```
orchestrate feature "Adicionar autenticacao de usuario"
```

Executa:

1. **Brainstorming** (skill `brainstorming`)
   - Explora intencao, requisitos e design
   - Identifica dependencias e riscos
   - Saida: `HANDOFF: brainstorming -> writing-plans`

2. **Planejamento** (skill `writing-plans`)
   - Le handoff do brainstorming
   - Cria plano de implementacao detalhado
   - Define tasks e checkpoints
   - Saida: `HANDOFF: writing-plans -> subagent-driven-development`

3. **Implementacao** (skill `subagent-driven-development`)
   - Le plano e executa via sub-agentes
   - Codigo + testes em iteracao rapida
   - Saida: `HANDOFF: implementation -> requesting-code-review`

4. **Code Review** (skill `requesting-code-review`)
   - Revisa implementacao completa
   - Verifica qualidade, seguranca, regras JARVIS
   - Saida: `HANDOFF: code-review -> verification-loop`

5. **Verificacao** (skill `verification-loop`)
   - Build -> Typecheck -> Lint -> Test -> Security -> Diff Review
   - Gate formal de qualidade
   - Saida: Relatorio Final

## Formato do Relatorio Final

```
RELATORIO DE ORQUESTRACAO
=========================
Pipeline: feature
Tarefa: Adicionar autenticacao de usuario
Fases: brainstorming -> plans -> implementation -> review -> verification

RESUMO
------
[Um paragrafo resumo]

SAIDAS POR FASE
----------------
Brainstorming: [resumo]
Planejamento: [resumo]
Implementacao: [resumo]
Code Review: [resumo]
Verificacao: [resumo]

ARQUIVOS ALTERADOS
------------------
[Lista de todos os arquivos modificados]

RESULTADOS DE TESTES
--------------------
[Resumo pass/fail]

STATUS DE SEGURANCA
-------------------
[Achados de seguranca]

RECOMENDACAO
------------
[SHIP / NEEDS WORK / BLOCKED]
```

## Execucao Paralela

Para checks independentes, rodar agentes em paralelo via `dispatching-parallel-agents`:

```markdown
### Fase Paralela
Executar simultaneamente:
- requesting-code-review (qualidade)
- verification-loop (seguranca + build)

### Mesclar Resultados
Combinar saidas em relatorio unico
```

## Argumentos

- `feature <descricao>` — Pipeline completo de feature
- `bugfix <descricao>` — Pipeline de correcao de bug
- `refactor <descricao>` — Pipeline de refatoracao
- `security <descricao>` — Pipeline de revisao de seguranca
- `custom <skills> <descricao>` — Sequencia customizada de skills

## Exemplo Custom

```
orchestrate custom "writing-plans,subagent-driven-development,requesting-code-review" "Redesenhar camada de cache"
```

## Mapeamento de Skills do JARVIS

| Papel no Pipeline | Skill JARVIS | Quando usar |
|-------------------|-------------|-------------|
| Planner | `brainstorming` + `writing-plans` | Inicio de feature ou refactor |
| Implementer | `subagent-driven-development` | Codigo + testes |
| TDD Guide | `subagent-driven-development` (modo TDD) | Quando TDD aplicavel |
| Code Reviewer | `requesting-code-review` | Antes de merge |
| Security Reviewer | `verification-loop` (fase security) | Auth, pagamento, PII |
| Architect | `writing-plans` (modo arquitetura) | Decisoes estruturais |

## Dicas

1. **Sempre comece com brainstorming** para features novas (regra JARVIS)
2. **Sempre inclua code-review** antes de qualquer merge
3. **Use verification-loop** como gate final — nao pule
4. **Mantenha handoffs concisos** — foque no que a proxima fase precisa
5. **Delegue implementacao** para sub-agentes, revise o diff depois
