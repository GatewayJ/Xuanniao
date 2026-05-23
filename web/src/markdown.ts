import MarkdownIt from "markdown-it";
import mermaid from "mermaid";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
const messageMd = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true });

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });

const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const sourceLine = sourceLineAttribute(token);
  if (token.info.trim().split(/\s+/)[0] === "mermaid") {
    return `<div class="mermaidBlock"${sourceLine} data-mermaid="${encodeURIComponent(token.content)}"></div>`;
  }
  const rendered = defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  return sourceLine ? `<div class="previewFence"${sourceLine}>${rendered}</div>` : rendered;
};

addSourceLineRule("heading_open");
addSourceLineRule("paragraph_open");
addSourceLineRule("blockquote_open");
addSourceLineRule("bullet_list_open");
addSourceLineRule("ordered_list_open");
addSourceLineRule("list_item_open");

export function renderMarkdown(content: string): string {
  return md.render(content);
}

export function renderMessageMarkdown(content: string): string {
  return messageMd.render(content);
}

export async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")];
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

function addSourceLineRule(ruleName: string) {
  const defaultRule = md.renderer.rules[ruleName];
  md.renderer.rules[ruleName] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const line = token.map?.[0];
    if (typeof line === "number") {
      token.attrSet("data-source-line", String(line + 1));
    }
    return defaultRule ? defaultRule(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

function sourceLineAttribute(token: { map: [number, number] | null }): string {
  const line = token.map?.[0];
  return typeof line === "number" ? ` data-source-line="${line + 1}"` : "";
}
