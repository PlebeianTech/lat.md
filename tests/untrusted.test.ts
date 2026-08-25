import { describe, it, expect } from 'vitest';
import { cleanUntrusted, quoteUntrusted, UNTRUSTED_NOTICE } from '../src/untrusted.js';

describe('cleanUntrusted', () => {
  it('collapses a newline into one line', () => {
    expect(cleanUntrusted('first line\nsecond line')).toBe(
      'first line second line',
    );
  });

  it('removes an ASCII control character', () => {
    expect(cleanUntrusted('foo\x07bar')).toBe('foo bar');
  });

  it('removes a bidi override and a zero-width space', () => {
    expect(cleanUntrusted('foo\u202Ebar\u200Bbaz')).toBe('foobarbaz');
  });

  it('collapses runs of whitespace to one space', () => {
    expect(cleanUntrusted('foo   \t  bar')).toBe('foo bar');
  });

  it('truncates text longer than the cap and appends the marker', () => {
    const long = 'a'.repeat(310);
    const result = cleanUntrusted(long, 300);
    expect(result).toBe('a'.repeat(300) + '…');
  });

  it('does not truncate text at or under the cap', () => {
    const exact = 'a'.repeat(300);
    expect(cleanUntrusted(exact, 300)).toBe(exact);
    const under = 'a'.repeat(299);
    expect(cleanUntrusted(under, 300)).toBe(under);
  });

  it('is safe on empty input', () => {
    expect(cleanUntrusted('')).toBe('');
  });

  it('is safe on all-control-character input', () => {
    expect(cleanUntrusted('\x01\x02\x03\x1f\x7f')).toBe('');
  });
});

describe('quoteUntrusted', () => {
  it('wraps cleaned text in double quotes', () => {
    expect(quoteUntrusted('hello')).toBe('"hello"');
  });

  it('replaces an internal double quote so it cannot break out of the quoting', () => {
    expect(quoteUntrusted('say "hi" now')).toBe('"say \'hi\' now"');
  });

  it('is safe on empty input', () => {
    expect(quoteUntrusted('')).toBe('""');
  });

  it('is safe on all-control-character input', () => {
    expect(quoteUntrusted('\x01\x02\x03')).toBe('""');
  });
});

describe('UNTRUSTED_NOTICE', () => {
  it('is a non-empty single-line string that calls the text untrusted', () => {
    expect(UNTRUSTED_NOTICE.length).toBeGreaterThan(0);
    expect(UNTRUSTED_NOTICE).not.toContain('\n');
    expect(UNTRUSTED_NOTICE.toLowerCase()).toContain('untrusted');
  });
});

describe('cleanUntrusted: control ranges beyond C0', () => {
  it('removes every C1 control, not just C0 and DEL', () => {
    for (let i = 0x80; i <= 0x9f; i++) {
      expect(cleanUntrusted('a' + String.fromCharCode(i) + 'b')).toBe('a b');
    }
  });

  it('removes the single-byte CSI that starts a terminal escape', () => {
    // U+009B is the 8-bit equivalent of the ESC [ pair, so stripping only C0
    // would leave an escape sequence intact.
    expect(cleanUntrusted('a' + String.fromCharCode(0x9b) + '31mRED')).toBe(
      'a 31mRED',
    );
  });

  it('removes NEL, which JavaScript \\s does not treat as whitespace', () => {
    expect(cleanUntrusted('a' + String.fromCharCode(0x85) + 'b')).toBe('a b');
  });
});

describe('cleanUntrusted: truncation boundary', () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

  it('never splits a surrogate pair at the cap', () => {
    const emoji = String.fromCodePoint(0x1f600);
    // Slide the pair across the boundary so one offset lands mid-pair.
    for (let pad = 296; pad <= 302; pad++) {
      const out = cleanUntrusted('a'.repeat(pad) + emoji + 'bbb', 300);
      expect(out).not.toMatch(LONE_SURROGATE);
      expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    }
  });
});
