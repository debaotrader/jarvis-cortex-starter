---
name: dead-code-audit
description: Use when auditing a software project for unused components, orphaned UI, unused imports, dead functions, stale state variables, unexplained commented code, or when the user asks for cleanup/refactor tasks before removing code.
---

# Dead Code Audit

Auditoria de codigo morto com foco em evidencia, baixo falso positivo e plano de refatoracao acionavel. Primeiro diagnostica e sugere. So remove codigo quando o usuario pedir uma etapa de implementacao.

## Quando usar

Use esta skill quando o pedido mencionar:

- componentes criados mas nunca renderizados
- funcoes declaradas mas nunca chamadas
- imports nao utilizados
- variaveis de estado que nunca mudam ou nunca sao lidas
- codigo comentado sem explicacao
- limpeza, refactor, poda, dead code, unused code, orphan components
- montar tarefas/subtarefas de remocao ou refatoracao

## Regra central

Nao trate "sem resultado no `rg`" como prova suficiente. Frameworks usam convencoes, entrypoints, reflection, imports dinamicos, rotas por arquivo, scripts de build e APIs publicas. Cada sugestao de remocao precisa ter evidencia e risco.

## Fluxo

### 1. Snapshot

- Rode `git status --short` quando houver repo Git.
- Identifique stack e ferramentas: `package.json`, `tsconfig`, config de lint/build/test, roteador, framework, monorepo.
- Preserve mudancas do usuario. Auditoria nao deve reverter nem formatar arquivos.

### 2. Inventario

Mapeie os entrypoints antes de procurar codigo morto:

- UI: rotas, layouts, pages, app router, storybook, exports publicos, lazy imports.
- Backend: handlers, jobs, CLIs, cron, migrations, seeds, controllers.
- Bibliotecas: `exports` em `package.json`, barrel files, tipos publicos, plugin hooks.
- Testes: fixtures, mocks, helpers e factories podem parecer mortos fora da suite.

### 3. Sinais de codigo morto

Procure por categorias separadas:

| Categoria | Como validar | Risco comum |
| --- | --- | --- |
| Import nao usado | Lint/typecheck/IDE ou AST quando disponivel | Import com side effect |
| Componente nunca renderizado | Buscar imports, JSX usage, rotas e lazy imports | File-based routing e storybook |
| Funcao local nunca chamada | Buscar chamadas no escopo e exports | Callback passado por referencia |
| Export nunca importado | Buscar importadores e API publica | Pacote consumido externamente |
| State nunca lido | `const [x, setX] = useState`; verificar leitura de `x` | Setter usado para trigger/re-render |
| Setter nunca chamado | Verificar chamadas diretas e passadas por props | Atualizado por callback externo |
| Codigo comentado | Distinguir explicacao/TODO de bloco morto | Comentario documenta decisao real |

Use ferramentas do projeto primeiro, se existirem:

- JS/TS: `npm run lint`, `npm run typecheck`, `tsc --noEmit`, `knip`, `ts-prune`, `eslint --report-unused-disable-directives`.
- Python: `ruff`, `vulture`, `pyright`, `pytest --collect-only`.
- Go/Rust: compilador, lint e busca de referencias.

Se uma ferramenta nao existir, nao instale dependencias sem necessidade. Use `rg`, leitura de arquivos e configs locais.

### 4. Classificacao

Classifique cada achado:

- `HIGH`: seguro para remover em pequena mudanca isolada.
- `MEDIUM`: provavelmente morto, mas precisa check de framework/teste/API.
- `LOW`: suspeita; nao sugerir remocao direta, sugerir investigacao.

Nao inclua achados sem acao clara. Se o risco for alto demais, coloque em "Nao remover ainda".

### 5. Relatorio

Entregue neste formato:

```markdown
## Dead Code Audit

### Resumo
- [contagem por categoria]
- [areas com maior oportunidade]

### Achados
| Severidade | Arquivo | Simbolo | Evidencia | Sugestao |
| --- | --- | --- | --- | --- |
| HIGH | src/... | FooCard | Definido/exportado, sem importadores encontrados, fora de rotas | Remover componente e teste associado |

### Nao Remover Ainda
| Arquivo | Simbolo | Motivo |
| --- | --- | --- |

### Tarefas de Refatoracao
1. [titulo]
   - Escopo: [arquivos/simbolos]
   - Subtarefas:
     - [passo verificavel]
   - Checks:
     - [comandos relevantes]
   - Risco:
     - [baixo/medio/alto e mitigacao]
```

## Plano de refatoracao

Monte tarefas pequenas, behavior-preserving e ordenadas por risco:

1. Remocoes mecanicas de imports e variaveis locais.
2. Remocoes de funcoes locais nao chamadas.
3. Remocoes de componentes orfaos com teste/build.
4. Remocoes de exports publicos ou arquivos inteiros, apenas com confirmacao de API.
5. Limpeza de comentarios mortos, mantendo comentarios que explicam decisoes.

Cada tarefa deve ter:

- objetivo
- arquivos afetados
- subtarefas
- criterio de aceite
- comandos de verificacao
- rollback simples

## Uso com loop-hermes

Quando o usuario pedir `loop-hermes`, subagentes ou revisao independente:

1. Main agent faz snapshot e identifica stack.
2. Explorer 1 audita componentes/imports/exports.
3. Explorer 2 audita funcoes/state/comentarios.
4. Main agent consolida achados e remove duplicados.
5. Reviewer independente procura falso positivo, entrypoint oculto, API publica e risco de remocao.
6. So entregue como aprovado se o reviewer nao encontrar pendencias. Use `APPROVED_CLEAN` ou liste `REQUEST_CHANGES`.

Se subagentes nao estiverem disponiveis, execute as mesmas fases localmente e marque essa limitacao no relatorio.

## Erros comuns

- Remover arquivo de rota porque ninguem importa explicitamente.
- Remover export de biblioteca sem checar consumidores externos.
- Remover import com side effect.
- Confundir fixture/helper de teste com codigo morto.
- Apagar comentarios explicativos junto com blocos comentados mortos.
- Propor remocao em massa sem tarefas pequenas e verificaveis.
