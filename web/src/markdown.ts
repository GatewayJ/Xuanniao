import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
const messageMd = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true });
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

type MarkdownRenderEnvironment = {
  sourceLineOffsets: number[];
  sourceLength: number;
};

const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const sourceRange = sourceRangeAttributes(token, env as MarkdownRenderEnvironment | undefined);
  if (token.info.trim().split(/\s+/)[0] === "mermaid") {
    return `<div class="mermaidBlock"${sourceRange} data-mermaid="${encodeURIComponent(token.content)}"></div>`;
  }
  const rendered = defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  return sourceRange ? `<div class="previewFence"${sourceRange}>${rendered}</div>` : rendered;
};

for (const ruleName of [
  "heading_open",
  "paragraph_open",
  "blockquote_open",
  "bullet_list_open",
  "ordered_list_open",
  "list_item_open",
  "table_open",
  "thead_open",
  "tbody_open",
  "tr_open",
  "th_open",
  "td_open"
]) {
  addSourceRangeRule(ruleName);
}

export function renderMarkdown(content: string): string {
  return md.render(content, {
    sourceLineOffsets: lineOffsets(content),
    sourceLength: content.length
  } satisfies MarkdownRenderEnvironment);
}

export function renderMessageMarkdown(content: string): string {
  return messageMd.render(content);
}

export async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")];
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  await Promise.all(blocks.map(async (block, index) => {
    const source = decodeURIComponent(block.dataset.mermaid || "");
    try {
      const { svg } = await mermaid.render(`xuanniao-mermaid-${Date.now()}-${index}`, source);
      block.innerHTML = [
        '<div class="diagramToolbar">',
        "<span>Mermaid</span>",
        '<button type="button" data-diagram-action="open">Fullscreen</button>',
        "</div>",
        '<div class="diagramCanvas">',
        svg,
        "</div>"
      ].join("");
      sizeMermaidSvg(block);
      block.classList.remove("mermaidError");
    } catch (error) {
      block.classList.add("mermaidError");
      block.textContent = error instanceof Error ? error.message : String(error);
    }
  }));
}

async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default"
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

function sizeMermaidSvg(block: HTMLElement) {
  const svg = block.querySelector<SVGSVGElement>("svg");
  if (!svg) return;
  const viewBox = svg.viewBox.baseVal;
  const width = viewBox?.width || Number(svg.getAttribute("width")) || 0;
  if (width > 0) {
    svg.style.width = `${Math.max(width, 560)}px`;
  }
  svg.style.maxWidth = "none";
  svg.style.height = "auto";
}

function addSourceRangeRule(ruleName: string) {
  const defaultRule = md.renderer.rules[ruleName];
  md.renderer.rules[ruleName] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const [lineStart, lineEnd] = token.map || [];
    const renderEnvironment = env as MarkdownRenderEnvironment | undefined;
    if (typeof lineStart === "number") {
      token.attrSet("data-source-line", String(lineStart + 1));
      const start = renderEnvironment?.sourceLineOffsets[lineStart];
      const end = typeof lineEnd === "number"
        ? renderEnvironment?.sourceLineOffsets[lineEnd] ?? renderEnvironment?.sourceLength
        : undefined;
      if (typeof start === "number" && typeof end === "number") {
        token.attrSet("data-source-start", String(start));
        token.attrSet("data-source-end", String(end));
      }
    }
    return defaultRule ? defaultRule(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

function sourceRangeAttributes(
  token: { map: [number, number] | null },
  environment?: MarkdownRenderEnvironment
): string {
  const [lineStart, lineEnd] = token.map || [];
  if (typeof lineStart !== "number") return "";
  const start = environment?.sourceLineOffsets[lineStart];
  const end = typeof lineEnd === "number"
    ? environment?.sourceLineOffsets[lineEnd] ?? environment?.sourceLength
    : undefined;
  const range = typeof start === "number" && typeof end === "number"
    ? ` data-source-start="${start}" data-source-end="${end}"`
    : "";
  return ` data-source-line="${lineStart + 1}"${range}`;
}

function lineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}
