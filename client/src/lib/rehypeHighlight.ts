import { createLowlight } from "lowlight";
import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";

import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Syntax highlighting over an explicit language set.
 *
 * This replaces `rehype-highlight`, which was the single largest item in the
 * bundle. Measured, gzipped:
 *
 *   markdown only                 49.1 kB
 *   + rehype-highlight           101.9 kB
 *   + this (14 languages)         73.6 kB
 *
 * rehype-highlight accepts a `languages` option and does honour it —
 * `settings.languages || common` — but it imports `common` statically at
 * module scope, so every one of lowlight's ~37 default grammars stays in the
 * bundle whether or not they are ever registered. Configuration cannot
 * remove a static import; only not importing the module can.
 *
 * Hence a local plugin: about thirty lines doing what rehype-highlight does,
 * against a lowlight instance built from the languages this app will
 * actually encounter.
 */
const lowlight = createLowlight({
  bash,
  cpp,
  csharp,
  css,
  go,
  java,
  javascript,
  json,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
});

/** Aliases people write in a fence that are not the grammar's own name. */
const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  html: "xml",
  "c++": "cpp",
  cs: "csharp",
};

function languageOf(node: Element): string | null {
  const classes = node.properties?.className;
  if (!Array.isArray(classes)) return null;

  for (const entry of classes) {
    const name = String(entry);
    if (!name.startsWith("language-")) continue;

    const raw = name.slice("language-".length).toLowerCase();
    return ALIASES[raw] ?? raw;
  }

  return null;
}

/**
 * Highlights fenced code blocks in place.
 *
 * Only `<code>` directly inside `<pre>` is touched — inline code stays plain,
 * which is what the styling expects and avoids highlighting a stray word in
 * a sentence.
 */
export function rehypeHighlight() {
  return (tree: Root): void => {
    visit(tree, "element", (node: Element, _index, parent) => {
      if (node.tagName !== "code") return;
      if (!parent || parent.type !== "element" || parent.tagName !== "pre") return;

      const language = languageOf(node);
      // An unregistered or absent language renders as plain text rather than
      // throwing. A code block in an unsupported language is still readable;
      // a crashed render is not.
      if (!language || !lowlight.registered(language)) return;

      const text = toText(node);
      if (text.length === 0) return;

      try {
        const result = lowlight.highlight(language, text);
        node.children = result.children as Element["children"];

        const classes = Array.isArray(node.properties.className)
          ? node.properties.className
          : [];
        // `hljs` is what the stylesheet hooks onto for the block background.
        node.properties.className = [...classes, "hljs"];
      } catch {
        // Leave the block untouched — plain but correct.
      }
    });
  };
}

function toText(node: Element): string {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "element") out += toText(child);
  }
  return out;
}
