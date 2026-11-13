"use client";

import { useMemo, type ReactNode } from "react";

/** OCR 结果中的块：段落、标题、列表、表格、公式与分页标记。 */
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "html-table"; html: string }
  | { kind: "pipe-table"; rows: string[][] }
  | { kind: "math"; text: string }
  | { kind: "code"; text: string }
  | { kind: "page"; page: number }
  | { kind: "rule" };

function splitPipeRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) { index += 1; continue; }
    const page = trimmed.match(/^<!--\s*page\s+(\d+)\s*-->$/i);
    if (page) { blocks.push({ kind: "page", page: Number(page[1]) }); index += 1; continue; }
    if (/^<!--.*-->$/.test(trimmed)) { index += 1; continue; }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { blocks.push({ kind: "rule" }); index += 1; continue; }
    if (/^<table[\s>]/i.test(trimmed)) {
      const buffer: string[] = [];
      while (index < lines.length) {
        buffer.push(lines[index]);
        if (/<\/table>/i.test(lines[index])) { index += 1; break; }
        index += 1;
      }
      blocks.push({ kind: "html-table", html: buffer.join("\n") });
      continue;
    }
    if (trimmed.startsWith("```")) {
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) buffer.push(lines[index++]);
      index += 1;
      blocks.push({ kind: "code", text: buffer.join("\n") });
      continue;
    }
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const closing = trimmed.startsWith("$$") ? "$$" : "\\]";
      const buffer = [trimmed.slice(2)];
      if (!(trimmed.length > 2 && trimmed.endsWith(closing))) {
        index += 1;
        while (index < lines.length && !lines[index].trim().endsWith(closing)) buffer.push(lines[index++]);
        if (index < lines.length) buffer.push(lines[index].trim());
      }
      index += 1;
      blocks.push({ kind: "math", text: buffer.join("\n").replace(closing === "$$" ? /\$\$$/ : /\\\]$/, "").trim() });
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); index += 1; continue; }
    if (trimmed.startsWith("|") && index + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[index + 1].trim())) {
      const rows = [splitPipeRow(trimmed)];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) rows.push(splitPipeRow(lines[index++]));
      blocks.push({ kind: "pipe-table", rows });
      continue;
    }
    const listMatch = trimmed.match(/^([-*+]|\d+[.)])\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^([-*+]|\d+[.)])\s+(.*)$/);
        if (!item || /\d/.test(item[1]) !== ordered) break;
        items.push(item[2]);
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const buffer = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || /^(#{1,6}\s|<table|\$\$|\\\[|```|[-*+]\s|\d+[.)]\s|\||<!--|-{3,}$)/i.test(next)) break;
      buffer.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: buffer.join("\n") });
  }
  return blocks;
}

/** 行内仅处理加粗、行内代码与行内公式，其余 HTML 标签按纯文本去除。 */
function inline(text: string): ReactNode[] {
  const plain = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[a-z][^>]*>/gi, "");
  const parts = plain.split(/(\*\*[^*]+\*\*|`[^`]+`|\$[^$\n]+\$)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("$") && part.endsWith("$") && part.length > 2) return <code className="ocr-inline-math" key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}

/** 用 DOMParser 解析模型输出的表格，只取单元格文本与合并属性，避免注入任意 HTML。 */
function HtmlTable({ html }: { html: string }) {
  const rows = useMemo(() => {
    if (typeof DOMParser === "undefined") return [];
    const documentNode = new DOMParser().parseFromString(html, "text/html");
    return Array.from(documentNode.querySelectorAll("tr")).map(row => Array.from(row.querySelectorAll("th, td")).map(cell => ({
      header: cell.tagName === "TH",
      text: cell.textContent?.trim() || "",
      colSpan: Math.max(1, Number(cell.getAttribute("colspan")) || 1),
      rowSpan: Math.max(1, Number(cell.getAttribute("rowspan")) || 1),
    })));
  }, [html]);
  if (!rows.length) return <pre className="ocr-code">{html}</pre>;
  return <div className="ocr-table-wrap"><table><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => cell.header
    ? <th key={cellIndex} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>{inline(cell.text)}</th>
    : <td key={cellIndex} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>{inline(cell.text)}</td>)}</tr>)}</tbody></table></div>;
}

/** 字段提取通常返回 JSON，能解析时格式化展示。 */
function formatJson(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

export function OcrResultView({ text }: { text: string }) {
  const json = formatJson(text);
  if (json !== null) return <pre className="ocr-code">{json}</pre>;
  const blocks = parseBlocks(text);
  return <div className="ocr-markdown">{blocks.map((block, index) => {
    switch (block.kind) {
      case "heading": {
        const Tag = block.level <= 1 ? "h3" : block.level === 2 ? "h4" : "h5";
        return <Tag key={index}>{inline(block.text)}</Tag>;
      }
      case "paragraph": return <p key={index}>{inline(block.text)}</p>;
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return <Tag key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</Tag>;
      }
      case "html-table": return <HtmlTable key={index} html={block.html} />;
      case "pipe-table": return <div className="ocr-table-wrap" key={index}><table><thead><tr>{block.rows[0].map((cell, cellIndex) => <th key={cellIndex}>{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
      case "math": return <pre className="ocr-math" key={index}>{block.text}</pre>;
      case "code": return <pre className="ocr-code" key={index}>{block.text}</pre>;
      case "page": return <div className="ocr-page-mark" key={index}>第 {block.page} 页</div>;
      case "rule": return <hr key={index} />;
    }
  })}</div>;
}
