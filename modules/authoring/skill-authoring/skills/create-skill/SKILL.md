---
name: create-skill
description: Creates or updates a portable skill from a described recurring task.
---

# Create skill

Clarify purpose, trigger conditions, expected result, and target folder from the request and current project.
Create `<name>/SKILL.md`. Name: lowercase-kebab-case, at most 64 characters. YAML frontmatter must include `name` and a short `description` with usage conditions.
In the body keep only context and solution steps a model can follow alone: inputs, required actions, limits, and result.
Keep the skill self-contained: put required resources next to the skill. Mention external docs explicitly; use other skills only when present and with a working link.
Add `scripts` for repeatable mechanics, `references` for dense notes, `assets` for real templates. Skip empty folders.
Do not turn a simple example into a universal approval gate. Keep task boundaries and user permissions.
Validate frontmatter, links, and completeness with a realistic case. Run any script in a safe prepared folder.

In skill-hub place new skills under `<module-folder>/skills/<name>`; discover modules with `node scripts/hub.mjs list`. New modules go in `modules/<group>/<id>`, family variants in `modules/<group>/<family>/<id>`, with `module.json` per hub contract.
In an ordinary project use the agreed skills folders; the hub itself is not required for this skill to work.
