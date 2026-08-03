---
name: instinct-system
description: Sistema de aprendizado por instintos atomicos. Extrai padroes de sessoes, armazena como YAML com confidence scoring, e evolui em skills reutilizaveis.
origin: ECC (continuous-learning-v2), adaptado para JARVIS
version: 1.0.0
---

# Instinct System — Aprendizado Atomico

Sistema que transforma sessoes do JARVIS em conhecimento reutilizavel atraves de "instintos" — comportamentos aprendidos pequenos, atomicos e com score de confianca.

## Quando Ativar

- Ao final de sessoes produtivas (hook Stop sinaliza automaticamente)
- Quando o dono corrigir uma abordagem (criar instinto da correcao)
- Quando um padrao se repetir 2+ vezes entre sessoes
- Para revisar e evoluir instintos existentes

## O Modelo de Instinto

Um instinto e um comportamento aprendido atomico:

```yaml
---
id: nome-kebab-case
trigger: "quando [situacao especifica]"
confidence: 0.7
domain: "code-style|testing|git|debugging|workflow|architecture|security"
source: "session-observation|user-correction|pattern-detection"
created: "2026-03-27"
updated: "2026-03-27"
---

# Titulo do Instinto

## Acao
O que fazer quando o trigger ativa.

## Evidencia
- Observacao 1 que justifica o instinto
- Observacao 2
```

### Propriedades

- **Atomico**: um trigger, uma acao. Nao misturar.
- **Confidence**: 0.3 (tentativo) a 0.9 (quase certo)
- **Domain-tagged**: facilita busca e clustering
- **Evidence-backed**: sempre registrar o que criou o instinto
- **Datado**: created + updated para tracking de relevancia

### Regras de Confidence

| Evento | Efeito |
|--------|--------|
| Nova observacao (primeira vez) | 0.3 |
| Confirmado 2x em sessoes diferentes | 0.5 |
| Confirmado 3x+ | 0.7 |
| Correcao explicita do dono | 0.8 |
| Multiplas correcoes na mesma direcao | 0.9 |
| Contradito por nova evidencia | -0.2 |
| Abaixo de 0.2 | Remover (auto-prune) |

## Storage

```
active/instincts/
  personal/          — instintos pessoais do JARVIS
  inherited/         — instintos importados de outros repos/times
```

## Fluxo de Trabalho

### 1. Deteccao (automatico via hook Stop)

Ao final de sessao longa (10+ mensagens), o hook sinaliza para extrair padroes.
O JARVIS deve entao:

1. Revisar a sessao em busca de:
   - **Correcoes do usuario** -> instinto com confidence 0.8
   - **Resolucoes de erro** -> instinto com confidence 0.5
   - **Workflows repetidos** -> instinto com confidence 0.5
   - **Decisoes arquiteturais** -> instinto com confidence 0.7

2. Para cada padrao detectado:
   - Verificar se ja existe instinto similar em `active/instincts/`
   - Se sim: incrementar confidence e adicionar evidencia
   - Se nao: criar novo instinto com confidence inicial

### 2. Revisao (manual ou periodica)

Periodicamente revisar instintos:
- Remover os abaixo de 0.2
- Promover os acima de 0.8 para regras em `active/rules/` se forem universais
- Agrupar instintos relacionados para candidatos a evolucao

### 3. Evolucao (sob demanda)

Quando instintos relacionados se acumulam, clusterizar em:

| Tipo | Quando | Exemplo |
|------|--------|---------|
| **Skill** | Comportamentos auto-triggered com 2+ instintos | `testing-workflow` |
| **Regra** | Convencoes universais com confidence >= 0.8 | `always-validate-input` |
| **Pipeline** | Processos multi-step com 3+ instintos | `debug-sequence` |

## Padroes a Detectar

| Padrao | Descricao | Confidence Inicial |
|--------|-----------|-------------------|
| `user-correction` | o dono corrigiu abordagem do JARVIS | 0.8 |
| `error-resolution` | Erro resolvido com tecnica especifica | 0.5 |
| `repeated-workflow` | Mesma sequencia de acoes 2+ vezes | 0.5 |
| `architecture-decision` | Decisao de design explicita | 0.7 |
| `tool-preference` | Preferencia por tool/approach especifico | 0.5 |

## Padroes a Ignorar

- Typos simples
- Fixes one-time de APIs externas
- Problemas de rede/infra transitorios
- Detalhes de sessao efemeros

## Integracao com JARVIS

- **Napkin**: instintos de alta confianca podem ser promovidos para o napkin
- **Memory**: instintos universais podem virar feedback memories
- **Rules**: instintos com confidence >= 0.9 sao candidatos a regras em `active/rules/`
- **Orchestrate**: instintos de workflow alimentam pipelines custom

## Dicas

1. **Qualidade > quantidade** — poucos instintos precisos valem mais que muitos vagos
2. **Trigger especifico** — "quando criar componente React" > "quando programar"
3. **Acao concreta** — "usar useState com lazy init" > "usar boas praticas"
4. **Evidence real** — citar sessao/data, nao inventar
5. **Revisar mensalmente** — prunar os fracos, promover os fortes
