# nametag

A [Claude Code](https://claude.com/claude-code) mod that tags each session's name with what it is doing, so you can tell your sessions apart at a glance when you run several of them, for example in tmux or through Remote Control. It keeps two tags, each with its own options:

- **Idle mark** (on by default). When a session has had no prompt and no turn for 10 minutes, it puts `💤 ` in front of the session's name; after 3 hours the mark becomes `💤💤 `, after 12 hours `💤💤💤 `. When the next turn ends, it takes the mark off again. The mark always matches the time since the session's last activity: a session restarted or reloaded after 4 quiet hours shows `💤💤 ` right away. The delays and the emoji of each step are options.
- **Topic** (off by default). It ends the name with a short label for what that session is working on (`Builder [billing]`), taken from the files it touches or, when they don't say, from a small model. See [Topic](#topic).

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

To try it from a local copy without installing, run `claude --plugin-dir /path/to/cc-mod-nametag`. Loaded that way, it reads its options under `nametag@inline` rather than the id below.

## Options

Set them in `/config`, or in your user settings (`~/.claude/settings.json`, inside its top-level object), under the plugin's id:

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

Minutes run from 1 to 10080 (a week), counted from the last activity, not from the previous level. An empty emoji turns that level off, so for a single step set `level2_emoji` and `level3_emoji` to empty. The emojis can differ, for example `1️⃣`, `2️⃣`, `3️⃣` gives `1️⃣ Builder`, then `1️⃣2️⃣ Builder`, then `1️⃣2️⃣3️⃣ Builder`. An "emoji" can be any short text.

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
Builder [billing]        💤 Builder [billing]        Builder 💤 [billing]  (position: end)
```

| Option | Default | What it does |
| --- | --- | --- |
| `topic` | `off` | `on` adds the topic. |
| `topic_separator` | empty | Text between the name and the topic, with a space on each side (for example `·`). Empty means just a space. |
| `topic_brackets` | `[]` | Wraps the topic in `[]`, `()`, `{}` or `<>`, or `none`. |
| `topic_words` | `1` | The most words in a topic: `1` or `2` (joined by `-`). |
| `topic_model` | `haiku` | The model asked when the paths don't say (an alias or a model id). |

**Where the topic comes from.** First, for free, the files the session works on. At each check the mod reads the conversation as it stands and takes the paths of its last 30 `Edit`, `Write` and `NotebookEdit` calls (weight 3) and `Read`, and `Grep` or `Glob` given a path (weight 1), in the main conversation, and maps each to a project:

- under the session's folder, if that folder holds projects of its own (a folder in it has `.git`): the folder in it, so `~/work/billing/src/a.ts` gives `billing` (dot folders don't count);
- otherwise, a repository of its own inside the session's folder; the session's own repository says nothing new, so it doesn't count;
- outside the session's folder: the nearest repository above the file.

When one project has at least 60% of the weight (and at least 5), it is the topic, with no model call. Otherwise (research, chat, files all over the place), the mod asks `topic_model` once, at low effort: the last ten prompts and four replies, about 600 characters each (short prompts only make sense among the others), with the goal stated plainly: a one-word topic (two with `topic_words: 2`) that tells someone glancing at a list of sessions what this one is working on now, or SAME if the current one still fits. The answer is cut to one line of letters, digits, `.`, `_` and `-`: `topic_words` words at most (one by default), 20 characters at most. A folder name kept to one word keeps its longest (`cc-mod-billing-api` gives `billing`); with `topic_words: 2` it keeps its last two (`billing-api`). A model's answer keeps its first words.

**When it checks.** When the session starts (a restart or reload included) and at the end of each turn of the main conversation, cheapest test first. Each check reads the conversation as it stands, so nothing is lost to a restart:

1. topic off, turned off for this session with `/topic off`, or a headless session: no;
2. the paths (free): one project leads, so it is the topic. Only the last 30 path calls count, so a switch to another project shows within a few edits;
3. no project leads: the model, once you have written at least three prompts and 10 minutes have passed since its last check (after a check that found nothing, 20 minutes, then 40, up to 2 hours). The time of the last check is the one thing kept on disk, so a restart keeps the cap. An idle session started again (it gets the mark at once) that already carries a topic gets no model check: nothing has happened since the topic was set. The free path check still runs.

A check that ends with the same topic renames nothing. A topic the name already says (`alpha` in `Alpha work`) is left off.

**Your own name, with the topic.** When you rename the session, the topic goes on the end of your new name at the next check. To keep a session's name free of topics, run `/topic off` in it (`/topic on` brings the topic back, `/topic` says which it is). A rename from the app or claude.ai works the same way: each check reads the name as it is then.

**Cost.** A path-led topic costs nothing but the rename (about 15 input tokens, as below). A model-led check sends up to about 2,300 input tokens (for English text) to `topic_model` and gets a word or two back (it may use up to 1,000 output tokens, room for any thinking at low effort), only while the files don't name a project, and at most once every 10 minutes of active work (less often while it keeps finding nothing); an idle session makes none. Unnamed sessions are never checked. The calls go through your session's own Claude Code client and count toward its cost (`/cost`), billed like your other usage at `topic_model`'s rate, so a larger model costs more per check.

The label is whatever the model answers, cleaned as above, so now and then it may be odd. Your next rename, or the next check, replaces it.

## What it does, exactly

- **Only some sessions.** It marks only interactive sessions (and gives topics only to them), never `claude -p`, the SDK or other headless runs, though a headless turn on a marked session (for example `claude -p --resume`) still takes the mark off. It acts only on sessions that have a name, meaning `/rename` was used at least once or the session was started with `--name`. It leaves unnamed sessions alone.
- **What counts as activity.** Your prompts, and every turn of the main conversation, including turns started by background tasks or other tools. Subagent turns don't count. A turn that is still running, for example one waiting for you to approve a tool, is never marked.
- **Work in the background counts as activity.** While a subagent or teammate is running, a command runs in the background (`run_in_background`, or Ctrl+B), or a workflow is running, the session isn't idle; the idle time starts when the last of them ends. Agents come from Claude Code's list of the session's agents. Background commands and workflows have no such list for mods, so at each check the mod works them out from the conversation: the ones it put in the background since Claude Code last started (a restart ends them), less those with a notice of their end or stopped with TaskStop. A Monitor is a watch, not work, so it doesn't count, and neither does a teammate waiting for a message or an agent waiting for your approval.
- **When the mark comes off.** At the end of the next turn, not when you press Enter. Claude Code doesn't let a rename run while a turn holds the session, so the name keeps the mark while that turn runs.
- **The mark matches the idle time, always.** Each check sets exactly the levels the time since the last activity calls for, whatever happened in between. The last activity is the newest prompt, reply or tool result in the session's transcript (renames, the "No response requested." a resume writes, and other bookkeeping rows don't count), kept up to date while the session runs by its prompts and turns. A start is not activity: a session started again (a restart, a reload of the mod, `--resume`, `--continue`) gets at once the mark its idle time calls for, and loses it at the end of your first turn. A session with nothing in it yet starts counting at its start.
- **Renaming during a sleep.** If you rename a session while it is marked, your new name stands and the mod doesn't put the old one back, even when its own rename was waiting to run at that moment. A `/rename` is a command typed in the session, so it counts as activity: the idle time starts over from it. A rename from the app is not activity: at the next check, within a minute, your new name gets the mark the idle time calls for.
- **The name it builds from.** The mod keeps nothing about the name between checks. Each time, it reads the session's name right then and takes off what it would have added itself: the mark as your options build it (or a mark of 💤s and the level emojis in another style, at the front or the end, so a change of options never stacks marks), and with topic on, a short label in the topic's brackets at the end. What's left is your name, and the new name is built from it. The transcript doesn't record who set a name, so this has a cost: a name you give that itself starts with the mark (`💤 Notes`), or with topic on ends in a bracketed word (`Notes [draft]`), is read as carrying a mark or topic, and that part is replaced.
- **Named at launch.** `claude --name <name>` (or `-n`) counts as a name, the same as `/rename`. A name given only to `--remote-control <name>` doesn't reach the transcript, so the mod skips that session; add `--name` too, or `/rename` it once.

## Cost

Each rename goes through `/rename`, which adds a short "Session renamed to: …" line to the conversation. The model reads that line, so each step and the wake cost about 15 input tokens each: about 30 for a short break, about 45 for a night away (two steps and the wake). A session that is never idle for long costs nothing.

## What it reads and sends

- **Reads:** this session's transcript file, for the session's name (whole if under 4 MiB, otherwise through `grep` or `findstr`), and the folder names under `<config>/projects` while it looks for that file. With topic on, it also notes the paths your tools touch and checks for `.git` folders above them.
- **Keeps:** on disk, only the time of each session's last model check for a topic, so a restart can't call the model sooner; forgotten after 90 days. Everything else (your name under the mark, the level, the topic, the last activity, running background work, `/topic off`) is worked out from the session and its transcript each time it is needed.
- **Sends, only with topic on and only when the files don't name a project:** up to your last ten prompts and four of Claude's replies (600 characters each) and the current topic, to `topic_model`, through your session's own client and account. A secret pasted near the start of a prompt would be in that request, as it already is in the conversation. Tool output and file contents are never sent. It makes no other network calls.

## Known limits

- **It depends on an undocumented file format.** Claude Code has no API that returns a session's name. The mod reads the name from the session's transcript file, using the newest `{"type":"custom-title","customTitle":…}` row. That format isn't documented and may change in a future Claude Code release. If it does, the mod stops renaming. It won't rename to anything wrong: when it can't read the name, it does nothing.
- **Finding the transcript.** Transcripts live at `<config>/projects/<project folder>/<session id>.jsonl`, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`. The session id is unique, so the mod finds the file by that name. It looks first in the folder Claude Code names after the project, then in every project folder, which covers long project paths whose folder name Claude Code shortens. It remembers the path for the rest of the session. (Hook events such as `Stop` carry the exact path, but at the time of writing Claude Code's built-in security plugin doesn't pass those events to installed mods.)
- **Large transcripts.** Mods can read files of up to 4 MiB directly. For bigger transcripts the mod reads the last 512 KiB with `tail` (Claude Code writes the name again at every prompt, so it is nearly always there) and searches the whole file with `grep` (Linux, macOS) or `findstr` (Windows) when it isn't. Windows has no `tail`: there, in a transcript over 4 MiB, the last activity comes only from what the session did since Claude Code started. Windows is untested.
- **Mod API.** It needs a Claude Code version with the mods API (hooks modules). It is tested on Claude Code 2.1.325, in the terminal. The desktop app and the IDE extensions run the same engine but are untested. Cloud sessions (Claude Code on the web) are untested too, and may count as headless, which the mod leaves alone.

## Uninstall

`/plugin uninstall nametag`, or `claude plugin uninstall nametag`. A session that is marked, or has a topic, at that moment keeps it: `/rename` it once to clear it.

## Development

```
claude plugin validate .
claude plugin test .
```

Run them from the repository with `claude` on your `PATH`; `test` needs a writable working directory and no network. The tests in `nametag.test.ts` run against a fake transcript and a mocked clock.

`tsconfig.json` points at the mods API types in `.claude-plugin/types/`. Claude Code writes them there when it loads the mod (for example with `claude --plugin-dir .`), so they aren't in the repo. Until then, only your editor's type checking misses them; `validate` and `test` work without them.

## License

[MIT](LICENSE)
