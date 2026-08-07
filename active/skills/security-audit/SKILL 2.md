---
name: security-audit
description: Auditoria de seguranca do setup JARVIS e dos projetos. Verifica configs, hooks, MCP, secrets, e codigo em busca de vulnerabilidades.
origin: ECC (security-scan + security-review + rules/common/security), adaptado para JARVIS
version: 1.0.0
---

# Security Audit — Auditoria de Seguranca JARVIS

Skill para auditar a seguranca do setup JARVIS e dos projetos ativos.
Sem dependencias externas — usa apenas ferramentas nativas do Claude Code.

## Quando Ativar

- Apos modificar `settings.json`, `CLAUDE.md`, hooks ou MCP configs
- Antes de commitar mudancas de configuracao
- Ao importar componentes externos (ECC, plugins, MCP servers)
- Periodicamente como higiene de seguranca
- Quando tocar em auth, pagamento ou dados sensíveis no seus projetos

## Auditoria em 2 Camadas

### Camada 1: Setup JARVIS (configs do agente)

Verificar todos os itens abaixo:

#### 1.1 CLAUDE.md e Rules
- [ ] Sem secrets hardcodados (API keys, tokens, passwords)
- [ ] Sem instrucoes de auto-run perigosas (execucao automatica sem gate)
- [ ] Sem patterns de prompt injection (instrucoes que overridam regras)
- [ ] Regras inviolaveis presentes e integras

#### 1.2 settings.json
- [ ] Sem permissoes wildcard excessivas (`Bash(*)`)
- [ ] Sem bypass flags perigosos (`skipDangerousModePermissionPrompt` — avaliar necessidade)
- [ ] Hooks apontam para scripts existentes e confiaveis
- [ ] Sem secrets no customSystemPrompt

#### 1.3 MCP Servers
- [ ] Sem secrets hardcodados nos args
- [ ] Sem `npx -y` com pacotes nao-confiaveis (supply chain risk)
- [ ] Servers conhecidos e com proposito documentado
- [ ] Sem shell-running servers sem restricao

#### 1.4 Hooks
- [ ] Sem command injection via interpolacao (`${file}`, `$FILENAME`)
- [ ] Sem exfiltracao de dados (curl/wget para URLs externas)
- [ ] Sem supressao silenciosa de erros (`2>/dev/null`, `|| true` sem motivo)
- [ ] Scripts existem nos paths referenciados

#### 1.5 Instintos e Skills Importados
- [ ] Instintos herdados revisados antes de ativar
- [ ] Skills do vendor nao executam codigo sem revisao
- [ ] Nenhum componente importado altera regras inviolaveis

### Camada 2: Codigo do Projeto (seus projetos)

#### 2.1 Secrets
- [ ] Sem API keys, tokens ou passwords hardcodados no codigo
- [ ] Todos os secrets em `.env` ou gerenciador de secrets
- [ ] `.env` no `.gitignore`
- [ ] Secrets de producao no hosting (nunca no repo)
- [ ] Validacao de secrets obrigatorios no startup

#### 2.2 Input Validation
- [ ] Inputs do usuario validados com schemas (Zod, Joi, etc)
- [ ] File uploads restritos (tamanho, tipo, extensao)
- [ ] Sem uso direto de input em queries
- [ ] Validacao whitelist (nao blacklist)
- [ ] Mensagens de erro nao vazam info interna

#### 2.3 Injection Prevention
- [ ] SQL: queries parametrizadas, sem concatenacao
- [ ] XSS: conteudo do usuario sanitizado (DOMPurify)
- [ ] Command injection: sem interpolacao de input em shell commands
- [ ] CSRF: tokens em operacoes que mudam estado

#### 2.4 Auth & Authorization
- [ ] Tokens em httpOnly cookies (nao localStorage)
- [ ] Authorization checks antes de operacoes sensiveis
- [ ] Row Level Security ativo no Supabase (se aplicavel)
- [ ] RBAC implementado corretamente

#### 2.5 Data Exposure
- [ ] Sem passwords/tokens/secrets em logs
- [ ] Error messages genericas para o usuario
- [ ] Stack traces apenas em logs server-side
- [ ] Dados sensiveis redactados em logging

#### 2.6 Dependencies
- [ ] `npm audit` limpo (sem vulnerabilidades criticas)
- [ ] Lock files commitados
- [ ] Dependencias atualizadas regularmente

## Formato do Relatorio

```
SECURITY AUDIT REPORT
=====================
Data: YYYY-MM-DD
Escopo: [JARVIS Setup | Projeto X | Ambos]

GRADE: [A|B|C|D|F]

ACHADOS CRITICOS (corrigir imediatamente)
------------------------------------------
- [descricao] → [acao corretiva]

ACHADOS ALTOS (corrigir antes de producao)
-------------------------------------------
- [descricao] → [acao corretiva]

ACHADOS MEDIOS (recomendado)
-----------------------------
- [descricao] → [acao corretiva]

ACHADOS INFORMATIVOS (awareness)
----------------------------------
- [descricao]

RESUMO
------
Total: X achados (Y criticos, Z altos)
Recomendacao: [SEGURO | PRECISA ATENCAO | BLOQUEADO]
```

## Grades

| Grade | Score | Significado |
|-------|-------|-------------|
| A | 90-100 | Configuracao segura |
| B | 75-89 | Problemas menores |
| C | 60-74 | Precisa de atencao |
| D | 40-59 | Riscos significativos |
| F | 0-39 | Vulnerabilidades criticas |

## Protocolo de Resposta a Incidente

Se encontrar vulnerabilidade critica:

1. **PARE** imediatamente
2. **ISOLE** — nao commitar, nao fazer push
3. **CORRIJA** o achado critico
4. **ROTACIONE** secrets que possam ter sido expostos
5. **REVISE** codebase inteira para problemas similares
6. **REGISTRE** como instinto de seguranca para prevenir reincidencia

## Integracao com JARVIS

- **verification-loop**: a fase Security do loop usa este checklist
- **orchestrate**: pipeline `security` invoca esta skill como primeira fase
- **instinct-system**: achados recorrentes viram instintos de seguranca
- **regras inviolaveis**: regra #4 (nunca hardcodar credenciais) reforçada aqui

## Dicas

1. **Camada 1 primeiro** — auditar o proprio JARVIS antes de auditar projetos
2. **Rodar apos imports** — cada componente novo do ECC deve ser auditado
3. **Nao confiar em defaults** — verificar mesmo o que "parece seguro"
4. **Secrets sao criticos** — um secret vazado invalida toda a seguranca
5. **Automatizar o que puder** — regra #4 reforçada por hooks e instintos
