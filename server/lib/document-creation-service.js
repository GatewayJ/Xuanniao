import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const markdownExtensions = new Set([".md", ".markdown", ".mdown", ".mkdn"]);
const forbiddenPathSegments = new Set([".git", ".xuanniao", "node_modules", "dist"]);
const maxInstructionLength = 20_000;
const maxDocumentLength = 4 * 1024 * 1024;

export class DocumentCreationService {
  constructor({ workspaceRoot, agent, document = null, agentRuns = null, now = () => Date.now() }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.agent = agent;
    this.document = document;
    this.agentRuns = agentRuns;
    this.now = now;
  }

  async create({ instruction, directory = null, fileName = null, agentRunId = null }, { onUpdate = null, isStopping = () => false } = {}) {
    const threadId = documentCreationThreadId(agentRunId);
    const startedAt = this.now();
    let agentSnapshot = null;
    let answer = null;
    this.agentRuns?.start(agentRunId, { kind: "document-creation", threadId });

    try {
      const request = normalizeInstruction(instruction);
      const destination = normalizeDestinationPreferences(this.workspaceRoot, { directory, fileName });
      assertNotStopping(isStopping);
      agentSnapshot = await this.document?.createAgentSnapshot() || null;
      // Stop may have arrived while the source snapshot was being read, before
      // the runtime had a run to interrupt.
      assertNotStopping(isStopping);
      try {
        answer = await this.agent.runTurn({
          runId: agentRunId || undefined,
          question: request,
          document: {
            path: this.workspaceRoot,
            title: "New Markdown document",
            content: ""
          },
          thread: {
            id: threadId,
            sessionKey: threadId,
            selectedText: "",
            anchor: {},
            messages: [],
            agentSession: null,
            parentAgentSession: null
          },
          mode: "create-document",
          onUpdate: (update) => {
            onUpdate?.(update);
            this.agentRuns?.publish(agentRunId, update);
          }
        });
      } catch (runError) {
        if (agentSnapshot) {
          try {
            await this.document.verifyAgentSnapshot(agentSnapshot);
          } catch (guardError) {
            // A missing/changed source must not hide the uncertain native run.
            if (["AGENT_RUNTIME_LOST", "AGENT_STOP_TIMEOUT"].includes(runError.code)) {
              runError.verificationError = guardError.message;
              throw runError;
            }
            throw guardError;
          }
        }
        throw runError;
      }
      assertNotStopping(isStopping);
      if (agentSnapshot) await this.document.verifyAgentSnapshot(agentSnapshot);
      assertNotStopping(isStopping);
      const draft = extractCreatedDocument(answer.content);
      const relativePath = applyDestinationPreferences(draft.relativePath, destination);
      const filePath = await writeNewDocument(this.workspaceRoot, relativePath, draft.content, { isStopping });
      this.agentRuns?.complete(agentRunId, "completed", {
        durationMs: this.now() - startedAt
      });
      return {
        path: filePath,
        relativePath: path.relative(this.workspaceRoot, filePath),
        content: draft.content
      };
    } catch (error) {
      if (answer) {
        error.content ??= answer.content;
        error.updates ??= answer.updates;
      }
      const status = ["AGENT_RUNTIME_LOST", "AGENT_STOP_TIMEOUT"].includes(error.code) ? "unknown"
        : error.code === "AGENT_INTERRUPTED" ? "interrupted" : "failed";
      this.agentRuns?.complete(agentRunId, status, {
        durationMs: this.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}

export function documentCreationThreadId(agentRunId) {
  return `document-creation-${agentRunId || "request"}`;
}

export function extractCreatedDocument(value) {
  const output = String(value || "");
  const pathMatch = output.match(/<XUANNIAO_DOCUMENT_PATH>\s*([\s\S]*?)\s*<\/XUANNIAO_DOCUMENT_PATH>/i);
  const contentMatch = output.match(/<XUANNIAO_DOCUMENT_CONTENT>\s*\n?([\s\S]*?)\s*<\/XUANNIAO_DOCUMENT_CONTENT>/i);
  const relativePath = pathMatch?.[1]?.trim() || "";
  const content = contentMatch?.[1]?.trim() || "";

  if (!relativePath || !content) {
    throw creationError(
      "Codex did not return a complete Xuanniao document block. Refine the request and try again.",
      502,
      "INVALID_DOCUMENT_DRAFT"
    );
  }
  if (content.length > maxDocumentLength) {
    throw creationError(
      `The generated document is too large (${content.length} characters; limit ${maxDocumentLength}).`,
      413,
      "DOCUMENT_DRAFT_TOO_LARGE"
    );
  }
  return { relativePath, content: `${content}\n` };
}

export async function writeNewDocument(workspaceRoot, relativePath, content, { isStopping = () => false } = {}) {
  assertNotStopping(isStopping);
  const root = path.resolve(workspaceRoot);
  const candidate = normalizeRelativeMarkdownPath(relativePath);
  const filePath = path.resolve(root, candidate);
  if (!isWithin(root, filePath)) {
    throw creationError(
      "Codex proposed a document path outside the current workspace.",
      502,
      "DOCUMENT_PATH_OUTSIDE_WORKSPACE"
    );
  }

  const segments = path.relative(root, filePath).split(path.sep);
  if (segments.some(isProtectedPathSegment)) {
    throw creationError(
      "Codex proposed a hidden or protected document path.",
      502,
      "DOCUMENT_PATH_PROTECTED"
    );
  }

  const parent = path.dirname(filePath);
  await assertExistingAncestorInsideRoot(root, parent);
  assertNotStopping(isStopping);
  await mkdir(parent, { recursive: true });
  await assertRealPathInsideRoot(root, parent);
  assertNotStopping(isStopping);

  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw creationError(
        `A document already exists at ${filePath}. Choose a different directory or file name and try again.`,
        409,
        "DOCUMENT_ALREADY_EXISTS"
      );
    }
    throw error;
  }
  return filePath;
}

export function resolveCreatedDocumentRelativePath(workspaceRoot, generatedPath, preferences = {}) {
  return applyDestinationPreferences(
    generatedPath,
    normalizeDestinationPreferences(path.resolve(workspaceRoot), preferences)
  );
}

function normalizeInstruction(value) {
  const instruction = String(value || "").trim();
  if (!instruction) {
    throw creationError("Describe the document you want to create.", 400, "DOCUMENT_INSTRUCTION_REQUIRED");
  }
  if (instruction.length > maxInstructionLength) {
    throw creationError(
      `The document request is too long (${instruction.length} characters; limit ${maxInstructionLength}).`,
      413,
      "DOCUMENT_INSTRUCTION_TOO_LARGE"
    );
  }
  return instruction;
}

function normalizeRelativeMarkdownPath(value) {
  const candidate = String(value || "")
    .trim()
    .replace(/^['"`]|['"`]$/g, "");
  if (!candidate || path.isAbsolute(candidate)) {
    throw creationError(
      "Codex must propose a relative Markdown path inside the workspace.",
      502,
      "INVALID_DOCUMENT_PATH"
    );
  }
  if (!markdownExtensions.has(path.extname(candidate).toLowerCase())) {
    throw creationError(
      "Codex must propose a Markdown file name.",
      502,
      "INVALID_DOCUMENT_EXTENSION"
    );
  }
  return candidate;
}

function normalizeDestinationPreferences(workspaceRoot, { directory, fileName }) {
  return {
    directory: normalizeRequestedDirectory(workspaceRoot, directory),
    fileName: normalizeRequestedFileName(fileName)
  };
}

function normalizeRequestedDirectory(workspaceRoot, value) {
  const requested = typeof value === "string" ? value.trim() : "";
  if (!requested) return { specified: false, relativePath: null };
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(workspaceRoot, requested);
  if (resolved !== workspaceRoot && !isWithin(workspaceRoot, resolved)) {
    throw creationError(
      "The selected document directory must be inside the current workspace.",
      400,
      "DOCUMENT_DIRECTORY_OUTSIDE_WORKSPACE"
    );
  }
  const relativePath = path.relative(workspaceRoot, resolved);
  const segments = relativePath ? relativePath.split(path.sep) : [];
  if (segments.some(isProtectedPathSegment)) {
    throw creationError(
      "The selected document directory is hidden or protected.",
      400,
      "DOCUMENT_DIRECTORY_PROTECTED"
    );
  }
  return { specified: true, relativePath };
}

function normalizeRequestedFileName(value) {
  let fileName = typeof value === "string" ? value.trim() : "";
  if (!fileName) return null;
  if (fileName !== path.basename(fileName) || fileName.includes("\\") || fileName.startsWith(".")) {
    throw creationError(
      "The document file name must not contain a directory or start with a dot.",
      400,
      "INVALID_DOCUMENT_FILE_NAME"
    );
  }
  if (!path.extname(fileName)) fileName = `${fileName}.md`;
  if (!markdownExtensions.has(path.extname(fileName).toLowerCase())) {
    throw creationError(
      "The selected document file name must use a Markdown extension.",
      400,
      "INVALID_DOCUMENT_EXTENSION"
    );
  }
  return fileName;
}

function applyDestinationPreferences(generatedPath, preferences) {
  const generated = normalizeRelativeMarkdownPath(generatedPath);
  const generatedDirectory = path.dirname(generated) === "." ? "" : path.dirname(generated);
  const directory = preferences.directory.specified
    ? preferences.directory.relativePath
    : generatedDirectory;
  return path.join(directory, preferences.fileName || path.basename(generated));
}

function isProtectedPathSegment(segment) {
  return !segment || segment.startsWith(".") || forbiddenPathSegments.has(segment.toLowerCase());
}

async function assertExistingAncestorInsideRoot(root, target) {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  await assertRealPathInsideRoot(root, current);
}

async function assertRealPathInsideRoot(root, target) {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (realTarget !== realRoot && !isWithin(realRoot, realTarget)) {
    throw creationError(
      "The proposed document directory resolves outside the current workspace.",
      502,
      "DOCUMENT_PATH_OUTSIDE_WORKSPACE"
    );
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function creationError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function assertNotStopping(isStopping) {
  if (isStopping()) throw creationError("文档创建已中断，未继续生成或写入新文档。", 409, "AGENT_INTERRUPTED");
}
