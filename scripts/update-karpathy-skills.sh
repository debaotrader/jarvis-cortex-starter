#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
MARKETPLACE_NAME="karpathy-skills"
PLUGIN_NAME="andrej-karpathy-skills"
REPO_SPEC="forrestchang/andrej-karpathy-skills"
REPO_URL="https://github.com/forrestchang/andrej-karpathy-skills"
CONFIG_PATH="$CODEX_HOME/config.toml"
MARKETPLACE_ROOT="$CODEX_HOME/.tmp/marketplaces/$MARKETPLACE_NAME"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found in PATH." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found in PATH." >&2
  exit 1
fi

mkdir -p "$CODEX_HOME"
touch "$CONFIG_PATH"

if grep -q '^\[marketplaces\.karpathy-skills\]' "$CONFIG_PATH"; then
  codex plugin marketplace upgrade "$MARKETPLACE_NAME"
else
  codex plugin marketplace add "$REPO_SPEC" --ref main
fi

python3 - "$CODEX_HOME" "$MARKETPLACE_ROOT" "$CONFIG_PATH" "$MARKETPLACE_NAME" "$PLUGIN_NAME" "$REPO_URL" <<'PY'
import json
import os
import pathlib
import shutil
import sys

codex_home = pathlib.Path(sys.argv[1]).expanduser().resolve()
marketplace_root = pathlib.Path(sys.argv[2]).expanduser().resolve()
config_path = pathlib.Path(sys.argv[3]).expanduser().resolve()
marketplace_name = sys.argv[4]
plugin_name = sys.argv[5]
repo_url = sys.argv[6]

upstream_manifest_path = marketplace_root / ".claude-plugin" / "plugin.json"
if not upstream_manifest_path.exists():
    raise SystemExit(f"Upstream Claude plugin manifest not found: {upstream_manifest_path}")

with upstream_manifest_path.open("r", encoding="utf-8") as fh:
    upstream = json.load(fh)

version = str(upstream.get("version") or "1.0.0")
description = str(upstream.get("description") or "Behavioral guidelines to reduce common LLM coding mistakes.")
license_name = str(upstream.get("license") or "MIT")
author = upstream.get("author") or {}
author_name = str(author.get("name") or "forrestchang")
keywords = upstream.get("keywords") or []

cache_root = codex_home / "plugins" / "cache" / marketplace_name
plugin_family_root = cache_root / plugin_name
plugin_root = plugin_family_root / version
plugin_skills_root = plugin_root / "skills"
standalone_skills_root = codex_home / "skills"

def ensure_under(path: pathlib.Path, parent: pathlib.Path) -> None:
    path = path.resolve()
    parent = parent.resolve()
    if path != parent and parent not in path.parents:
        raise SystemExit(f"Refusing to operate outside expected directory: {path}")

cache_root.mkdir(parents=True, exist_ok=True)
ensure_under(cache_root, codex_home / "plugins" / "cache")

if plugin_family_root.exists():
    ensure_under(plugin_family_root, cache_root)
    shutil.rmtree(plugin_family_root)

(plugin_root / ".codex-plugin").mkdir(parents=True, exist_ok=True)
plugin_skills_root.mkdir(parents=True, exist_ok=True)
standalone_skills_root.mkdir(parents=True, exist_ok=True)

skill_entries = upstream.get("skills") or ["./skills/"]
if isinstance(skill_entries, str):
    skill_entries = [skill_entries]

copied_skill_names = []
for entry in skill_entries:
    normalized = str(entry)
    if normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = normalized.strip("/")
    source = marketplace_root.joinpath(*normalized.split("/"))
    if not source.exists():
        raise SystemExit(f"Skill path from upstream manifest was not found: {source}")

    if source.is_dir():
        skill_name = source.name
        plugin_target = plugin_skills_root / skill_name
        standalone_target = standalone_skills_root / skill_name
        shutil.copytree(source, plugin_target, dirs_exist_ok=True)
        shutil.copytree(source, standalone_target, dirs_exist_ok=True)
    else:
        skill_name = source.stem
        plugin_target = plugin_skills_root / skill_name
        standalone_target = standalone_skills_root / skill_name
        plugin_target.mkdir(parents=True, exist_ok=True)
        standalone_target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, plugin_target / "SKILL.md")
        shutil.copy2(source, standalone_target / "SKILL.md")

    copied_skill_names.append(skill_name)

if not list(plugin_skills_root.rglob("SKILL.md")):
    raise SystemExit(f"No SKILL.md files were copied into plugin cache: {plugin_root}")

codex_manifest = {
    "name": plugin_name,
    "version": version,
    "description": description,
    "author": {
        "name": author_name,
        "url": "https://github.com/forrestchang",
    },
    "homepage": repo_url,
    "repository": repo_url,
    "license": license_name,
    "keywords": keywords,
    "skills": "./skills/",
    "interface": {
        "displayName": "Andrej Karpathy Skills",
        "shortDescription": "Coding-agent guidelines for simpler, verified changes.",
        "longDescription": "Behavioral guidelines for coding agents: think before coding, keep implementations simple, make surgical changes, and define verifiable success criteria.",
        "developerName": author_name,
        "category": "Engineering",
        "capabilities": ["Write"],
        "websiteURL": repo_url,
        "privacyPolicyURL": f"{repo_url}/blob/main/README.md",
        "termsOfServiceURL": f"{repo_url}/blob/main/README.md",
        "defaultPrompt": ["Use Karpathy guidelines for this coding task."],
        "brandColor": "#111827",
        "screenshots": [],
    },
}

manifest_path = plugin_root / ".codex-plugin" / "plugin.json"
with manifest_path.open("w", encoding="utf-8") as fh:
    json.dump(codex_manifest, fh, indent=2)
    fh.write("\n")

plugin_header = f'[plugins."{plugin_name}@{marketplace_name}"]'
config_text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
if plugin_header not in config_text:
    block = f'{plugin_header}\nenabled = true\n\n'
    marker = "\n[marketplaces."
    marker_index = config_text.find(marker)
    if marker_index >= 0:
        config_text = config_text[: marker_index + 1] + block + config_text[marker_index + 1 :]
    else:
        config_text = config_text.rstrip() + "\n\n" + block
    config_path.write_text(config_text, encoding="utf-8")

print(f"Updated {plugin_name}@{marketplace_name}")
print(f"Version: {version}")
print(f"Skills: {', '.join(copied_skill_names)}")
print(f"Plugin cache: {plugin_root}")
print(f"Standalone skills: {standalone_skills_root}")
PY
