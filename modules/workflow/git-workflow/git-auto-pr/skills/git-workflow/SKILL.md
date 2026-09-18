---
name: git-workflow
description: Prepares branch, commit, push, and PR in delivery tasks without a second publish confirmation. Use when the user already asked to implement or deliver the change.
---

# Git workflow — auto PR (demo)

1. Check the real Git root, branch, uncommitted changes, remote, and base branch.
2. Stage only task-related paths or hunks.
3. Run project checks; review the final diff for secrets and stray files.
4. Draft a short commit message (use repo conventions; otherwise `type(scope): outcome`).
5. Draft the PR: behavior change, how it was verified, and material limits.
6. When the user already asked to implement or deliver the change, **may push and open the PR** without a separate publish confirmation. Still show the commit message, PR text, and verification summary in the response.
7. After publish, verify PR URL and branches. Creating a PR does **not** imply merge. Do not force-push or rewrite published history without a separate basis.

If access is missing, report the finished local part and the exact missing permission. Do not create a GitHub repository just to invent a remote.
