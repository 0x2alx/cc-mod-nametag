# nametag

A [Claude Code](https://claude.com/claude-code) mod that marks idle sessions, in up to three steps. When a session has had no prompt and no turn for 10 minutes, it puts `💤 ` in front of the session's name; after 3 hours the mark becomes `💤💤 `, after 12 hours `💤💤💤 `. When the next turn ends, or the session is started again (restart, resume), it takes the mark off again. The delays and the emoji of each step are options.

This helps when you run several named sessions, for example in tmux or through Remote Control. You can see at a glance which ones have been quiet, and for how long.

Optionally, it also ends each session's name with a short **topic**, a label for what that session is working on (`Builder [billing-api]`), so you can tell your sessions apart when switching between them. See [Topic](#topic).

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

Set them in `/config`, or in your user settings (`~/.claude/settings.json`), under the plugin's id:

```json
"pluginConfigs": {
  "nametag@cc-mod-nametag": {
    "options": { "level1_minutes": 15, "position": "end", "brackets": "[]" }
  }
}
```

Each level has a delay and an emoji:

| Option | Default | What it does |
| --- | --- | --- |
| `level1_minutes` | `10` | Idle minutes before the first emoji is added. |
| `level1_emoji` | `💤` | The first emoji of the mark. |
| `level2_minutes` | `180` | Idle minutes before the second emoji is added. |
| `level2_emoji` | `💤` | The second emoji. |
| `level3_minutes` | `720` | Idle minutes before the third emoji is added. |
| `level3_emoji` | `💤` | The third emoji. |

Minutes run from 1 to 10080 (a week), counted from the last activity, not from the previous level. An empty emoji turns that level off, so for a single step set `level2_emoji` and `level3_emoji` to empty. The emojis can differ, for example `1️⃣`, `2️⃣`, `3️⃣` gives `1️⃣ Builder`, then `1️⃣2️⃣ Builder`, then `1️⃣2️⃣3️⃣ Builder`. An "emoji" can be any short text without spaces.

How the mark sits next to the name:

| Option | Default | What it does |
| --- | --- | --- |
| `position` | `start` | `start` puts the mark before the name, `end` after it. |
| `separator` | empty | Text between the mark and the name, with a space on each side. Empty means just a space. |
| `brackets` | `none` | Wraps the emojis in `[]`, `()`, `{}` or `<>`. |

For example, at level 2:

| Settings | Name |
| --- | --- |
| defaults | `💤💤 Builder` |
| `position: end` | `Builder 💤💤` |
| `separator: -` | `💤💤 - Builder` |
| `brackets: []` | `[💤💤] Builder` |
| `position: end`, `separator: \|`, `brackets: ()` | `Builder \| (💤💤)` |

The mod checks once a minute, so each step lands within a minute of its delay. If the levels' minutes are out of order, the mod sorts the levels by minutes, and each emoji moves with its minutes.

## Topic

Off by default. With `"topic": "on"` the mod ends the session's name with a short label for the current work, awake or asleep:

```
Builder [billing-api]        💤 Builder [billing-api]        Builder 💤 [billing-api]  (position: end)
```

| Option | Default | What it does |
| --- | --- | --- |
| `topic` | `off` | `on` adds the topic. |
| `topic_separator` | empty | Text between the name and the topic, with a space on each side (for example `·`). Empty means just a space. |
| `topic_brackets` | `[]` | Wraps the topic in `[]`, `()`, `{}` or `<>`, or `none`. |
| `topic_freeze_hours` | `4` | After you rename the session, hours before a topic is added again. `0` for none. |
| `topic_model` | `haiku` | The model asked when the paths don't say (an alias or a model id). |

**Where the topic comes from.** First, for free, the files the session works on. The mod notes the path of every `Edit`, `Write` and `NotebookEdit` (weight 3) and every `Read`, `Grep` and `Glob` (weight 1), the session's agents included, and maps each to a project:

- under the session's folder, if that folder holds projects of its own (a folder in it has `.git`): the folder in it, so `~/work/billing-api/src/a.ts` gives `billing-api` (dot folders don't count);
- otherwise, a repository of its own inside the session's folder; the session's own repository says nothing new, so it doesn't count;
- outside the session's folder: the nearest repository above the file.

When one project has at least 60% of the weight (and at least 5), it is the topic, with no model call. Otherwise (research, chat, files all over the place), the mod asks `topic_model` once: the last six prompts and two replies, about 300 characters each, and "one short label, or SAME if the current one still fits". The answer is cut to one line of letters, digits, `.`, `_` and `-`: two words at most, 20 characters at most. A long folder name keeps its last two words (`cc-mod-billing-api` gives `billing-api`).

**When it checks.** At the end of a turn of the main conversation, cheapest test first:

1. topic off, a headless session, or fewer than 3 turns since the last check: no;
2. within `topic_freeze_hours` of you renaming the session: no;
3. less than 30 minutes since the last check: no (after a check that found nothing, 1 hour, then 2);
4. a break since the last check (no topic yet, back from a 💤, a compaction, or the files point at another project): check;
5. no break: check only if 2 hours have passed.

A check that ends with the same topic renames nothing. A topic the name already says (`alpha` in `Alpha work`) is left off. In practice the topic changes a few times a day at most, at the breaks where your work usually changes.

**Your own name wins.** When you rename the session, your name stands alone, without a topic, for `topic_freeze_hours`; at the next check after that, the topic comes back at the end of your new name. A `/rename` is seen at once; a rename from the app or claude.ai is seen at the next check or the next 💤. The mod never reads a topic back out of a name: like the mark, it keeps the topic in its record and builds the whole name each time.

**Cost.** A path-led topic costs nothing but the rename (about 15 input tokens, as below). A model-led check sends roughly 300 to 700 input tokens to `topic_model` and gets a few back, at most once every 30 minutes (every 2 hours while it keeps finding nothing) and in practice far less often. Unnamed sessions are never checked.

## What it does, exactly

- **Only some sessions.** It marks only interactive sessions (and gives topics only to them), never `claude -p`, the SDK or other headless runs, though a headless turn on a marked session (for example `claude -p --resume`) still takes the mark off. It acts only on sessions that have a name, meaning `/rename` was used at least once or the session was started with `--name`. It leaves unnamed sessions alone.
- **What counts as activity.** Your prompts, and every turn of the main conversation, including turns started by background tasks or other tools. Subagent turns don't count. A turn that is still running, for example one waiting for you to approve a tool, is never marked.
- **Work in the background counts as activity.** While a subagent or teammate is running, a command runs in the background (`run_in_background`, or Ctrl+B), or a workflow is running, the session isn't idle; the idle time starts when the last of them ends. Agents come from Claude Code's list of the session's agents. Background commands and workflows have no such list for mods, so the mod notes each one when it goes to the background and drops it when Claude Code's notice of its end arrives, when it is stopped, or after 24 hours at most. A Monitor is a watch, not work, so it doesn't count, and neither does a teammate waiting for a message.
- **When the mark comes off.** At the end of the next turn, not when you press Enter. Claude Code doesn't let a rename run while a turn holds the session, so the name keeps the mark while that turn runs. A session started again (a restart, `--resume`, `--continue`) loses the mark right away; resumed with a new `--name`, it keeps the new name.
- **Renaming during a sleep.** If you rename a session while it is marked, your new name stands and the mod doesn't put the old one back. The mod notices the rename when the next level is due (it doesn't read the transcript every minute), counts it as activity, and marks your new name after a fresh idle spell.
- **The name it builds from.** The mark is always built from the name you gave the session, with `/rename` or `--name`. The mod never tries to read a mark back out of a name. The transcript doesn't record who set a name, so while a session is marked (or has a topic) the mod keeps a small record in its own store: the name it set, your name under it, the level and the topic. If the session's name is still that exact name, your name is the one in the record; any other name is yours. So changing `position`, `separator`, `brackets` or the emojis takes effect at the next step, built fresh from your name, and a name you happen to start with `💤` stays as you wrote it. The record is deleted when the name is back to just yours; records the mod hasn't touched for 90 days (sessions that ended and never came back) are dropped.
- **Named at launch.** `claude --name <name>` (or `-n`) counts as a name, the same as `/rename`. A name given only to `--remote-control <name>` doesn't reach the transcript, so the mod skips that session; add `--name` too, or `/rename` it once.

## Cost

Each rename goes through `/rename`, which adds a short "Session renamed to: …" line to the conversation. The model reads that line, so each step and the wake cost about 15 input tokens each: about 30 for a short break, about 60 for a night away. A session that is never idle for long costs nothing.

## Known limits

- **It depends on an undocumented file format.** Claude Code has no API that returns a session's name. The mod reads the name from the session's transcript file, using the newest `{"type":"custom-title","customTitle":…}` row. That format isn't documented and may change in a future Claude Code release. If it does, the mod stops renaming. It won't rename to anything wrong: when it can't read the name, it does nothing.
- **Finding the transcript.** Transcripts live at `<config>/projects/<project folder>/<session id>.jsonl`, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`. The session id is unique, so the mod finds the file by that name. It looks first in the folder Claude Code names after the project, then in every project folder, which covers long project paths whose folder name Claude Code shortens. It remembers the path for the rest of the session. (Hook events such as `Stop` carry the exact path, but Claude Code's built-in security plugin doesn't pass those events to installed mods.)
- **Large transcripts.** Mods can read files of up to 4 MiB directly. For bigger transcripts the mod runs `grep` (Linux, macOS), falling back to `findstr` (Windows). Windows is untested.
- **Mod API.** It needs a Claude Code version with the mods API (hooks modules). It is tested on Claude Code 2.1.325.

## Uninstall

`/plugin uninstall nametag`, or `claude plugin uninstall nametag`. A session that is marked, or has a topic, at that moment keeps it: `/rename` it once to clear it.

## Development

```
claude plugin validate .
claude plugin test .
```

The tests in `nametag.test.ts` run against a fake transcript and a mocked clock.

`tsconfig.json` points at the mods API types in `.claude-plugin/types/`. Claude Code writes them there when it loads the mod (for example with `claude --plugin-dir .`), so they aren't in the repo. Until then, only your editor's type checking misses them; `validate` and `test` work without them.

## License

[MIT](LICENSE)
