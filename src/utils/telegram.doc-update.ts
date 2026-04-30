interface UpdatedPage {
  relPath: string;
  pageUrl: string;
}

export function formatDocUpdateTelegramMessage(pages: UpdatedPage[]): string {
  const lines = pages.slice(0, 10).map(p => `• <a href="${p.pageUrl}">${p.relPath}</a>`);
  const extra = pages.length > 10 ? `\n<i>...and ${pages.length - 10} more</i>` : '';
  const count = pages.length === 1 ? '1 page updated' : `${pages.length} pages updated`;
  return `📚 <b>Hyperliquid Docs Updated</b>\n\n${lines.join('\n')}${extra}\n\n<i>${count}</i>`;
}
