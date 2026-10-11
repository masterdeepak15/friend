// The queue logic is shared with the server (the PC's own player runs the same one), so it lives in the protocol package.
export { initialPlayer, MAX_QUEUE, playerReducer, shuffled } from "@friend/protocol";
export type { PlayerAction, PlayerState, PlayerView, Track } from "@friend/protocol";
