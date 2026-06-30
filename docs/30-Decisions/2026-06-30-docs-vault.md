---
date: 2026-06-30
tags:
  - decision
  - docs
  - obsidian
---

# Create BarroSkills Docs Vault

## Context

BarroSkills needs persistent documentation for skill operation, channel strategy, and content decisions.

## Decision

Use `/Users/beye/workspace/BarroSkills/docs` as an Obsidian-compatible vault inside the BarroSkills repository.

## Consequences

- Channel operation notes live beside the skills they support.
- The folder can be opened directly in Obsidian.
- Git can version docs with the skill code.
- Secrets must stay outside the vault.
