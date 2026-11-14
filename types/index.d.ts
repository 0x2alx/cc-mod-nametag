// What nametag keeps.
//
// In the session's state (it outlives a hot reload of the mod):
//   transcript: this session's transcript, once found
//   level: written by 0.5 and earlier; read once on upgrade, then cleared
//
// In the mod's store (it outlives restarts), under "mark:<session id>", while a session is marked:
//   set: the name this mod set; base: the person's name under it; at: when (ms since epoch)
export type Mark = { set: string; base: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'nametag': { transcript: string | null; level: number | null }
  }
}
