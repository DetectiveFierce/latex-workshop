import type { EventEmitter } from 'node:events';

/**
 * A language server can exit while a message is being written to it, or fail to
 * start at all. Node turns either into an 'error' event that would otherwise end
 * this process and every other project's session, so end only the affected one.
 */
export function endSessionOnServerFailure(
  server: EventEmitter,
  stdin: EventEmitter,
  endSession: () => void,
) {
  server.on('error', endSession);
  stdin.on('error', endSession);
}
