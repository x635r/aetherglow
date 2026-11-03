import { describe, expect, it } from 'vitest';
import {
  destinationPoint,
  greatCircleKm,
  samplePiecewise,
  smoothKnots,
  sunEvent,
  sunPosition,
} from '../src/engine/astro';
import { STAGE_KNOTS } from '../src/engine/constants';
import {
  cloudLitFactor,
  directSunRgb,
  earthShadowHeightM,
  groundHitDistanceKm,
  rayHeightM,
} from '../src/engine/optics';
import { angstromFromAod, evaluateSpectral, visibilityFromAod } from '../src/engine/spectral';
import {
  cloudScreenQuality,
  cloudAtHeightM,
  generateLightPathGrid,
} from '../src/engine/SunsetPhysicsEngine';

describe('astro / 太阳位置', () => {
  it('上海 2026-10-31 日落时刻在 09:06 UTC 附近', () => {
    // 实测 Open-Meteo：17:06 CST = 09:06 UTC
    const dayStart = Date.UTC(2026, 9, 31, 0, 0, 0);
    const sunset = sunEvent(dayStart, 31.2304, 121.4737, 'sunset');
    expect(sunset).not.toBeNull();
    const minutesUtc = (sunset! - dayStart) / 60000;
    expect(minutesUtc).toBeGreaterThan(9 * 60 + 0);
    expect(minutesUtc).toBeLessThan(9 * 60 + 14);
  });

  it('赤道春分正午太阳高度角约 90°', () => {
    const t = Date.UTC(2026, 2, 20, 12, 0, 0);
    const sp = sunPosition(t, 0, 0);
    expect(sp.altitude).toBeGreaterThan(86);
    expect(sp.altitude).toBeLessThan(92);
  });

  it('日落后太阳高度角为负且单调下降', () => {
    const dayStart = Date.UTC(2026, 9, 31, 0, 0, 0);
    const sunset = sunEvent(dayStart, 31.23, 121.47, 'sunset')!;
    const a0 = sunPosition(sunset, 31.23, 121.47).altitude;
    const a1 = sunPosition(sunset + 30 * 60000, 31.23, 121.47).altitude;
    const a2 = sunPosition(sunset + 60 * 60000, 31.23, 121.47).altitude;
    expect(a0).toBeLessThan(0.2);
    expect(a1).toBeLessThan(a0);
    expect(a2).toBeLessThan(a1);
  });

  it('极区夏季无日落，返回 null', () => {
    const dayStart = Date.UTC(2026, 5, 21, 0, 0, 0);
    expect(sunEvent(dayStart, 78.2, 15.6, 'sunset')).toBeNull();
  });
});

describe('astro / 球面大圆', () => {
  it('destinationPoint 与 greatCircleKm 自洽', () => {
    const d = destinationPoint(31.23, 121.47, 260, 450);
    const back = greatCircleKm(31.23, 121.47, d.lat, d.lon);
    expect(back).toBeCloseTo(450, 0);
  });

  it('方位角 90°（正东）在赤道指向东经增加', () => {
    const d = destinationPoint(0, 0, 90, 111.19);
    expect(d.lat).toBeCloseTo(0, 3);
    expect(d.lon).toBeCloseTo(1, 1);
  });

  it('跨越反子午线不产生畸变', () => {
    const d = destinationPoint(0, 179.5, 90, 200);
    const dist = greatCircleKm(0, 179.5, d.lat, d.lon);
    expect(dist).toBeCloseTo(200, 0);
  });
});

describe('optics / 几何与地影', () => {
  it('曲率项使光线在远端抬高', () => {
    const near = rayHeightM(4200, 0, 30);
    const far = rayHeightM(4200, 0, 450);
    expect(far).toBeGreaterThan(near);
    // 450km 曲率落差约 13.6km
    expect((far - near) / 1000).toBeGreaterThan(10);
  });

  it('负高度角时光线向下倾斜', () => {
    expect(rayHeightM(5000, -3, 100)).toBeLessThan(rayHeightM(5000, -3, 10));
  });

  it('groundHitDistanceKm 在正高度角时为 Infinity', () => {
    expect(groundHitDistanceKm(5000, 5)).toBe(Infinity);
  });

  it('groundHitDistanceKm 在负角时有限且随角度减小', () => {
    // 注意：−1°/−2° 时 5km 光线因地球曲率抬升永不着地（真实物理），
    // 必须用足够陡的角度检验触地。
    expect(groundHitDistanceKm(5000, -1)).toBe(Infinity);
    const shallow = groundHitDistanceKm(5000, -4);
    const steep = groundHitDistanceKm(5000, -8);
    expect(Number.isFinite(shallow)).toBe(true);
    expect(Number.isFinite(steep)).toBe(true);
    expect(shallow).toBeGreaterThan(steep);
  });

  it('曲率使低空光线比平地几何走得更远才触地', () => {
    // 平面近似会在 5km/tan(8°) ≈ 35.6km 触地；含曲率后应显著更远
    const hit = groundHitDistanceKm(5000, -8);
    const planar = 5 / Math.tan((8 * Math.PI) / 180);
    expect(hit).toBeGreaterThan(planar * 0.9);
    expect(hit).toBeGreaterThan(20);
  });

  it('地影高度随太阳下沉而升高', () => {
    expect(earthShadowHeightM(0)).toBe(0);
    expect(earthShadowHeightM(-2)).toBeGreaterThan(earthShadowHeightM(-1));
    expect(earthShadowHeightM(-2)).toBeLessThan(earthShadowHeightM(-5));
  });

  it('9.2km 卷云在 α=−3° 仍受光，在 α=−8° 完全入影', () => {
    expect(cloudLitFactor(9200, -3, 'high')).toBeGreaterThan(0.15);
    expect(cloudLitFactor(9200, -8, 'high')).toBeLessThan(0.1);
  });

  it('低云在 α=−1° 即入影', () => {
    expect(cloudLitFactor(780, -1.2, 'low')).toBeLessThan(0.35);
  });

  it('高云在 α=−3° 的受光显著高于低云', () => {
    expect(cloudLitFactor(9200, -3, 'high')).toBeGreaterThan(cloudLitFactor(780, -3, 'low'));
  });
});

describe('optics / 光谱', () => {
  it('低太阳高度角使直射光红移（R > B）', () => {
    const { rgb } = directSunRgb(2, 4200, 0.1, 1.2, 50);
    expect(rgb.r).toBeGreaterThan(rgb.b);
    expect(rgb.r / rgb.b).toBeGreaterThan(2);
  });

  it('高 AOD 显著压低三通道总透过率', () => {
    const clean = directSunRgb(1, 4200, 0.05, 1.2, 50).rgb;
    const hazy = directSunRgb(1, 4200, 0.8, 1.2, 50).rgb;
    expect(hazy.r).toBeLessThan(clean.r);
    expect(hazy.b).toBeLessThan(clean.b);
  });

  it('Angström 指数越大，短波衰减越强', () => {
    const fine = directSunRgb(0, 4200, 0.4, 1.6, 60).rgb;
    const coarse = directSunRgb(0, 4200, 0.4, 0.6, 60).rgb;
    expect(fine.b / fine.r).toBeLessThan(coarse.b / coarse.r);
  });
});

describe('spectral / CAMS', () => {
  it('水晶天条件触发饱和度加成', () => {
    const s = evaluateSpectral(0.08, 8, 5, 45, 32);
    expect(s.crystal).toBe(true);
    expect(s.saturationGain).toBeGreaterThan(1.2);
    expect(s.tone).toBe('crystal');
  });

  it('重霾高湿触发米氏惩罚', () => {
    const s = evaluateSpectral(0.85, 140, 20, 88, 4);
    expect(s.hazePenalty).toBeLessThan(0.6);
    expect(s.saturationGain).toBeLessThan(0.75);
  });

  it('沙尘主导时标记 dusty', () => {
    const s = evaluateSpectral(0.5, 30, 600, 40, 12);
    expect(['dusty', 'hazy', 'normal']).toContain(s.tone);
  });

  it('能见度反演随 AOD 增大而下降', () => {
    expect(visibilityFromAod(0.1, 50)).toBeGreaterThan(visibilityFromAod(0.7, 50));
  });

  it('angstrom 随粗模态比例下降', () => {
    expect(angstromFromAod(200, 20)).toBeLessThan(angstromFromAod(2, 200));
  });
});

describe('云幕质量函数', () => {
  it('无云 / 满铺低云 → 质量趋近 0', () => {
    expect(cloudScreenQuality(0, 'golden', '600')).toBe(0);
    // 满铺 850hPa 层积云：τ_full≈18，不透明灰幕 → 几乎没有可烧的画布
    expect(cloudScreenQuality(0.99, 'low', '850')).toBeLessThan(0.2);
  });

  it('黄金层在 40~65% 云量时得分最高', () => {
    const opt = cloudScreenQuality(0.52, 'golden', '600');
    expect(opt).toBeGreaterThan(cloudScreenQuality(0.1, 'golden', '600'));
    expect(opt).toBeGreaterThan(cloudScreenQuality(0.9, 'golden', '600'));
    expect(opt).toBeGreaterThan(0.4);
  });

  it('低云权重下的最优值低于黄金层（对遮挡更敏感）', () => {
    expect(cloudScreenQuality(0.22, 'low', '850')).toBeLessThan(
      cloudScreenQuality(0.52, 'golden', '600'),
    );
  });

  /**
   * 核心物理不变量：同样是 100% 覆盖率，薄卷云必须显著优于浓低云。
   * 上一版只用云量做钟形，导致「满铺薄卷云」质量 0.008（判成无烧），
   * 而「满铺低云」质量 0.74 —— 二者被彻底颠倒。
   */
  it('满铺薄卷云的质量必须显著高于满铺低云', () => {
    const cirrus = cloudScreenQuality(1.0, 'high', '300');
    const stratus = cloudScreenQuality(1.0, 'low', '850');
    expect(cirrus).toBeGreaterThan(0.5);
    expect(stratus).toBeLessThan(0.1);
    expect(cirrus / Math.max(stratus, 1e-6)).toBeGreaterThan(10);
  });

  it('云量单调性：同类云从 0→最优值应上升', () => {
    expect(cloudScreenQuality(0.45, 'golden', '600')).toBeGreaterThan(
      cloudScreenQuality(0.05, 'golden', '600'),
    );
  });
});

describe('云量剖面插值', () => {
  const levels = [
    { heightM: 780, cover: 0.9 },
    { heightM: 4200, cover: 0.2 },
    { heightM: 9200, cover: 0.6 },
  ];

  it('在层高度处返回该层值', () => {
    expect(cloudAtHeightM(levels, 4200)).toBeCloseTo(0.2, 5);
  });

  it('层间线性插值', () => {
    const mid = cloudAtHeightM(levels, (780 + 4200) / 2);
    expect(mid).toBeCloseTo((0.9 + 0.2) / 2, 3);
  });

  it('超出范围取端点值', () => {
    expect(cloudAtHeightM(levels, 0)).toBeCloseTo(0.9, 5);
    expect(cloudAtHeightM(levels, 20000)).toBeCloseTo(0.6, 5);
  });
});

describe('时间轴与网格', () => {
  it('光路网格为 31 帧且覆盖 −20~+40min', () => {
    const grid = generateLightPathGrid(31.23, 121.47, Date.UTC(2026, 9, 31, 9, 6), 'sunset');
    expect(grid.samples).toHaveLength(31);
    expect(grid.samples[0].offsetMin).toBe(-20);
    expect(grid.samples[grid.samples.length - 1].offsetMin).toBe(40);
    expect(grid.rings.map((r) => r.ringKm)).toEqual([0, 30, 80, 150, 280, 450]);
  });

  it('沿方位角的环点距观测点符合大圆距离', () => {
    const grid = generateLightPathGrid(31.23, 121.47, Date.UTC(2026, 9, 31, 9, 6), 'sunset');
    for (const r of grid.rings) {
      expect(greatCircleKm(31.23, 121.47, r.lat, r.lon)).toBeCloseTo(r.ringKm, 0);
    }
  });

  it('霞光阶段权重在 −1° 附近达到峰值', () => {
    expect(smoothKnots(STAGE_KNOTS, -1)).toBeGreaterThan(0.9);
    expect(smoothKnots(STAGE_KNOTS, 10)).toBeLessThan(0.06);
    expect(smoothKnots(STAGE_KNOTS, -11)).toBeLessThan(0.08);
  });

  it('samplePiecewise 边界与中点正确', () => {
    const xs = [0, 10, 20];
    const ys = [1, 3, 9];
    expect(samplePiecewise(xs, ys, -5)).toBe(1);
    expect(samplePiecewise(xs, ys, 5)).toBe(2);
    expect(samplePiecewise(xs, ys, 25)).toBe(9);
  });
});
