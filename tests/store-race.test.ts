import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScenario } from './calibrationScenarios';

const loadForecastBundleMock = vi.hoisted(() => vi.fn());

vi.mock('../src/data/openMeteo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/openMeteo')>();
  return {
    ...actual,
    loadForecastBundle: loadForecastBundleMock,
    resolveEvent: vi.fn(() => ({
      eventMs: Date.UTC(2026, 10, 3, 9, 5), azimuthDeg: 250, exists: true,
    })),
  };
});
vi.mock('../src/data/ensemble', () => ({ fetchEnsembleProbability: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/data/ozone', () => ({ fetchOzoneColumn: vi.fn().mockResolvedValue(null) }));

import { useStore } from '../src/state/store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const baseQuery = {
  point: { lat: 31.23, lon: 121.47 }, label: 'old', dateISO: '2026-11-03',
  mode: 'sunset' as const, observerHeightM: 0, primaryModel: 'ecmwf' as const,
  models: ['ecmwf' as const],
};

beforeEach(() => {
  loadForecastBundleMock.mockReset();
  useStore.setState({
    query: baseQuery, status: 'idle', error: null, bundle: null, resolved: null,
    prediction: null, lastLoadedAt: null, fromCache: false, stale: false,
    staleAgeMs: 0, staleReason: null, quotaResetAtMs: 0, ozoneDu: 300,
  });
});

describe('store 请求竞态', () => {
  it('旧请求即使忽略 abort 且最后成功，也不能覆盖新地点结果', async () => {
    const oldRequest = deferred<never>();
    const newRequest = deferred<never>();
    loadForecastBundleMock
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);

    const oldLoad = useStore.getState().load();
    useStore.setState({
      query: { ...baseQuery, point: { lat: 22.3, lon: 114.17 }, label: 'new' },
    });
    const newLoad = useStore.getState().load();

    const oldBundle = buildScenario({ name: 'old', cover: { '600': 0.45 }, expect: [0, 2] });
    const newBundle = buildScenario({ name: 'new', cover: { '600': 0.55 }, expect: [0, 2] });
    oldBundle.fetchedAt = 1;
    newBundle.fetchedAt = 2;

    newRequest.resolve({
      bundle: newBundle, tzOffsetSeconds: 28800, tzName: 'Asia/Shanghai', stale: false,
    } as never);
    await newLoad;
    expect(useStore.getState().bundle).toBe(newBundle);
    expect(useStore.getState().prediction?.locationLabel).toBe('new');

    oldRequest.resolve({
      bundle: oldBundle, tzOffsetSeconds: 28800, tzName: 'Asia/Shanghai', stale: false,
    } as never);
    await oldLoad;
    expect(useStore.getState().bundle).toBe(newBundle);
    expect(useStore.getState().prediction?.locationLabel).toBe('new');
    expect(useStore.getState().status).toBe('ready');
  });
});
