# Project skills

Skills committed here load automatically in every Claude Code session on this repo, **including cloud sessions** (cloud sessions don't install plugins, but they do read `.claude/skills/`).

| Skill | Source | License |
|---|---|---|
| `brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion` | [obra/superpowers](https://github.com/obra/superpowers) (Jesse Vincent) | MIT (`LICENSE` in each folder) |
| `frontend-design` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/frontend-design) | Apache 2.0 (`LICENSE.txt`) |

Copied unmodified on 2026-09-26.

## Notes for Claude
- The Superpowers files refer to each other as `superpowers:<name>`. Here the skills are installed under their bare names, so `superpowers:test-driven-development` means the `test-driven-development` skill in this folder.
- Skills they mention that aren't installed here (`using-git-worktrees`, `subagent-driven-development`, `finishing-a-development-branch`, `requesting-code-review`, `executing-plans`) are not part of this project's workflow. Skip those steps and follow `docs/TERMINALS.md` and `docs/CLOUD_PLAN.md` for branching instead.
- **`brainstorming` is interactive** (it asks the user questions one at a time). When the user is present, use it as written. **When running unattended** (overnight cloud sessions), don't wait for answers: answer the questions yourself, write down the options and your reasoning, pick one, and record the decision for review.
