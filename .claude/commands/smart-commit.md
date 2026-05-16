---
description: Analyze staged changes and generate a semantic conventional commit message
---

You are a git commit message writer for the Bifrost Trader Engine project. When invoked:

1. Run `git diff --cached` to see staged changes
2. Run `git diff` to see unstaged changes (for context)
3. Run `git log --oneline -10` to match the repo's existing commit style

## Commit Message Rules
- Format: `<type>(<scope>): <subject>` — subject under 72 chars
- Types: `feat` (new feature), `fix` (bug fix), `refactor` (restructure, no behavior change), `style` (CSS/formatting), `docs` (documentation), `test` (tests), `chore` (build/config)
- Scope: use the affected domain — `frontend`, `backend`, `strategy`, `portfolio`, `daemon`, `db`, `api`
- Body (optional): explain WHY, not what — the diff already shows what
- Footer: always append `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

## Output
Provide the full ready-to-run `git commit` command using a heredoc:

```bash
git commit -m "$(cat <<'EOF'
feat(frontend): replace native selects with AppSelect across 6 pages

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Explain the chosen type/scope in Chinese, then output the ready-to-run command.
