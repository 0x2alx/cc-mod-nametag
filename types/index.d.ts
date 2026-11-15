// What nametag keeps on disk, in the mod's store: each session's last model check for a topic under
// "asked:<session id>" (ms since epoch), forgotten after 90 days; the mark and topic options it ran
// with under "styles", newest first, at most five. While a name is marked, <config>/nametag/wake/
// <session id> for the optional wake hook.
//
// In the session's memory (it outlives a hot reload of the mod, not a restart):
//   transcript: this session's transcript, once found
//   work: background commands and workflows seen starting while this process runs, task id -> when (ms)
//   ended: task ids seen ending (a notice, TaskStop) while this process runs
//   workBy: of those background tasks, the ones a subagent started, task id -> agent id
//   inTurn: a turn of the main conversation is running
//   from: how many rows the conversation had when this process (or a /clear) started; null: not yet

declare module 'claude-code' {
  interface PluginState {
    'nametag': {
      transcript: string | null; work: Record<string, number> | null; ended: string[] | null
      workBy: Record<string, string> | null
      inTurn: boolean | null; from: number | null
    }
  }
}

// A contract file exports types only; this one marks the file as a module.
export type TaskIds = string[]
