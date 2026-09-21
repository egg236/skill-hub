---
name: init-project
description: Initializes a new project or attaches selected agent modules to an existing one.
---

# Project init

Determine the target path, whether the project already exists, and which modules are needed.
In an existing project read `AGENTS.md` and manifests. In a new one create only necessary directories; Git and stack init stay inside the request.
If the user uses skill-hub, they must provide a hub checkout; read the hub `README.md` and choose modules by name. Do not invent modules or family variants.
Use the hub helper with `--dry-run`, then apply the final set. If Node.js is unavailable, follow the hub README attach steps.
If the modules catalog is empty, prepare a minimal `AGENTS.md` with project agreements. This is not required for a short init.
Preserve existing instructions and local rules. Do not invent config, project registries, Notion URLs, or credentials.
Remote, Notion, deployment, and product discovery run only inside a matching explicit request.
Summarize the project path, created files, attached modules, and how to verify.
