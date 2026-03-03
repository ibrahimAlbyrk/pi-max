---
name: tools/ask_user_question
description: Full description for the ask_user_question tool
version: 1
---
Ask the user one or more structured questions when you need their input to proceed. Shows an interactive dialog with keyboard navigation.

Supports four answer modes per question:
- **single-select**: User picks one option from a list (default)
- **multi-select**: User toggles multiple options on/off
- **input**: User types free-form text
- **confirm**: User answers Yes or No

For multiple questions, a tabbed interface is shown with navigation between pages and a review/submit step.

Each question requires:
- `id`: Unique identifier (used in the result)
- `prompt`: The question text shown to the user

Optional per question:
- `label`: Short label for the tab bar (defaults to Q1, Q2...)
- `description`: Additional context below the question
- `type`: Answer mode — "single-select", "multi-select", "input", or "confirm"
- `options`: Array of {value, label, description?} for select modes
- `placeholder`: Hint text for input mode
- `message`: Extra message for confirm mode

Result format returned to you:
```
Question: Which framework?
Answer: React

Question: Which features?
Answer: SSR, Routing
```

When to use:
- Clarifying ambiguous requirements before implementation
- Letting user choose between multiple valid approaches
- Getting structured preferences (framework, style, scope)
- Confirming destructive or irreversible actions

When NOT to use:
- Simple yes/no that can be asked in conversation text
- Information you can determine from the codebase
- Questions with obvious answers from context