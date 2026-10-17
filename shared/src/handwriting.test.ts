import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HANDWRITING,
  isStrokeOrderMistake,
  ratingForHandwriting,
  type HandwritingResult,
  type Point,
} from './handwriting.js';

// Make Me a Hanzi medians for 十 (horizontal, then vertical).
const SHI: [number, number][][] = [
  [
    [109, 442],
    [177, 422],
    [373, 456],
    [819, 505],
    [869, 499],
    [932, 476],
  ],
  [
    [456, 811],
    [484, 803],
    [522, 767],
    [512, 593],
    [507, -33],
  ],
];

/** A hand-drawn version of a median: resampled and a little wobbly. */
function drawn(median: [number, number][], wobble = 20): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < median.length - 1; i++) {
    const [a, b] = [median[i]!, median[i + 1]!];
    for (let t = 0; t < 1; t += 0.25) {
      const jitter = (i + t) % 0.5 === 0 ? wobble : -wobble;
      points.push({
        x: a[0] + (b[0] - a[0]) * t + jitter,
        y: a[1] + (b[1] - a[1]) * t - jitter,
      });
    }
  }
  const [x, y] = median.at(-1)!;
  points.push({ x, y });
  return points;
}

describe('isStrokeOrderMistake', () => {
  it('recognizes a later stroke drawn first', () => {
    // 十: drawing the vertical when the horizontal is expected.
    expect(isStrokeOrderMistake(drawn(SHI[1]!), SHI, 0)).toBe(true);
  });

  it('does not flag a stroke that matches nothing', () => {
    const scribble: Point[] = [
      { x: 900, y: 850 },
      { x: 950, y: 800 },
      { x: 1000, y: 850 },
    ];
    expect(isStrokeOrderMistake(scribble, SHI, 0)).toBe(false);
  });

  it('does not flag a sloppy attempt at the expected stroke', () => {
    expect(isStrokeOrderMistake(drawn(SHI[0]!, 60), SHI, 0)).toBe(false);
  });

  it('does not look at strokes already drawn', () => {
    // Redrawing the horizontal while the vertical is expected.
    expect(isStrokeOrderMistake(drawn(SHI[0]!), SHI, 1)).toBe(false);
  });

  it('accepts [x, y] pairs as well as points', () => {
    expect(isStrokeOrderMistake(SHI[1]!, SHI, 0)).toBe(true);
  });
});

describe('ratingForHandwriting', () => {
  const result = (r: Partial<HandwritingResult> = {}): HandwritingResult => ({
    strokes: 8,
    misses: 0,
    orderMisses: 0,
    hinted: false,
    revealed: false,
    ...r,
  });
  const strict = DEFAULT_HANDWRITING; // allowedMisses: 2
  const lenient = { ...strict, strokeOrder: 'lenient' } as const;

  it('rates a clean character Good', () => {
    expect(ratingForHandwriting(result(), strict)).toBe(3);
  });

  it('rates up to the allowed misses Hard, more Again', () => {
    expect(ratingForHandwriting(result({ misses: 1 }), strict)).toBe(2);
    expect(ratingForHandwriting(result({ misses: 2 }), strict)).toBe(2);
    expect(ratingForHandwriting(result({ misses: 3 }), strict)).toBe(1);
    expect(
      ratingForHandwriting(result({ misses: 1 }), {
        ...strict,
        allowedMisses: 0,
      }),
    ).toBe(1);
  });

  it('rates any hint or giving up Again', () => {
    expect(ratingForHandwriting(result({ hinted: true }), strict)).toBe(1);
    expect(ratingForHandwriting(result({ revealed: true }), strict)).toBe(1);
  });

  it('forgives stroke-order misses only in lenient mode', () => {
    const outOfOrder = result({ misses: 3, orderMisses: 3 });
    expect(ratingForHandwriting(outOfOrder, strict)).toBe(1);
    expect(ratingForHandwriting(outOfOrder, lenient)).toBe(3);
    expect(
      ratingForHandwriting(result({ misses: 4, orderMisses: 3 }), lenient),
    ).toBe(2);
  });
});
