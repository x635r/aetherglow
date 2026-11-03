import { describe, expect, it } from 'vitest';
import { sunEvent } from '../src/engine/astro';
import { resolveEvent } from '../src/data/openMeteo';

describe('极区边界', () => {
  it('78N 12月无日出日落 → sunEvent 返回 null', () => {
    const d = Date.UTC(2026, 11, 21, 0, 0, 0);
    expect(sunEvent(d, 78.2, 15.6, 'sunrise')).toBeNull();
    expect(sunEvent(d, 78.2, 15.6, 'sunset')).toBeNull();
  });

  it('78N 6月极昼无日落 → sunEvent 返回 null', () => {
    expect(sunEvent(Date.UTC(2026, 5, 21, 0, 0, 0), 78.2, 15.6, 'sunset')).toBeNull();
  });

  it('resolveEvent 在极夜时仍有兜底时刻（不抛错）', () => {
    const r = resolveEvent({ lat: 78.2, lon: 15.6 }, '2026-12-21', 'sunrise');
    expect(Number.isFinite(r.eventMs)).toBe(true);
    expect(r.eventMs).toBeGreaterThan(0);
  });
});
