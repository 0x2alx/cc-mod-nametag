# nametag

A [Claude Code](https://claude.com/claude-code) mod that marks idle sessions, in up to three steps. When a session has had no prompt and no turn for 10 minutes, it puts `💤 ` in front of the session's name; after 3 hours the mark becomes `💤💤 `, after 12 hours `💤💤💤 `. When the next turn ends, it takes the mark off again. The delays and the emoji of each step are options.

This helps when you run several named sessions, for example in tmux or through Remote Control. You can see at a glance which ones are waiting on you and which have been quiet for a while.

```
Builder  →  10 min  →  💤 Builder  →  3 h  →  💤💤 Builder  →  12 h  →  💤💤💤 Builder
                                              (you send a message, the turn ends)  →  Builder
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

Set them in `/config`, or under `pluginConfigs` in your settings. Each level has a delay and an emoji:

| Option | Default | What it does |
| --- | --- | --- |
| `level1_minutes` | `10` | Idle minutes before the first emoji is added. |
| `level1_emoji` | `💤` | The first emoji of the mark. |
| `level2_minutes` | `180` | Idle minutes before the second emoji is added. |
| `level2_emoji` | `💤` | The second emoji. |
| `level3_minutes` | `720` | Idle minutes before the third emoji is added. |
| `level3_emoji` | `💤` | The third emoji. |

Minutes run from 1 to 10080 (a week), counted from the last activity, not from the previous level. An empty emoji turns that level off, so for a single step set `level2_emoji` and `level3_emoji` to empty. The emojis can differ, for example `1️⃣`, `2️⃣`, `3️⃣` gives `1️⃣ Builder`, then `1️⃣2️⃣ Builder`, then `1️⃣2️⃣3️⃣ Builder`. An "emoji" can be any short text without spaces.

The mod checks once a minute, so each step lands within a minute of its delay. If the levels' minutes are out of order, the mod sorts them by minutes.

## What it does, exactly

- **Only some sessions.** It acts only in interactive sessions. It skips `claude -p`, the SDK and other headless runs, and it acts only on sessions that have a name, meaning `/rename` was used at least once or the session was started with `--name`. It leaves unnamed sessions alone.
- **What counts as activity.** Your prompts, and every turn of the main conversation, including turns started by background tasks or other tools. Subagent turns don't count.
- **When the mark comes off.** At the end of the next turn, not when you press Enter. Claude Code doesn't let a rename run while a turn holds the session, so the name keeps the mark while that turn runs.
- **Renaming during a sleep.** If you rename a session while it is marked, your new name stands, and the mod doesn't put the old one back.
- **What counts as a mark.** A run of the configured emojis (or `💤`, the mark of earlier versions) at the start of the name, followed by a space. So `💤💤💤 Builder` from an older version wakes cleanly, while a name like `💤Builder`, with no space after the emoji, is left as you wrote it. Avoid an emoji that your own names start with followed by a space.
- **Named at launch.** `claude --name <name>` (or `-n`) counts as a name, the same as `/rename`. A name given only to `--remote-control <name>` doesn't reach the transcript, so the mod skips that session; add `--name` too, or `/rename` it once.

## Cost

Each rename goes through `/rename`, which adds a short "Session renamed to: …" line to the conversation. The model reads that line, so each step and the wake cost about 15 input tokens each: about 30 for a short break, about 60 for a night away. A session that is never idle for long costs nothing.

## Known limits

- **It depends on an undocumented file format.** Claude Code has no API that returns a session's name. The mod reads the name from the session's transcript file, using the newest `{"type":"custom-title","customTitle":…}` row. That format isn't documented and may change in a future Claude Code release. If it does, the mod stops renaming. It won't rename to anything wrong: when it can't read the name, it does nothing.
- **Finding the transcript.** Transcripts live at `<config>/projects/<project folder>/<session id>.jsonl`, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`. The session id is unique, so the mod finds the file by that name. It looks first in the folder Claude Code names after the project, then in every project folder, which covers long project paths whose folder name Claude Code shortens. It remembers the path for the rest of the session. (Hook events such as `Stop` carry the exact path, but Claude Code's built-in security plugin doesn't pass those events to installed mods.)
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
