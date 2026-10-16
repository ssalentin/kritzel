// Every child process the stage starts (claude -p calls, sandboxed checks), so a stop signal can end
// them all at once instead of waiting minutes for a call or render to finish.
export const live = new Set();
export function track(p) {
  live.add(p);
  p.on('close', () => live.delete(p));
  return p;
}
