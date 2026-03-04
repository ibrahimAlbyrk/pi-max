<p align="center">
  <a href="https://pi.dev">
    <img src=".github/assets/pi-banner.png" alt="pi" width="100%" />
  </a>
</p>

<p align="center">
  <strong>Tools for building AI agents and managing LLM deployments.</strong>
</p>

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="28" style="vertical-align: middle;" /> exe.dev</a>
</p>

---

> **Looking for the pi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-mom](packages/mom)** | Slack bot that delegates messages to the pi coding agent |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/pi-pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Built-in Systems

<table>
<tr>
<td width="50%" valign="top">

### Code Intelligence
**[LSP Tools](.pi/extensions/docs/lsp-tools.md)** — Go-to-definition, find references, and compiler diagnostics via Language Server Protocol across 15+ languages.

**[Tree Search](.pi/extensions/docs/tree-search.md)** — Token-efficient project file browsing and content search with fuzzy matching, regex, and ripgrep integration.

</td>
<td width="50%" valign="top">

### Agent Orchestration
**[Subagent System](.pi/extensions/docs/subagent-system.md)** — Spawn and coordinate async agents (explorer, worker, planner, reviewer) for parallel task delegation.

**[Task Management](.pi/extensions/docs/task-management.md)** — Full task lifecycle: CRUD, hierarchy, dependencies, sprints, Kanban board, and automated workflows.

**[Background Process](.pi/extensions/docs/background-process.md)** — Manage long-running processes (dev servers, watchers, builds) with graceful shutdown and log streaming.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Prompt Engine
**[Dynamic Prompt System](.pi/extensions/docs/dynamic-prompt-system.md)** — Modular, condition-based system prompt injection with 4-layer architecture that adapts to runtime state.

**[Prompt Package](.pi/extensions/docs/prompt-package.md)** — Centralized template engine with variables, inheritance, composition, and caching for all prompts.

**[Prompt History](.pi/extensions/docs/prompt-history-search.md)** — Fuzzy search across all past session prompts with deduplication and incremental caching.

</td>
<td width="50%" valign="top">

### Media & Visual
**[Image Generation](.pi/extensions/docs/image-generation.md)** — Generate and edit images with Gemini, OpenAI, FLUX, and Stability AI. Budget tracking included.

**[Image Markers](.pi/extensions/docs/image-markers.md)** — Paste images directly into prompts as `[Image #N]` markers with automatic base64 embedding.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Developer Experience
**[File Browser](.pi/extensions/docs/file-browser.md)** — Visual file explorer with multi-select, fuzzy filter, and `@file` reference pasting.

**[Diff Viewer](.pi/extensions/docs/diff.md)** — Browse and open git-changed files with color-coded status indicators.

**[Statusline](.pi/extensions/docs/custom-statusline.md)** — Information-dense single-line footer: tokens, cost, git status, context usage, model info.

**[TPS Monitor](.pi/extensions/docs/tps.md)** — Real-time tokens-per-second and usage metrics after each agent run.

**[Notifications](.pi/extensions/docs/notification.md)** — Sound and OS notifications when agent work completes or errors occur.

**[PR/Issue Widget](.pi/extensions/docs/prompt-url-widget.md)** — Auto-detect GitHub URLs, fetch metadata, and rename sessions accordingly.

</td>
<td width="50%" valign="top">

### Security
**[Restrictions](.pi/extensions/docs/restrictions.md)** — Configurable sandbox: filesystem access control, bash command filtering, tool disabling, and read-only mode.

4-layer defense with glob patterns, regex matching, and per-project configuration.

</td>
</tr>
</table>

## License

MIT
