import type { BillboardMount, BillboardSlotDef } from '../game/stages';
import type { BillboardCreative } from './AdProvider';

/**
 * 광고판 슬롯 하나.
 *
 * 게임 월드 안의 사각형 지면이며, 화면에 얼마나 오래 보였는지를 누적한다.
 * IAB/MRC의 intrinsic in-game 측정 기준은 누적 노출 시간을 요구하기 때문에
 * "그려졌다"가 아니라 "얼마나 보였다"를 추적해야 수익 지표가 맞는다.
 */
export class BillboardSlot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 지지 구조 종류. 렌더링에만 영향을 준다. */
  readonly mount: BillboardMount;
  /** mount가 'stand'일 때 기둥이 내려가는 y좌표. */
  readonly legBottomY: number | null;

  private creative: BillboardCreative | null = null;
  private image: HTMLImageElement | null = null;

  /** 누적 가시 시간(ms). */
  private visibleMs = 0;
  /** 화면 점유율 누적(가중 평균 계산용). */
  private screenShareSum = 0;
  private screenShareSamples = 0;
  /** 유효 impression을 이미 보고했는지. */
  private impressionReported = false;

  constructor(def: BillboardSlotDef) {
    this.id = def.id;
    this.x = def.x;
    this.y = def.y;
    this.width = def.width;
    this.height = def.height;
    this.mount = def.mount;
    this.legBottomY = def.legBottomY ?? null;
  }

  getCreative(): BillboardCreative | null {
    return this.creative;
  }

  getImage(): HTMLImageElement | null {
    return this.image;
  }

  /**
   * 소재 교체. 네트워크가 붙으면 여기로 실제 광고가 들어온다.
   * 소재가 바뀌면 노출 측정을 처음부터 다시 시작한다.
   */
  setCreative(creative: BillboardCreative | null): void {
    this.creative = creative;
    this.image = null;
    this.resetMeasurement();

    if (creative?.imageUrl) {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.addEventListener('load', () => {
        // 로드가 끝난 뒤에만 참조를 붙여서 깨진 이미지를 그리지 않는다.
        this.image = image;
      });
      image.addEventListener('error', () => {
        console.warn(`[ads] 소재 이미지 로드 실패: ${creative.imageUrl}`);
      });
      image.src = creative.imageUrl;
    }
  }

  resetMeasurement(): void {
    this.visibleMs = 0;
    this.screenShareSum = 0;
    this.screenShareSamples = 0;
    this.impressionReported = false;
  }

  /**
   * 이번 프레임의 가시 상태를 누적한다.
   * @param dtMs 프레임 시간
   * @param screenShare 광고판이 화면에서 차지한 면적 비율(0~1). 0이면 보이지 않음.
   */
  accumulate(dtMs: number, screenShare: number): void {
    if (screenShare <= 0) return;
    this.visibleMs += dtMs;
    this.screenShareSum += screenShare;
    this.screenShareSamples += 1;
  }

  getVisibleMs(): number {
    return this.visibleMs;
  }

  getAverageScreenShare(): number {
    if (this.screenShareSamples === 0) return 0;
    return this.screenShareSum / this.screenShareSamples;
  }

  hasReportedImpression(): boolean {
    return this.impressionReported;
  }

  markImpressionReported(): void {
    this.impressionReported = true;
  }
}
