// What nametag keeps in the session's state (it outlives a hot reload of the mod).
//   transcript: the transcript path the engine last reported (classic hook events carry it)
//   mark: whether the session name carries the prefix: 'asleep', 'awake', or 'unknown' (not read yet)
export type Mark = 'asleep' | 'awake' | 'unknown'

declare module 'claude-code' {
  interface PluginState {
    'nametag': { transcript: string | null; mark: Mark }
  }
}
