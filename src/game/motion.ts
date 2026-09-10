/**
 * 연출 강도 설정.
 *
 * 화면 흔들림, 플래시, 깜빡이는 속도선 같은 연출은 타격감을 만들지만
 * 어지러움과 시각 피로의 원인이기도 하다. 그래서 강도를 한곳에서 곱셈
 * 계수로 관리하고, 사용자가 줄일 수 있게 한다.
 *
 * 기본값은 OS의 '동작 줄이기' 설정을 따른다. 접근성 설정을 이미 켠
 * 사용자에게 다시 물어볼 이유가 없다.
 */

export type MotionLevel = 'full' | 'reduced';

export interface MotionProfile {
  /** 화면 흔들림 배율. 0이면 흔들리지 않는다. */
  shake: number;
  /** 피격 시 화면 전체 플래시 배율. */
  flash: number;
  /** 파편 입자 수 배율. */
  particles: number;
  /** 파이터 찌그러짐(스쿼시/스트레치) 배율. */
  squash: number;
  /** 대시 속도선 표시 여부. 매 프레임 형태가 바뀌어 깜빡임이 심하다. */
  speedLines: boolean;
  /** 관중석 카메라 플래시 배율. */
  crowdFlash: number;
  /** 스포트라이트 흔들림 배율. */
  spotlightSway: number;
  /** 카운트다운 숫자 확대 연출 배율. */
  countdownPulse: number;
  /** 타격 정지(히트스톱) 배율. 움직임이 아니라 정지라 완전히 없애진 않는다. */
  hitstop: number;
  /** 충격파 링 배율. */
  shockwave: number;
}

export const MOTION_PROFILES: Record<MotionLevel, MotionProfile> = {
  full: {
    shake: 1,
    flash: 1,
    particles: 1,
    squash: 1,
    speedLines: true,
    crowdFlash: 1,
    spotlightSway: 1,
    countdownPulse: 1,
    hitstop: 1,
    shockwave: 1,
  },
  reduced: {
    shake: 0,
    flash: 0,
    particles: 0.4,
    squash: 0.25,
    speedLines: false,
    crowdFlash: 0,
    spotlightSway: 0,
    countdownPulse: 0,
    // 히트스톱은 절반만 남긴다. 완전히 없애면 타격이 닿았는지 알기 어려워진다.
    hitstop: 0.5,
    shockwave: 0.5,
  },
};

const STORAGE_KEY = 'ring-out-arena:motion:v1';

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/** 저장된 사용자 선택이 있으면 그것을, 없으면 OS 설정을 따른다. */
export function loadMotionLevel(): MotionLevel {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'full' || saved === 'reduced') return saved;
  } catch {
    // 저장소 접근 실패는 무시하고 OS 설정으로 넘어간다.
  }
  return prefersReducedMotion() ? 'reduced' : 'full';
}

export function saveMotionLevel(level: MotionLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // 저장 실패해도 이번 세션에는 적용된다.
  }
}

export function getMotionProfile(level: MotionLevel): MotionProfile {
  return MOTION_PROFILES[level];
}
