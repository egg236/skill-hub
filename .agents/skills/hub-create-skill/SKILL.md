---
name: hub-create-skill
description: Adds or changes a portable skill in a selected skill-hub module.
---

# Create a skill in the hub

Read `README.md` for the module contract and `modules/authoring/skill-authoring/skills/create-skill/SKILL.md` for skill writing.
Decide purpose and the right module; create a new module when the capability should attach separately.
Get module paths with `node scripts/hub.mjs list`. Save the skill and its resources under `<module-folder>/skills/<name>`. Place a new module in `modules/<group>/<id>`, family variants in `modules/<group>/<family>/<id>`. Do not copy into the hub `.agents/skills`.
Check that instructions and relative links stand alone. Run `node scripts/hub.mjs validate` and a realistic usage example.
