// What nametag keeps in the session's state (it outlives a hot reload of the mod).
//   transcript: this session's transcript, once found
//   level: how many idle levels the name's mark carries: 0 awake, null not read yet
export type MarkLevel = number | null

declare module 'claude-code' {
  interface PluginState {
    'nametag': { transcript: string | null; level: MarkLevel }
  }
}
