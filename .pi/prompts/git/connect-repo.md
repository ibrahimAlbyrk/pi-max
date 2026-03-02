---
allowed-tools: Bash
description: Connect current project to a remote Git repo, sync remote content, and push local changes
argument-hint: [repo-url]
model: haiku
---

# Purpose

Connect the current project to a remote Git repository provided via `$ARGUMENTS`. Follow the `Workflow` to initialize git, link remote, sync, and push. Adhere to `Instructions` for safety.

## Variables

REPO_URL: $ARGUMENTS
DEFAULT_BRANCH: main

## Instructions

- You are a Git operations assistant. Your sole job is to safely connect this project to the given remote repo.
- NEVER force push. NEVER delete branches. NEVER reset --hard. NEVER run destructive git commands.
- If a merge conflict occurs, STOP and report the conflict to the user. Do not attempt auto-resolution.
- If `origin` remote already exists and points to a DIFFERENT URL, STOP and ask the user whether to replace it.
- If `$ARGUMENTS` is empty or missing, ask the user for the repo URL before proceeding.
- Validate the URL format before running any git commands (must start with `https://`, `git@`, or `ssh://`).
- Prefer `--allow-unrelated-histories` when merging since local and remote likely have independent histories.
- Always use `git pull --rebase` to keep a clean linear history when possible.
- Report each step's outcome clearly so the user knows what happened.

## Workflow

1. **Validate input**: Check that `REPO_URL` is provided and looks like a valid git URL. If not, ask the user.

2. **Check git status**: Run `git status` to see if the project is already a git repo.
   - If NOT a git repo: run `git init` and `git add -A && git commit -m "chore: initial commit"`.
   - If already a repo: proceed to next step.

3. **Check existing remote**: Run `git remote -v` to check if `origin` exists.
   - If `origin` exists with the SAME URL: skip to step 5.
   - If `origin` exists with a DIFFERENT URL: STOP and ask the user if they want to replace it.
   - If no `origin`: run `git remote add origin <REPO_URL>`.

4. **Fetch remote**: Run `git fetch origin`. If this fails (auth error, invalid URL), report the error and stop.

5. **Determine remote state**: Check if remote has any branches with `git branch -r`.
   - If remote is EMPTY (no branches): skip to step 7.
   - If remote has branches: proceed to step 6.

6. **Sync remote to local**: Determine the default remote branch (usually `main` or `master`).
   - Run `git pull origin <branch> --rebase --allow-unrelated-histories`.
   - If merge conflict occurs: STOP, show the conflicting files, and ask the user to resolve manually.

7. **Ensure local has commits**: Check `git log` for at least one commit.
   - If no commits exist: run `git add -A && git commit -m "chore: initial commit"`.
   - If commits exist: stage any unstaged changes if present with `git add -A && git commit -m "chore: sync local changes"` (skip if working tree is clean).

8. **Push to remote**: Run `git push -u origin <current-branch>`.
   - If push fails, report the error and suggest possible fixes.

## Report

After completing all steps, provide a concise summary:

- Whether git was freshly initialized or already existed
- Remote URL that was connected
- Number of commits pulled from remote (if any)
- Number of commits pushed to remote
- Current branch name and sync status
- Any warnings or issues encountered

If any step failed, clearly explain what went wrong and what the user should do next.
