---
name: hub-modules
description: Attaches, detaches, updates, and switches skill-hub modules in a target project.
---

# Hub modules

Read the hub `README.md` and determine the exact target project folder.
Get the catalog with `node scripts/hub.mjs list`, the current set with `status`, and the project `.agents/skill-hub.lock.json`.
Turn the request into a full final ID set: when adding or replacing, keep every other attached module.
Pick only one variant per family. If preference is unset and changes behavior, ask briefly.
Run `apply <project> <full set> --dry-run`, review operations, then apply the allowed change. To detach everything use `--none`.
