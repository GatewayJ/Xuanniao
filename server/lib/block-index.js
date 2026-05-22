import { createHash } from "node:crypto";

export function buildBlockIndex(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let inCode = false;
  let codeStart = 0;
  let codeLines = [];
  let paragraphStart = null;
  let paragraphLines = [];
  let currentSection = "";

  const flushParagraph = (endLine) => {
    if (paragraphStart === null) {
      return;
    }
    const content = paragraphLines.join("\n");
    blocks.push(makeBlock({
      type: paragraphLines.every((line) => /^\s*[-*+]\s+/.test(line)) ? "list" : "paragraph",
      content,
      lineStart: paragraphStart + 1,
      lineEnd: endLine,
      sectionTitle: currentSection
    }));
    paragraphStart = null;
    paragraphLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^\s*```/.test(line)) {
      if (!inCode) {
        flushParagraph(index);
        inCode = true;
        codeStart = index;
        codeLines = [line];
      } else {
        codeLines.push(line);
        blocks.push(makeBlock({
          type: "code",
          content: codeLines.join("\n"),
          lineStart: codeStart + 1,
          lineEnd: index + 1,
          sectionTitle: currentSection
        }));
        inCode = false;
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flushParagraph(index);
      currentSection = heading[2];
      blocks.push(makeBlock({
        type: "heading",
        content: line,
        lineStart: index + 1,
        lineEnd: index + 1,
        sectionTitle: currentSection,
        depth: heading[1].length
      }));
      continue;
    }

    if (!line.trim()) {
      flushParagraph(index);
      continue;
    }

    if (paragraphStart === null) {
      paragraphStart = index;
    }
    paragraphLines.push(line);
  }

  if (inCode) {
    blocks.push(makeBlock({
      type: "code",
      content: codeLines.join("\n"),
      lineStart: codeStart + 1,
      lineEnd: lines.length,
      sectionTitle: currentSection
    }));
  } else {
    flushParagraph(lines.length);
  }

  return blocks;
}

function makeBlock({ type, content, lineStart, lineEnd, sectionTitle, depth = null }) {
  const hash = createHash("sha1").update(`${type}\n${lineStart}\n${content}`).digest("hex").slice(0, 10);
  return {
    id: `b${lineStart}-${hash}`,
    type,
    content,
    lineStart,
    lineEnd,
    sectionTitle,
    depth
  };
}
