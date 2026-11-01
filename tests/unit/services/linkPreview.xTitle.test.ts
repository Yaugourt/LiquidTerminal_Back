import { isXHost, parseXAuthor, xHeadline, xPreviewText } from '../../../src/services/linkPreview/xTitle';

describe('X preview titles', () => {
  it('turns the post body into a one-line headline and keeps the author line', () => {
    const out = xPreviewText(
      'NPC68 (@NPC_68) on X',
      'HyperEVM farming: Part 6\n\n🔸 Buy $uBTC or $uETH on Hyperliquid\n🔸 Bridge to HyperEVM',
    );
    expect(out).toEqual({ title: 'HyperEVM farming: Part 6', description: 'NPC68 (@NPC_68) on X' });
  });

  it('keeps an X article title as it is', () => {
    const out = xPreviewText('Revenue Over Hype: How HyperLiquid Rewrote the Playbook', 'Eduardo (@emaverick90) on X');
    expect(out.title).toBe('Revenue Over Hype: How HyperLiquid Rewrote the Playbook');
  });

  it('drops links and cuts long lines at a word boundary', () => {
    expect(xHeadline('https://t.co/abc\n  Read this https://x.com/a now')).toBe('Read this now');
    const long = 'word '.repeat(60).trim();
    const h = xHeadline(long)!;
    expect(h.length).toBeLessThanOrEqual(141);
    expect(h.endsWith('…')).toBe(true);
    expect(h).not.toMatch(/\s…$/);
  });

  it('skips thread markers and lone emoji, and extends a too-short first line', () => {
    expect(xHeadline('1/\nWelcome to Hyperliquid, your new home')).toBe('Welcome to Hyperliquid, your new home');
    expect(xHeadline('🦖\n\nThe HyperEVM is live')).toBe('The HyperEVM is live');
    expect(xHeadline('HYPE.\nThe alignment vehicle explained')).toBe('HYPE. The alignment vehicle explained');
    expect(xHeadline("What's HIP-3 and why it matters")).toBe("What's HIP-3 and why it matters");
  });

  it('reads the author line and recognises X hosts', () => {
    expect(parseXAuthor('jeff.hl (@chameleon_jeff) on X')).toEqual({ name: 'jeff.hl', handle: 'chameleon_jeff' });
    expect(parseXAuthor('Just a title')).toBeNull();
    expect(isXHost('x.com')).toBe(true);
    expect(isXHost('mobile.twitter.com')).toBe(true);
    expect(isXHost('xx.com')).toBe(false);
  });
});
