---
description: Read a spec file, extract referenced docs, plan tasks, and delegate implementation to worker agents
allowed-tools: Read, Bash, Task, spawn_agent, search, active_agents, list_agents, ask_user, stop_agent
argument-hint: [spec-file-path]
model: sonnet
---

# Purpose

Implement a feature from a spec file. This command reads the spec thoroughly, reads all referenced documents (reports, other specs, pattern references), creates a structured task plan, and delegates implementation to worker agents. Workers receive the spec file path and read it themselves — they are never given pre-digested instructions.

## Variables

SPEC_PATH: $ARGUMENTS

## Instructions

- You are a coordinator. Your job is to understand the spec, plan the work, and delegate to worker agents.
- NEVER write implementation code yourself. All implementation is done by worker agents.
- NEVER summarize the spec for workers. Always pass them the spec file path and instruct them to read it in full.
- Read every referenced document mentioned in the spec before planning.
- Create granular, well-scoped tasks — each task should be completable by a single worker agent.
- Group tasks logically (e.g., by component, by layer, by dependency order).
- Respect dependency ordering: foundational components before consumers.
- If the spec has a migration checklist or required changes summary, use it as the basis for task decomposition.
- If anything in the spec is ambiguous or has open questions, ask the user before proceeding.

## Workflow

1. **Read the spec file**
   - Read `SPEC_PATH` in full using the Read tool.
   - If the file does not exist or is empty, stop and inform the user.

2. **Extract and read all references**
   - Scan the spec content for referenced documents: relative paths, markdown links, "Related report", "Pattern reference", "See also" sections.
   - Read each referenced document in full. If a reference cannot be found, note it and continue.
   - Build a mental model of the full context: architecture, patterns, constraints, dependencies.

3. **Analyze the spec**
   - Identify all components to implement (files to create, files to modify).
   - Identify the dependency order between components.
   - Identify external dependencies (npm packages, config changes).
   - Note any open questions or ambiguities from the spec.

4. **Ask for clarification if needed**
   - If the spec has open questions or ambiguities that block planning, ask the user using ask_user.
   - If there are no blockers, proceed directly.

5. **Create the task plan**
   - Use `task bulk_create` with the text parameter to create all tasks at once.
   - Structure as groups with child tasks. Example grouping:
     - Dependencies & setup (package.json changes, npm install)
     - Core components (in dependency order: configs → client → manager → detector)
     - Tool definitions (one per tool)
     - Integration (registration, hooks, session wiring)
     - Commands & UI (slash commands, status bar)
     - Verification (npm run check, manual testing notes)
   - Each task title should be specific and reference the target file or component.
   - Each task description must include:
     - The spec file path to read
     - Which section(s) of the spec are relevant
     - What specifically to implement
     - Acceptance criteria
   - Assign all implementation tasks to `agent`.

6. **Present the plan to the user**
   - Show the task tree using `task tree`.
   - Wait for user confirmation before proceeding.
   - If the user requests changes, update tasks accordingly.

7. **Execute tasks via worker agents**
   - Start tasks one at a time (or in parallel when tasks have no dependencies).
   - For each task, spawn a worker agent with a task description that:
     - Tells the worker to read the spec file at `SPEC_PATH` in full
     - References the specific section(s) relevant to their task
     - States the concrete deliverable
     - Does NOT include pre-digested code or instructions from the spec
   - Example worker task format:
     ```
     Read the spec file at {SPEC_PATH} in full.
     Then implement the component described in Section {N}: {section_name}.
     
     Your deliverable: Create {file_path} implementing {component_name}.
     
     After implementation, run: npm run check
     Fix any errors before completing.
     ```
   - Monitor agent completion and handle failures.

8. **Verify completion**
   - After all workers finish, run `npm run check` to verify the full build.
   - If there are errors, create follow-up tasks to fix them.
   - Archive completed tasks with `task archive`.

## Report

After execution, provide:
- Summary of what was implemented (files created/modified)
- Any tasks that failed or need manual attention
- Any open questions from the spec that were deferred
- Next steps or recommendations (e.g., manual testing, cleanup of old extension files)
