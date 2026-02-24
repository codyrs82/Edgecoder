export function loadSetting(key: string, fallback: string = ""): string {
  try {
    return localStorage.getItem(`edgecoder_${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(`edgecoder_${key}`, value);
  } catch {
    /* ignore */
  }
}

export function loadSettings() {
  return {
    meshToken: loadSetting("meshToken"),
    seedNodeUrl: loadSetting("seedNodeUrl"),
    maxConcurrentTasks: Number(loadSetting("maxConcurrentTasks", "1")),
    cpuCapPercent: Number(loadSetting("cpuCapPercent", "50")),
    idleOnly: loadSetting("idleOnly", "true") === "true",
  };
}
