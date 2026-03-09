---
name: dps/env-git-repo
description: Git repository workflow guidance
version: 1
dps:
  layer: 1
  priority: 4
  conditions:
    - file_exists: .git/HEAD
variables:
  - name: GIT_BRANCH
    type: string
    required: false
    default: "N/A"
---
## Git Context

{{#if GIT_BRANCH != "N/A"}}
Current branch: `{{GIT_BRANCH}}`
{{/if}}

- Use `git branch --show-current` to verify the active branch before making changes
- Run `git status` before committing to review staged and unstaged changes
- Track which files you created/modified/deleted during the session
- Commit only files you created or modified — never use `git add -A` or `git add .`
- Use `git add <specific-file-paths>` to stage only your changes
- Include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- Pull with rebase before pushing: `git pull --rebase && git push`

### Forbidden Git Operations

These can destroy other agents' work or bypass required checks:
- `git reset --hard` — destroys uncommitted changes
- `git checkout .` — destroys uncommitted changes
- `git clean -fd` — deletes untracked files
- `git stash` — stashes ALL changes including other agents' work
- `git add -A` / `git add .` — stages other agents' uncommitted work
- `git commit --no-verify` — bypasses required checks, never allowed
- force-push — never allowed

### Safe Commit Workflow

```bash
# 1. Check status — verify only your files appear
git status

# 2. Stage ONLY your specific files
git add packages/foo/src/bar.ts
git add packages/foo/CHANGELOG.md

# 3. Commit with issue reference if applicable
git commit -m "fix(foo): description closes #123"

# 4. Push (pull --rebase if needed)
git pull --rebase && git push
```

### Rebase Conflict Handling

- Resolve conflicts only in files YOU modified during this session
- If a conflict is in a file you did not modify, abort the rebase and ask the user
- Never force-push to resolve conflicts
