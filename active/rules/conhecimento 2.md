# Controle de Conhecimento

## Jarvis Brain (Conhecimento Duravel)

- **Root:** `JARVIS_BRAIN_HOME`, depois `graphifyBrainPath` no `config.json`
  local, depois `~/.jarvis/brain`.
- **Consulta primaria:** MCP oficial `graphify-brain`.
- **Fallback:** `graphify query|path|explain --graph
  "${JARVIS_BRAIN_HOME:-$HOME/.jarvis/brain}/graphify-out/graph.json"`.
- **Fonte canonica:** Markdown do Brain. `graphify-out/` e derivado.
- **Contexto sob demanda:** nunca leia o Brain inteiro; consulte o grafo e abra
  somente os arquivos citados.

## Fronteiras

- Claude-mem: memoria episodica de sessoes Claude Code.
- `memory/`: curadoria pequena do Cortex e ponteiros locais.
- Jarvis Brain: conhecimento duravel entre projetos.
- Repositorio do projeto e runtime vivo: autoridade sobre codigo, deploy e
  estado operacional atual.

## Projetos

O registro duravel de projetos vive em `~/.jarvis/brain/projects/README.md`.
Nao mantenha uma segunda lista estatica no Cortex.

## Contextos Switchaveis
Disponiveis em `active/contexts/`:
- `dev.md` — modo desenvolvimento (codigo primeiro, explicacao depois)
- `review.md` — modo code review (qualidade, seguranca, manutencao)
