/** 논리 해상도. 렌더러가 이 좌표계를 기준으로 그리고, CSS가 화면에 맞춰 스케일한다. */
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 720;

/** 고정 타임스텝 (초당 60프레임). */
export const FIXED_DT_MS = 1000 / 60;

/** 이 Y좌표 아래로 떨어지면 링아웃 판정. 화면 밖으로 충분히 내려간 지점. */
export const RINGOUT_Y = 900;
/** 화면 좌우로 이만큼 벗어나도 링아웃 판정. */
export const RINGOUT_X_MARGIN = 260;

export const FIGHTER = {
  radius: 34,
  /** 좌우 이동 목표 속도. */
  maxSpeed: 5.2,
  /** 목표 속도로 수렴하는 비율(0~1). 낮으면 미끄러지는 느낌. */
  accel: 0.16,
  /** 공중에서의 조작 개입 비율(지상 대비). */
  airControl: 0.55,

  jumpVelocity: -11.5,
  /**
   * 대각 점프. 점프하는 순간 이동 방향을 누르고 있으면 수평 임펄스가 더해진다.
   * 그냥 점프하면 제자리에서 뜨고, 방향을 잡으면 크게 도약한다.
   */
  jumpHorizontalBoost: 3.6,

  /** 차지 완료까지 걸리는 시간(ms). */
  chargeTimeMs: 850,
  /** 대시 임펄스 = base + charge * scale */
  dashBase: 7.5,
  dashScale: 15.5,
  /** 수평 대시 시 살짝 떠오르는 양. */
  dashLift: 3.2,
  /** 위쪽으로 조준했을 때의 대시 각도(라디안). */
  dashUpAngle: Math.PI / 3.6,
  /** 대시가 '공격 판정'으로 유지되는 시간(ms). */
  dashActiveMs: 320,
  /** 대시 후 재사용 대기시간(ms). */
  dashCooldownMs: 260,
  /** 착지 전까지 허용되는 공중 대시 횟수. 무한 비행을 막는다. */
  airDashLimit: 1,

  /** 명중 시 상대에게 주는 넉백 = base + charge * scale */
  knockbackBase: 9,
  knockbackScale: 17,
  /** 명중 시 자신이 받는 반동 비율. */
  recoil: 0.22,
} as const;

export const MATCH = {
  /** 매치 승리에 필요한 라운드 승수. */
  roundsToWin: 3,
  /** 라운드 시작 카운트다운(ms). */
  countdownMs: 1600,
  /** 라운드 종료 후 리셋 대기(ms). */
  roundEndDelayMs: 1400,
  /**
   * 라운드 제한 시간(ms). 교착 상태를 없애기 위한 장치다.
   * 초과 시 스테이지 중앙에 더 가까운 쪽이 승리한다(roundRules.resolveTimeout).
   */
  roundTimeMs: 35_000,
  /** 남은 시간이 이 값 아래로 내려가면 타이머를 강조 표시한다. */
  roundTimeWarningMs: 8_000,
} as const;

export const EFFECTS = {
  /**
   * 타격 시 화면을 정지시키는 시간(ms).
   * 격투 게임의 타격감은 이펙트보다 이 정지에서 나온다.
   * 정지는 '움직임'이 아니라서 어지러움의 원인이 아니므로 여기에 힘을 준다.
   */
  hitstopBaseMs: 45,
  hitstopScaleMs: 85,

  /**
   * 화면 흔들림 상한(px).
   * 라운드당 타격이 10회를 넘기 때문에 한 번의 강도가 조금만 커도
   * 화면이 계속 떨리는 것처럼 느껴진다. 낮게 잡고 빠르게 가라앉힌다.
   */
  shakeMax: 11,
  /** 흔들림 기본 강도 = base + 차지량 * scale */
  shakeBase: 3,
  shakeScale: 8,
  /** 흔들림 감쇠 속도(px/ms). 값이 크면 빨리 멈춘다. */
  shakeDecay: 0.075,
} as const;

/** 스테이지 팔레트에 들어가지 않는, 게임 전역 UI 색. */
export const UI_COLORS = {
  p1: '#4fb0ff',
  p1Dark: '#1a6cb5',
  p1Glow: 'rgba(79, 176, 255, 0.55)',
  p2: '#ff6b6b',
  p2Dark: '#b53c3c',
  p2Glow: 'rgba(255, 107, 107, 0.55)',
  text: '#eef2ff',
  textDim: '#8e9cc2',
  charge: '#ffd166',
  chargeFull: '#ff8f3f',
  good: '#4ade80',
} as const;
