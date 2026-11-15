import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../src/data/openMeteo';
import { fetchEnsembleProbability, type EnsembleOptions } from '../src/data/ensemble';

const EVENT = Date.UTC(2026, 10, 3, 9, 5);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

const ensembleOptions = (lat = 31.23): EnsembleOptions => ({
  point: { lat, lon: 121.47 }, eventMs: EVENT, mode: 'sunset',
  tzOffsetSeconds: 28800, azimuthDeg: 250, altitudeAt: () => -1.5,
});

function responseFor(hourly: Record<string, unknown>, utcOffsetSeconds: number): Record<string, unknown> {
  return { hourly, utc_offset_seconds: utcOffsetSeconds };
}

function memberFields(time: string[], cloudMid?: number[]): Record<string, unknown> {
  const hourly: Record<string, unknown> = { time };
  for (let member = 1; member <= 5; member++) {
    const suffix = `_member${String(member).padStart(2, '0')}`;
    for (const base of ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high']) {
      hourly[`${base}${suffix}`] = time.map((_, i) => base === 'cloud_cover_mid' && cloudMid ? cloudMid[i] : 0);
    }
    for (const base of ['direct_radiation', 'diffuse_radiation', 'precipitation']) {
      hourly[`${base}${suffix}`] = time.map(() => 0);
    }
  }
  return hourly;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('数据请求取消与共享生命周期', () => {
  it('带 signal 的取消不会中止或删除同 URL 的共享请求', async () => {
    const pending: Array<{ signal?: AbortSignal | null; resolve: (r: Response) => void; reject: (e: Error) => void }> = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      pending.push({ signal, resolve, reject });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const url = 'https://offline.test/same-resource';
    const shared = fetchJson<{ ok: boolean }>(url);
    const ac = new AbortController();
    const cancelled = fetchJson<{ ok: boolean }>(url, 0, ac.signal);
    ac.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sharedCall = pending.find((p) => !p.signal)!;
    sharedCall.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(shared).resolves.toEqual({ ok: true });
  });

  it('集合取消与共享请求隔离，且全零峰值仍计入概率分母', async () => {
    const pending: Array<{ signal?: AbortSignal | null; resolve: (r: Response) => void; reject: (e: Error) => void }> = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      pending.push({ signal, resolve, reject });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const opts = ensembleOptions();
    const shared = fetchEnsembleProbability(opts);
    const ac = new AbortController();
    const cancelled = fetchEnsembleProbability(opts, ac.signal);
    ac.abort();
    await expect(cancelled).resolves.toBeNull();

    const raw = [0, 1, 2].map(() => responseFor(memberFields(['2026-11-03T17:00', '2026-11-03T18:00']), 28800));
    pending.find((p) => !p.signal)!.resolve(new Response(JSON.stringify(raw), { status: 200 }));
    const result = await shared;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    expect(result!.probability).toBe(0);
    expect(result!.members).toBe(5);
    expect(result!.p50).toBe(0);
    expect(Number.isNaN(result!.peakOffsetP50)).toBe(true);
  });

  it('每个集合环使用自己的时区时间轴，跨时区不会制造假峰值', async () => {
    const fetchMock = vi.fn(() => {
      const raw = [
        responseFor(memberFields(['2026-11-03T17:00', '2026-11-03T18:00']), 28800),
        // 第二环 +9：16/17 点实际是 07/08 UTC，已在评分窗之前结束。
        responseFor(memberFields(['2026-11-03T16:00', '2026-11-03T17:00'], [100, 0]), 32400),
        responseFor(memberFields(['2026-11-03T17:00', '2026-11-03T18:00']), 28800),
      ];
      return Promise.resolve(new Response(JSON.stringify(raw), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchEnsembleProbability(ensembleOptions(31.24));
    expect(result).not.toBeNull();
    expect(result!.probability).toBe(0);
    expect(result!.p50).toBe(0);
    expect(Number.isNaN(result!.peakOffsetP50)).toBe(true);
  });
});
