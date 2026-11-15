// What nametag keeps. Nothing on disk but each session's last model check for a topic, in the mod's
// store under "asked:<session id>" (ms since epoch), forgotten after 90 days.
//
// In the session's memory (it outlives a hot reload of the mod, not a restart):
//   transcript: this session's transcript, once found
//   work: background commands and workflows seen starting while this process runs, task id -> when (ms)
//   ended: task ids seen ending (a notice, TaskStop) while this process runs
//   inTurn: a turn of the main conversation is running
//   from: how many rows the conversation had when this process started (-1: none yet)

declare module 'claude-code' {
  interface PluginState {
    'nametag': {
      transcript: string | null; work: Record<string, number> | null; ended: string[] | null
      inTurn: boolean | null; from: number | null
    }
  }
}

export type TaskIds = string[]
