# Codex Skills on MacBook

This repo carries a portable snapshot of the local non-system Codex skills from this Windows machine under:

```text
codex/skills-local/
```

Excluded from the snapshot:

- `.system` — bundled by Codex
- `gstack` — installed from `https://github.com/garrytan/gstack.git`
- `codex-primary-runtime` — empty local placeholder
- `napkin` — empty local placeholder

## Install

On the MacBook:

```bash
~/.codex/jarvis-cortex/scripts/install-codex-skills.sh
```

What it does:

- copies the exported local skills into `~/.codex/skills`
- installs/updates `karpathy-guidelines` and the Karpathy Codex plugin wrapper
- clones/updates gstack into `~/.codex/skills/gstack`
- runs `./setup --host codex --no-prefix` for gstack when `bun` is installed

If gstack setup is skipped:

```bash
curl -fsSL https://bun.sh/install | bash
cd ~/.codex/skills/gstack
./setup --host codex --no-prefix
```

## Update Later

```bash
cd ~/.codex/jarvis-cortex
git pull
./scripts/install-codex-skills.sh
```

Restart Codex after installing or updating skills.
