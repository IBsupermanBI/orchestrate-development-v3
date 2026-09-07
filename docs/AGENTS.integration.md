# Фрагмент для AGENTS.md проекта

Добавьте блок, если проект требует внешние Loop Review. Эквивалентное исключение дублировать не нужно.

```markdown
## Orchestration workflow exception

When orchestrate-development-v3 is explicitly active, project requirements to invoke Loop Plan Review or Loop Code Review and their per-subtask cadence are replaced by the skill's internal review mechanism. The orchestrator must not invoke external Loop Review skills. Project-required review milestones remain required and are fulfilled by internal Sol review; required test commands, architecture, contracts, data safety and publication permissions remain binding. Outside this workflow, the project's normal Loop Review requirements apply. This exception does not override higher-priority instructions.
```
