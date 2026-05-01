export interface UpdatedPage {
  relPath: string;
  pageUrl: string;
  oldContent?: string | null;
  newContent?: string;
}

export function formatDocUpdateTelegramMessage(pages: UpdatedPage[]): string {
  const header = `📚 <b>Hyperliquid Docs Updated</b>`;
  const count = pages.length === 1 ? '1 page updated' : `${pages.length} pages updated`;

  const MAX_TOTAL = 3800;
  const sections: string[] = [];
  let totalLen = header.length + count.length + 10;

  for (const page of pages.slice(0, 10)) {
    const link = `• <b>${escapeHtml(page.relPath)}</b> — <a href="${page.pageUrl}">view</a>`;
    let section = link;

    if (page.oldContent != null && page.newContent != null) {
      const diff = computeLineDiff(page.oldContent, page.newContent);
      const diffText = formatDiffLines(diff.added, diff.removed);
      if (diffText) section += '\n' + diffText;
    }

    if (totalLen + section.length + 2 > MAX_TOTAL) break;
    sections.push(section);
    totalLen += section.length + 2;
  }

  const hidden = pages.length - sections.length;
  const extra = hidden > 0 ? `\n<i>...and ${hidden} more page${hidden > 1 ? 's' : ''}</i>` : '';

  return `${header}\n\n${sections.join('\n\n')}${extra}\n\n<i>${count}</i>`;
}

function formatDiffLines(added: string[], removed: string[]): string {
  const lines: string[] = [];
  for (const l of added.slice(0, 4)) {
    lines.push(`  🟢 ${escapeHtml(truncateLine(l))}`);
  }
  for (const l of removed.slice(0, 2)) {
    lines.push(`  🔴 ${escapeHtml(truncateLine(l))}`);
  }
  return lines.join('\n');
}

function computeLineDiff(oldContent: string, newContent: string): { added: string[]; removed: string[] } {
  const normalize = (content: string): Set<string> =>
    new Set(
      content
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length >= 20 && !/^[#\-=*|> ]+$/.test(l) && !/^\|[-|: ]+\|$/.test(l))
    );

  const oldLines = normalize(oldContent);
  const newLines = normalize(newContent);

  const added = [...newLines].filter(l => !oldLines.has(l));
  const removed = [...oldLines].filter(l => !newLines.has(l));

  return { added, removed };
}

function truncateLine(line: string, max = 90): string {
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
