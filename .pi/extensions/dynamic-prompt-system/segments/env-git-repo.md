---
id: env-git-repo
layer: 1
priority: 4
conditions:
  - file_exists: .git/HEAD
---
# Git Context

- Use `git branch --show-current` to check active branch
- `git status` before committing
- Respect .gitignore when searching
- Use `git diff --stat` for overview before detailed diff
- Use `git log --oneline -n 10` for recent history
- Always confirm before force push or destructive operations
- Prefer `git stash` over discarding changes
