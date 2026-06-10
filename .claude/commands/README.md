# Claude Code slash commands

This directory holds project-scoped slash commands that load automatically
when you open this repo in [Claude Code](https://claude.ai/code).

Each `*.md` file in this directory becomes a `/command-name` you can invoke
from the Claude Code prompt. The file content is the prompt template Claude
follows when you run the command.

See the [Claude Code docs](https://docs.claude.com/en/docs/claude-code/slash-commands)
for the full format.

## Contributing a command

Useful general-purpose commands are welcome. Skip commands that hardcode
personal deployment paths, internal infra, or one-off workflows — those
belong in your own `~/.claude/commands/` instead.
