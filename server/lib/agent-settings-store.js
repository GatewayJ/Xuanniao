import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeAgentSettings } from "./agent-settings.js";
import { atomicWriteText } from "./atomic-file.js";

export class AgentSettingsStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async load(fallback = {}) {
    try {
      const content = await readFile(this.filePath, "utf8");
      return normalizeAgentSettings(JSON.parse(content), fallback);
    } catch (error) {
      if (error?.code === "ENOENT") return normalizeAgentSettings({}, fallback);
      throw error;
    }
  }

  async save(settings) {
    const normalized = normalizeAgentSettings(settings);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await atomicWriteText(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }
}
