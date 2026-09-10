import { RINGOUT_X_MARGIN, RINGOUT_Y, VIEW_WIDTH } from './constants';
import type { Fighter, PlayerId } from './Fighter';

export type RoundEndReason = 'ringout' | 'double_ringout' | 'timeout' | 'timeout_draw';

export interface RoundOutcome {
  /** null이면 무승부. 라운드를 다시 진행한다. */
  winner: PlayerId | null;
  reason: RoundEndReason;
}

/** 발판 밖으로 떨어져 화면을 벗어났는지 판정. */
export function isOutOfRing(fighter: Fighter): boolean {
  return (
    fighter.y > RINGOUT_Y ||
    fighter.x < -RINGOUT_X_MARGIN ||
    fighter.x > VIEW_WIDTH + RINGOUT_X_MARGIN
  );
}

/**
 * 링아웃 판정. 아직 아무도 나가지 않았으면 null.
 * 게임 루프와 분리해두면 규칙만 따로 검증할 수 있다.
 */
export function detectRingOut(p1: Fighter, p2: Fighter): RoundOutcome | null {
  const p1Out = isOutOfRing(p1);
  const p2Out = isOutOfRing(p2);

  if (p1Out && p2Out) return { winner: null, reason: 'double_ringout' };
  if (p1Out) return { winner: 'p2', reason: 'ringout' };
  if (p2Out) return { winner: 'p1', reason: 'ringout' };
  return null;
}

/**
 * 시간 초과 판정.
 *
 * 스모 규칙을 빌려서 스테이지 중앙에 더 가까운 쪽이 이긴다.
 * 이렇게 하면 "끝까지 버티기"가 최적 전략이 되지 않고, 중앙을 차지하려는
 * 능동적인 플레이가 보상받는다. 결착이 항상 나므로 교착 상태가 사라진다.
 *
 * @param centerX 스테이지의 수평 중심. 맵마다 다르므로 주입받는다.
 */
export function resolveTimeout(p1: Fighter, p2: Fighter, centerX: number): RoundOutcome {
  const p1Distance = Math.abs(p1.x - centerX);
  const p2Distance = Math.abs(p2.x - centerX);

  // 차이가 이 정도도 안 되면 무승부로 본다.
  const DEAD_ZONE = 8;
  if (Math.abs(p1Distance - p2Distance) < DEAD_ZONE) {
    return { winner: null, reason: 'timeout_draw' };
  }

  return {
    winner: p1Distance < p2Distance ? 'p1' : 'p2',
    reason: 'timeout',
  };
}
