---
id: core-knowledge-base
layer: 1
priority: 1
conditions:
  - dir_exists: .pi
---
# `.pi/` Directory Structure

All project knowledge lives under `.pi/`. These are **conventions** — directories are created as needed, not all may exist yet.

| Directory | Purpose | Naming | Mutability |
|-----------|---------|--------|------------|
| `docs/` | Architectural design references — architecture, tech decisions, data models, integrations, agent designs | `{topic}.md` | Living (update as design evolves) |
| `specs/` | Implementation specs written before coding — state machine rules, tool definitions, API contracts, schemas. Codeable detail level. | `{topic}.spec.md` | Living until implemented, then frozen |
| `reports/` | Completed analysis/research snapshots — reviews, benchmarks, spike findings, audits, post-mortems | `{topic}.report.md` | **Immutable** after creation |
| `cookbooks/` | Step-by-step how-to recipes — add agent, add tool, debug, extend pipeline, dev setup | `{action}.cookbook.md` | Living |
| `templates/` | Reusable prompt/document templates for recurring workflows | `{type}.tmpl.md` | Living |