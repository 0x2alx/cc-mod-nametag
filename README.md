# nametag

A [Claude Code](https://claude.com/claude-code) mod that marks idle sessions. When a session has had no prompt and no turn for a while (10 minutes by default), it puts `💤💤💤 ` in front of the session's name. When the next turn ends, it takes the mark off again.

This helps when you run several named sessions, for example in tmux or through Remote Control. You can see at a glance which ones are waiting on you and which have been quiet for a while.

```
Builder          →  (10 quiet minutes)  →  💤💤💤 Builder  →  (you send a message)  →  Builder
```

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install nametag --marketplace 0x2alx/cc-mod-nametag
```

From a shell:

```
claude plugin install nametag --marketplace 0x2alx/cc-mod-nametag
```

In the desktop app, where `/plugin` doesn't run, click **+** next to the prompt box, then **Plugins**. Choose **Add marketplace** with `0x2alx/cc-mod-nametag`, then **Add plugin**.

To try it from a local copy without installing, run `claude --plugin-dir /path/to/cc-mod-nametag`.

## Options

You can set both options in `/config`, or under `pluginConfigs` in your settings:

| Option | Default | What it does |
| --- | --- | --- |
| `idle_minutes` | `10` | Minutes with no prompt and no turn before the name gets the prefix (1 to 1440). |
| `prefix` | `💤💤💤 ` | The text put in front of the name. Any text works, for example `[idle] `. |

The mod checks once a minute, so the mark appears between `idle_minutes` and `idle_minutes + 1` minutes after the last activity.

## What it does, exactly

- **Only some sessions.** It acts only in interactive sessions. It skips `claude -p`, the SDK and other headless runs, and it acts only on sessions that have a name, meaning `/rename` was used at least once. It leaves unnamed sessions alone.
- **What counts as activity.** Your prompts, and every turn of the main conversation, including turns started by background tasks or other tools. Subagent turns don't count.
- **When the mark comes off.** At the end of the next turn, not when you press Enter. Claude Code doesn't let a rename run while a turn holds the session, so the name keeps the mark while that turn runs.
- **Renaming during a sleep.** If you rename a session while it is marked, your new name stands, and the mod doesn't put the old one back.
- **Older marks.** If the prefix is one symbol repeated (like the default), a name that starts with any run of that symbol also counts as marked and is cleaned up on the next turn.

## Cost

Each rename goes through `/rename`, which adds a short "Session renamed to: …" line to the conversation. The model reads that line, so a sleep and wake cost about 30 input tokens. A session that is never idle for long costs nothing.

## Known limits

- **It depends on an undocumented file format.** Claude Code has no API that returns a session's name. The mod reads the name from the session's transcript file, using the newest `{"type":"custom-title","customTitle":…}` row. That format isn't documented and may change in a future Claude Code release. If it does, the mod stops renaming. It won't rename to anything wrong: when it can't read the name, it does nothing.
- **Finding the transcript.** The mod uses the exact transcript path Claude Code reports with each hook event (session start, prompt, end of a turn), and keeps it across reloads. Only before the first such event does it fall back to deriving the path: `$CLAUDE_CONFIG_DIR` (or `~/.claude`), then `projects/<project folder>/<session id>.jsonl`. For very long project paths Claude Code shortens the folder name, so the fallback can miss until your first prompt.
- **Large transcripts.** Mods can read files of up to 4 MiB directly. For bigger transcripts the mod runs `grep` (Linux, macOS), falling back to `findstr` (Windows). Windows is untested.
- **Mod API.** It uses the Claude Code mods API (hooks modules), tested on Claude Code 2.1.325.

## Development

```
claude plugin validate .
claude plugin test .
```

The tests in `nametag.test.ts` run against a fake transcript and a mocked clock.

## License

[MIT](LICENSE)
