# Codex MCPs on MacBook

MCPs currently configured on this Windows Codex install:

| Name | Transport | Install command | Secret needed |
| --- | --- | --- | --- |
| `n8n` | stdio | `npx -y n8n-mcp-server@0.1.0` | `N8N_API_KEY`, `N8N_API_URL` |
| `TestSprite` | stdio | `npx -y @testsprite/testsprite-mcp@0.0.37` | `TESTSPRITE_API_KEY` |
| `MetaAds` | streamable HTTP | `https://mcp.facebook.com/ads` | OAuth login via `codex mcp login MetaAds` |

Do not copy `~/.codex/config.toml` between machines. It can contain local paths and API keys.

## Install

On the MacBook:

```bash
read -rsp "N8N key: " N8N_API_KEY; echo
export N8N_API_URL="https://n8n.example.com/api/v1"
read -rsp "TestSprite key: " TESTSPRITE_API_KEY; echo
export N8N_API_KEY TESTSPRITE_API_KEY

~/.codex/jarvis-cortex/scripts/install-codex-mcps.sh
```

For Meta Ads OAuth:

```bash
codex mcp login MetaAds
```

Verify:

```bash
codex mcp list
codex mcp get n8n
codex mcp get TestSprite
codex mcp get MetaAds
```

The CLI masks secrets as `*****` when listing MCPs.
