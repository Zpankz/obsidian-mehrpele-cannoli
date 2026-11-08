                                                                                           
// canvas, Mehrpele Flows refuses (outcome "refused") instead of racing it on the same file.

export const LOCK_NOTICE = "Cannoli is already running this canvas";

export interface LockApp {
  plugins?: { plugins?: Record<string, unknown> };
}

interface CannoliPluginLike {
  runningCannolis?: Record<string, unknown>;
}

/** Cannoli keys its running flows by file basename (no extension). */
export function cannoliIsRunning(app: LockApp, file: { basename: string }): boolean {
  const cannoli = app.plugins?.plugins?.cannoli as CannoliPluginLike | undefined;
  return !!cannoli?.runningCannolis?.[file.basename];
}
