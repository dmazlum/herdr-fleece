export interface CodeBlock {
  lang?: string;
  code: string;
}

/** Pulls fenced code blocks out of Markdown, keeping their order and language. */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = markdown.split("\n");

  let fence: string | null = null;
  let lang: string | undefined;
  let buffer: string[] = [];

  for (const line of lines) {
    const opening = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);

    if (fence === null) {
      if (opening) {
        fence = opening[1]!.charAt(0);
        lang = opening[2] === "" ? undefined : opening[2];
        buffer = [];
      }
      continue;
    }

    // Inside a fence: only a bare fence of the same character closes it.
    if (opening && opening[1]!.charAt(0) === fence && opening[2] === "") {
      blocks.push({ lang, code: buffer.join("\n") });
      fence = null;
      lang = undefined;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }

  // An unterminated fence still holds usable code — a truncated answer, say.
  if (fence !== null && buffer.length > 0) {
    blocks.push({ lang, code: buffer.join("\n") });
  }

  return blocks;
}

/** The code blocks alone, ready for the clipboard. */
export function codeOnly(markdown: string): string {
  return extractCodeBlocks(markdown)
    .map((block) => block.code.replace(/\s+$/, ""))
    .filter((code) => code !== "")
    .join("\n\n");
}
