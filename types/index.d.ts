// What nametag keeps.
//
// In the session's state (it outlives a hot reload of the mod):
//   transcript: this session's transcript, once found
//   work: background commands and workflows still running, task id -> when started (ms)
//   topic: the topic's bookkeeping between checks (TopicMemory)
//   inTurn: a turn of the main conversation is running
//   record: this session's record (below) as last written, so another session's store write can't lose it
//
// In the mod's store (it outlives restarts), under "mark:<session id>", while the name is one the mod
// built (marked, or with a topic):
//   set: the name this mod set; base: the person's name under it; at: when (ms since epoch);
//   level: how many levels of the mark it carries (absent in records of 0.7 and earlier: marked);
//   topic: the topic at its end, or null
// and under "freeze:<session id>": until when topics wait after the person renamed the session.
export type Mark = { set: string; base: string; at: number; level?: number; topic?: string | null }

// Between topic checks: turns since the last model check, when it was, the path weight per project
// and in all (it halves every 10 minutes; decayedAt: when it last did), and how many model checks in
// a row found nothing (each doubles the wait).
export type TopicMemory = {
  turns: number; lastCheck: number; weights: Record<string, number>; total: number
  decayedAt: number; misses: number
}

declare module 'claude-code' {
  interface PluginState {
    'nametag': {
      transcript: string | null; work: Record<string, number> | null; topic: TopicMemory | null
      inTurn: boolean | null; record: { id: string; mark: Mark | null } | null
    }
  }
}
