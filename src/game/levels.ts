/**
 * 캠페인 레벨 정의와 진행도 저장.
 *
 * 맵(stages.ts)은 '무대'만 정의하고, 레벨은 그 무대에 난이도와 승리 조건을
 * 얹은 한 판이다. 같은 맵을 다른 난이도로 재사용할 수 있다.
 */

export interface Level {
  /** 1부터 시작하는 레벨 번호. */
  number: number;
  /** 사용할 맵 id (stages.ts의 Stage.id). */
  stageId: string;
  /** 상대 이름. 진행하는 느낌을 주는 값싼 장치. */
  opponent: string;
  /** AI 실력 0~1. */
  aiSkill: number;
  /** 이 레벨에서 매치를 따는 데 필요한 라운드 승수. */
  roundsToWin: number;
}

export const LEVELS: readonly Level[] = [
  { number: 1, stageId: 'central-ring', opponent: '연습 상대', aiSkill: 0.22, roundsToWin: 2 },
  { number: 2, stageId: 'central-ring', opponent: '신입 도전자', aiSkill: 0.4, roundsToWin: 2 },
  { number: 3, stageId: 'twin-peaks', opponent: '도약하는 자', aiSkill: 0.5, roundsToWin: 2 },
  { number: 4, stageId: 'tightrope', opponent: '외줄의 광인', aiSkill: 0.58, roundsToWin: 2 },
  { number: 5, stageId: 'high-ground', opponent: '고지 점령자', aiSkill: 0.66, roundsToWin: 3 },
  { number: 6, stageId: 'twin-peaks', opponent: '공중전 전문가', aiSkill: 0.76, roundsToWin: 3 },
  { number: 7, stageId: 'tightrope', opponent: '칼날 위의 무희', aiSkill: 0.86, roundsToWin: 3 },
  { number: 8, stageId: 'central-ring', opponent: '무패의 챔피언', aiSkill: 0.97, roundsToWin: 3 },
];

export const LAST_LEVEL = LEVELS.length;

export function getLevel(levelNumber: number): Level | null {
  return LEVELS.find((level) => level.number === levelNumber) ?? null;
}

// ------------------------------------------------------------------ 진행도

export interface Progress {
  /** 클리어한 가장 높은 레벨 번호. 0이면 아직 아무것도 못 깼음. */
  clearedUpTo: number;
}

const STORAGE_KEY = 'ring-out-arena:progress:v1';

const EMPTY_PROGRESS: Progress = { clearedUpTo: 0 };

/**
 * 진행도 읽기.
 * 시크릿 모드나 저장 차단 환경에서 localStorage가 예외를 던질 수 있으므로
 * 실패해도 게임이 멈추지 않게 기본값으로 떨어진다.
 */
export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_PROGRESS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_PROGRESS };
    const value = (parsed as { clearedUpTo?: unknown }).clearedUpTo;
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ...EMPTY_PROGRESS };
    // 저장된 값이 손상됐거나 레벨 수가 줄어든 경우를 대비해 범위를 좁힌다.
    return { clearedUpTo: Math.max(0, Math.min(LAST_LEVEL, Math.floor(value))) };
  } catch {
    return { ...EMPTY_PROGRESS };
  }
}

export function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // 저장 실패는 무시한다. 이번 세션 동안의 진행은 메모리에 남아있다.
  }
}

/** 다음에 도전할 레벨 번호. 전부 클리어했으면 마지막 레벨을 돌려준다. */
export function nextLevelNumber(progress: Progress): number {
  return Math.min(LAST_LEVEL, progress.clearedUpTo + 1);
}

export function isCampaignComplete(progress: Progress): boolean {
  return progress.clearedUpTo >= LAST_LEVEL;
}
