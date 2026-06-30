---
date: 2026-06-30
tags:
  - decision
  - image-generation
  - composition
---

# Wide-Angle Image Composition Rule

## Context

Vertical 9:16 generated images were cropping subjects and losing the key location context.

## Decision

All BarroTube image prompts should remain vertical 9:16 but request a wide-angle 24mm composition with full body or full key object visible.

## Prompt Rule

```text
Use a wide-angle 24mm lens look inside the vertical 9:16 frame.
Show the full body or full key object, include the surrounding environment,
leave headroom and footroom, no tight close-up, no cropped limbs or props.
```

## Consequences

- Scenes should better preserve location, action, and props.
- Prompts must not ask for horizontal images.
- Contact sheets should be checked for crop failures before Grok generation.
