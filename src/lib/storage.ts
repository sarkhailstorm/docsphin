// Keys were renamed with the app, so a read falls back to the old keys and moves the value across
// Reads are left to throw: callers use that to tell a blocked private window from an empty one
function adopt(store: Storage, key: string, legacy: readonly string[]): string | null {
  const current = store.getItem(key);
  if (current !== null) return current;

  for (const name of legacy) {
    const old = store.getItem(name);
    if (old === null) continue;
    try {
      store.setItem(key, old);
      store.removeItem(name);
    } catch {
      // Full or read-only; the value still comes back, it just moves next time
    }
    return old;
  }
  return null;
}

export function readLocal(key: string, legacy: readonly string[]): string | null {
  return adopt(localStorage, key, legacy);
}

export function readSession(key: string, legacy: readonly string[]): string | null {
  return adopt(sessionStorage, key, legacy);
}

// Separate try blocks: a throw on one must not skip the rest
export function forgetLocal(key: string, legacy: readonly string[]): void {
  for (const name of [key, ...legacy]) {
    try {
      localStorage.removeItem(name);
    } catch {
      // Storage blocked
    }
  }
}
