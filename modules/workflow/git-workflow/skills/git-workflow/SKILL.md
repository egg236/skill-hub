---
name: git-workflow
description: Prepares branch, commit, and PR with an explicit confirmation before push/publish. Use for delivering changes through Git.
---

# Git workflow (demo)

1. Check the real Git root, branch, uncommitted changes, remote, and base branch.
2. Stage only task-related paths or hunks.
3. Run project checks; review the final diff for secrets and stray files.
4. Draft a short commit message (use repo conventions; otherwise `type(scope): outcome`).
5. Draft the PR: behavior change, how it was verified, and material limits.
6. **Before push / opening the PR**, show the ready result and get an explicit publish confirmation if it was not already given for this PR.
7. After allowed publish, verify PR URL and branches. Creating a PR does **not** imply merge.

If access is missing, report the finished local part and the exact missing permission. Do not create a GitHub repository just to invent a remote.
