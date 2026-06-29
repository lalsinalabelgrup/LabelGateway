# Export conversation prompts

Review this VSCode/Codex conversation and extract every prompt or instruction I previously asked you to implement.

For each extracted prompt, create one Markdown file:

```
LabelGateway/prompts/prompt_01.md
LabelGateway/prompts/prompt_02.md
...
```

## Rules

- Two-digit numbering, zero-padded (`prompt_01`, `prompt_02`, …)
- Preserve the original content of each prompt as faithfully as possible
- One prompt per file
- Give each file a clear title (H1 heading)
- Chronological order — earliest prompt first
- Include only user prompts/instructions — no answers, no diffs, no summaries
- Keep near-duplicate or iterative prompts as separate files if they were separate messages
- Do **not** modify any application code
- Only create files inside `LabelGateway/prompts/`
