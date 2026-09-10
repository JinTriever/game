/**
 * 스테이지 정의.
 *
 * 발판 배치, 스폰 위치, 색 팔레트, 광고판 슬롯을 한 덩어리로 묶는다.
 * 게임 로직은 특정 링 모양을 가정하지 않고 이 데이터만 읽는다.
 * 새 맵을 추가할 때 STAGES 배열에 한 항목만 넣으면 된다.
 */

export interface PlatformDef {
  /** 왼쪽 끝 x */
  x: number;
  /** 윗면 y */
  y: number;
  width: number;
  height: number;
}

/** 광고판을 어디에 매다는지. 렌더러가 지지 구조를 다르게 그린다. */
export type BillboardMount =
  /** 지면에서 기둥으로 받친다. */
  | 'stand'
  /** 천장에서 케이블로 매단다. */
  | 'hanging'
  /** 발판/펜스 표면에 직접 붙인다. 지지 구조를 그리지 않는다. */
  | 'surface';

export interface BillboardSlotDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  mount: BillboardMount;
  /** mount가 'stand'일 때 기둥이 내려가는 y좌표. */
  legBottomY?: number;
}

export interface StagePalette {
  skyTop: string;
  skyMid: string;
  skyBottom: string;
  /** 원경 실루엣(아치/구조물) 색. */
  silhouette: string;
  crowdBand: string;
  crowdDots: readonly string[];
  platformTop: string;
  platformBody: string;
  platformShade: string;
  platformEdge: string;
  fence: string;
  fenceRail: string;
  /** 아레나 조명 글로우 색 (rgba). */
  glow: string;
  /** 스포트라이트 빔 색 (rgba). */
  beam: string;
  /** 스테이지 강조색. HUD의 스테이지명 등에 쓴다. */
  accent: string;
}

export interface CrowdBand {
  topY: number;
  bottomY: number;
}

export interface Stage {
  id: string;
  name: string;
  /** 이 맵이 어떤 맵인지 한 줄 설명. 타이틀에 띄운다. */
  tagline: string;
  palette: StagePalette;
  platforms: readonly PlatformDef[];
  /** 관중석 밴드. null이면 야외 개방형 아레나. */
  crowd: CrowdBand | null;
  /** 링 뒤 펜스. null이면 없음. */
  fence: PlatformDef | null;
  spawns: readonly [{ x: number; y: number }, { x: number; y: number }];
  billboards: readonly BillboardSlotDef[];
}

const NIGHT_CROWD = ['#2f3a63', '#3a4676', '#46538a', '#28325a', '#4c5a95'] as const;
const DUSK_CROWD = ['#4a2f63', '#5b3a78', '#6b468a', '#3d285a', '#7a4c95'] as const;
const TEAL_CROWD = ['#1f5148', '#2a6357', '#357a6b', '#1a423b', '#3f8f7d'] as const;
const SUNSET_CROWD = ['#6b3a2a', '#7d4632', '#8f523c', '#5a2f22', '#a3654a'] as const;

export const STAGES: readonly Stage[] = [
  {
    id: 'central-ring',
    name: 'CENTRAL RING',
    tagline: '넓은 단일 발판 · 정통 밀어내기',
    palette: {
      skyTop: '#161d38',
      skyMid: '#0f142a',
      skyBottom: '#080b16',
      silhouette: '#0c1022',
      crowdBand: '#1b2340',
      crowdDots: NIGHT_CROWD,
      platformTop: '#4a5788',
      platformBody: '#232c4a',
      platformShade: '#1a2138',
      platformEdge: '#6a7ab5',
      fence: '#2a3355',
      fenceRail: '#424f7d',
      glow: 'rgba(120, 160, 255, 0.16)',
      beam: 'rgba(150, 185, 255, 0.055)',
      accent: '#7fb4ff',
    },
    platforms: [{ x: 260, y: 560, width: 760, height: 64 }],
    crowd: { topY: 300, bottomY: 470 },
    fence: { x: 220, y: 440, width: 840, height: 120 },
    spawns: [
      { x: 450, y: 486 },
      { x: 830, y: 486 },
    ],
    billboards: [
      { id: 'main-16x9', x: 400, y: 96, width: 480, height: 270, mount: 'stand', legBottomY: 470 },
      { id: 'left-1x1', x: 110, y: 210, width: 150, height: 150, mount: 'stand', legBottomY: 470 },
      { id: 'right-1x1', x: 1020, y: 210, width: 150, height: 150, mount: 'stand', legBottomY: 470 },
      { id: 'fence-a-4x1', x: 262, y: 452, width: 372, height: 93, mount: 'surface' },
      { id: 'fence-b-4x1', x: 646, y: 452, width: 372, height: 93, mount: 'surface' },
    ],
  },

  {
    id: 'twin-peaks',
    name: 'TWIN PEAKS',
    tagline: '갈라진 두 발판 · 대각 점프로 건너기',
    palette: {
      skyTop: '#2a1a3d',
      skyMid: '#1d1229',
      skyBottom: '#0d0814',
      silhouette: '#170e22',
      crowdBand: '#2c1c40',
      crowdDots: DUSK_CROWD,
      platformTop: '#7a5a95',
      platformBody: '#3a2a52',
      platformShade: '#2a1d3d',
      platformEdge: '#a87ec5',
      fence: '#3a2a52',
      fenceRail: '#5c447a',
      glow: 'rgba(210, 140, 255, 0.16)',
      beam: 'rgba(225, 165, 255, 0.06)',
      accent: '#d18cff',
    },
    // 틈 130px. 달리면서 대각 점프하면 240px 정도 나가므로 여유가 있다.
    platforms: [
      { x: 170, y: 545, width: 400, height: 70 },
      { x: 700, y: 545, width: 410, height: 70 },
    ],
    crowd: { topY: 330, bottomY: 470 },
    fence: null,
    spawns: [
      { x: 340, y: 471 },
      { x: 940, y: 471 },
    ],
    billboards: [
      { id: 'main-16x9', x: 400, y: 74, width: 480, height: 270, mount: 'hanging' },
      { id: 'left-1x1', x: 96, y: 250, width: 150, height: 150, mount: 'stand', legBottomY: 470 },
      { id: 'right-1x1', x: 1034, y: 250, width: 150, height: 150, mount: 'stand', legBottomY: 470 },
      { id: 'ledge-a-4x1', x: 200, y: 558, width: 224, height: 56, mount: 'surface' },
      { id: 'ledge-b-4x1', x: 830, y: 558, width: 224, height: 56, mount: 'surface' },
    ],
  },

  {
    id: 'high-ground',
    name: 'HIGH GROUND',
    tagline: '높이가 다른 세 발판 · 좁은 틈 주의',
    palette: {
      skyTop: '#0f2e2a',
      skyMid: '#0a201e',
      skyBottom: '#050f0e',
      silhouette: '#08211f',
      crowdBand: '#12332e',
      crowdDots: TEAL_CROWD,
      platformTop: '#4a8f7d',
      platformBody: '#1f4a42',
      platformShade: '#153630',
      platformEdge: '#6fc5ad',
      fence: '#1a3f39',
      fenceRail: '#2d5f55',
      glow: 'rgba(110, 255, 215, 0.14)',
      beam: 'rgba(140, 255, 225, 0.05)',
      accent: '#6fe3c5',
    },
    // 틈 90px에 높이차 70px. 점프 높이가 117px이라 아래에서도 올라올 수 있다.
    // 파이터 지름이 68px이므로 틈은 그보다 넉넉해야 끼지 않고 깔끔하게 떨어진다.
    // 좌우 발판은 화면 중앙(640)을 기준으로 대칭이어야 한쪽이 유리하지 않다.
    platforms: [
      { x: 110, y: 520, width: 300, height: 60 },
      { x: 500, y: 590, width: 280, height: 70 },
      { x: 870, y: 520, width: 300, height: 60 },
    ],
    crowd: { topY: 320, bottomY: 460 },
    fence: null,
    spawns: [
      { x: 260, y: 446 },
      { x: 1020, y: 446 },
    ],
    billboards: [
      { id: 'main-16x9', x: 400, y: 60, width: 480, height: 270, mount: 'hanging' },
      { id: 'left-1x1', x: 90, y: 330, width: 150, height: 150, mount: 'stand', legBottomY: 520 },
      { id: 'right-1x1', x: 1040, y: 330, width: 150, height: 150, mount: 'stand', legBottomY: 520 },
      { id: 'pit-4x1', x: 530, y: 592, width: 200, height: 50, mount: 'surface' },
      { id: 'ledge-4x1', x: 135, y: 524, width: 200, height: 50, mount: 'surface' },
    ],
  },

  {
    id: 'tightrope',
    name: 'TIGHTROPE',
    tagline: '좁은 외줄 발판 · 한 방에 끝난다',
    palette: {
      skyTop: '#3d1f14',
      skyMid: '#2a150e',
      skyBottom: '#120806',
      silhouette: '#1f0f0a',
      crowdBand: '#3a1e14',
      crowdDots: SUNSET_CROWD,
      platformTop: '#c47a3f',
      platformBody: '#6b3a1f',
      platformShade: '#4a2716',
      platformEdge: '#f0a05a',
      fence: '#4a2716',
      fenceRail: '#6b3a1f',
      glow: 'rgba(255, 170, 90, 0.17)',
      beam: 'rgba(255, 195, 130, 0.06)',
      accent: '#ffa95a',
    },
    platforms: [{ x: 420, y: 520, width: 440, height: 52 }],
    crowd: { topY: 310, bottomY: 450 },
    fence: null,
    spawns: [
      { x: 520, y: 434 },
      { x: 760, y: 434 },
    ],
    billboards: [
      { id: 'main-16x9', x: 400, y: 66, width: 480, height: 270, mount: 'hanging' },
      { id: 'left-1x1', x: 100, y: 300, width: 150, height: 150, mount: 'stand', legBottomY: 470 },
      { id: 'right-1x1', x: 1030, y: 300, width: 150, height: 150, mount: 'stand', legBottomY: 470 },
      { id: 'beam-a-4x1', x: 470, y: 524, width: 180, height: 45, mount: 'surface' },
      { id: 'beam-b-4x1', x: 660, y: 524, width: 180, height: 45, mount: 'surface' },
    ],
  },
];

export function getStageById(id: string): Stage | null {
  return STAGES.find((stage) => stage.id === id) ?? null;
}

/** 스테이지 좌우 끝. AI의 낙하 회피 판단에 쓴다. */
export function getStageExtent(stage: Stage): { left: number; right: number } {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const platform of stage.platforms) {
    left = Math.min(left, platform.x);
    right = Math.max(right, platform.x + platform.width);
  }
  return { left, right };
}

/** 스테이지의 수평 중심. 시간 초과 판정 기준점. */
export function getStageCenterX(stage: Stage): number {
  const { left, right } = getStageExtent(stage);
  return (left + right) / 2;
}

/**
 * 주어진 x에서 아래로 내려갈 때 처음 만나는 발판.
 * 그림자 렌더링과 AI의 발판 인식에 쓴다.
 * @param fromY 이 y보다 아래에 있는 발판만 후보로 본다.
 */
export function findPlatformBelow(
  stage: Stage,
  x: number,
  fromY: number,
): PlatformDef | null {
  let best: PlatformDef | null = null;
  for (const platform of stage.platforms) {
    if (x < platform.x || x > platform.x + platform.width) continue;
    if (platform.y < fromY) continue;
    if (!best || platform.y < best.y) best = platform;
  }
  return best;
}

/**
 * 지금 밟고 있는(또는 바로 아래에 있는) 발판.
 * 없으면 허공에 있다는 뜻이므로 AI는 즉시 복귀를 시도해야 한다.
 */
export function findSupportingPlatform(stage: Stage, x: number, y: number): PlatformDef | null {
  return findPlatformBelow(stage, x, y - 60);
}

/** 발판 위에서 가장 가까운 좌우 끝까지의 거리. 음수면 발판 밖. */
export function getEdgeMargin(platform: PlatformDef, x: number): number {
  return Math.min(x - platform.x, platform.x + platform.width - x);
}
