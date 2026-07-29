export function normalizeAgentMode(value) {
  const mode = String(value ?? "full-access").trim().toLowerCase();
  if (mode === "full-access" || mode === "read-only") {
    return mode;
  }
  throw new Error(`Unsupported XUANNIAO_AGENT_MODE: ${value}. Expected full-access or read-only.`);
}

export function parseCommandLine(commandLine) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && index + 1 < commandLine.length) {
        current += commandLine[++index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}
