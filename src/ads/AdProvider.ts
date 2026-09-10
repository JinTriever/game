/**
 * 광고 연동 경계(boundary).
 *
 * 게임 코드는 이 인터페이스만 알고 있고, 실제 구현은 교체 가능하다.
 * 지금은 MockAdProvider를 쓰고, 배급 시점에 포털 SDK
 * (Poki / CrazyGames / Playgama 등) 구현체로 갈아끼우면 게임 로직은 손대지 않는다.
 */

export type RewardedAdResult =
  /** 광고를 끝까지 봤다. 보상을 지급해야 한다. */
  | 'completed'
  /** 유저가 중간에 닫았다. 보상 없음. */
  | 'dismissed'
  /** 재고 없음 또는 SDK 미초기화. 보상 없음, 유저에게 책임 없음. */
  | 'unavailable';

/** 광고판에 렌더링할 소재. */
export interface BillboardCreative {
  /** 소재 식별자. impression 리포팅에 함께 실린다. */
  readonly id: string;
  /** 표시용 브랜드명. 이미지가 없을 때 폴백 렌더링에 쓴다. */
  readonly brand: string;
  /** 부제/카피. */
  readonly caption?: string;
  /** 배경색. 이미지 로딩 전/실패 시 사용. */
  readonly background: string;
  /** 전경(텍스트) 색. */
  readonly foreground: string;
  /**
   * 실제 광고 이미지 URL. 광고 네트워크가 붙으면 이 값만 채워진다.
   * null이면 색상 + 텍스트로 폴백 렌더링한다.
   */
  readonly imageUrl: string | null;
  /** 클릭 랜딩 URL. 웹 게임에서는 새 탭으로 연다. */
  readonly clickUrl: string | null;
}

export interface ImpressionReport {
  readonly slotId: string;
  readonly creativeId: string;
  /** 누적 가시 노출 시간(ms). IAB/MRC intrinsic in-game 기준은 누적 10초. */
  readonly cumulativeVisibleMs: number;
  /** 노출 동안 광고판이 차지한 화면 면적 비율의 평균(0~1). */
  readonly averageScreenShare: number;
}

export interface AdProvider {
  readonly name: string;

  /** SDK 초기화. 실패해도 게임은 계속 동작해야 한다. */
  init(): Promise<void>;

  /**
   * 리워드 광고 재생. 게임은 반드시 결과를 보고 보상 지급을 결정한다.
   * @param placement 어느 지점에서 호출됐는지 (분석용). 예: 'continue_after_loss'
   */
  showRewarded(placement: string): Promise<RewardedAdResult>;

  /** 인터스티셜. 보상이 없으므로 결과를 기다릴 필요가 없다. */
  showInterstitial(placement: string): Promise<void>;

  /**
   * 광고판 소재 요청. 슬롯 ID별로 소재를 반환한다.
   * 재고가 없는 슬롯은 null이며, 그 경우 자체 광고나 크로스 프로모션으로 채운다.
   */
  fetchBillboardCreatives(slotIds: readonly string[]): Promise<Record<string, BillboardCreative | null>>;

  /** 유효 impression 성립 시 호출. */
  reportImpression(report: ImpressionReport): void;
}
