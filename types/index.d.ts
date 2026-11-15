// What nametag keeps.
//
// In the session's state (it outlives a hot reload of the mod):
//   transcript: this session's transcript, once found
//   work: background commands and workflows still running, task id -> when started (ms)
//   inTurn: a turn of the main conversation is running
//   record: this session's record (below) as last written, so another session's store write can't lose it
//
// In the mod's store (it outlives restarts), under "mark:<session id>", while the name is one the mod
// built (marked, or with a topic):
//   set: the name this mod set; base: the person's name under it; at: when (ms since epoch);
//   level: how many levels of the mark it carries (absent in records of 0.7 and earlier: marked);
//   topic: the topic at its end, or null
// Also "seen:<session id>": when it last had activity (ms); "asked:<session id>": { at, misses } of
// the model checks for a topic; "notopic:<session id>": when /topic off was given.
export type Mark = { set: string; base: string; at: number; level?: number; topic?: string | null }

declare module 'claude-code' {
  interface PluginState {
    'nametag': {
      transcript: string | null; work: Record<string, number> | null
      inTurn: boolean | null; record: { id: string; mark: Mark | null } | null
    }
  }
}
