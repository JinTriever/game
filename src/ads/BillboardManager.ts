import { VIEW_HEIGHT, VIEW_WIDTH } from '../game/constants';
import type { Stage } from '../game/stages';
import type { AdProvider } from './AdProvider';
import { BillboardSlot } from './BillboardSlot';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * IAB/MRC intrinsic in-game 기준: 광고판이 누적 10초 노출되어야 유효 impression.
 * 이 게임이 스크롤 러너가 아니라 고정 카메라 아레나인 이유가 바로 이 수치다.
 */
const IMPRESSION_THRESHOLD_MS = 10_000;

/**
 * 화면 면적을 이 비율 미만으로 차지하면 노출로 세지 않는다.
 * 너무 작아서 읽을 수 없는 광고판을 impression으로 계상하지 않기 위한 하한선.
 */
const MIN_SCREEN_SHARE = 0.005;

const SCREEN_AREA = VIEW_WIDTH * VIEW_HEIGHT;

/**
 * 광고판 배치와 노출 측정을 담당한다.
 *
 * 배치 좌표는 게임 월드 기준으로 고정되어 있고, 소재는 AdProvider에서 주입받는다.
 * 즉 렌더링/측정 코드는 광고 네트워크가 바뀌어도 그대로 유지된다.
 */
export class BillboardManager {
  private slots: readonly BillboardSlot[] = [];
  private readonly provider: AdProvider;

  constructor(provider: AdProvider) {
    this.provider = provider;
  }

  getSlots(): readonly BillboardSlot[] {
    return this.slots;
  }

  /**
   * 스테이지 광고판 배치를 적용하고 소재를 받아온다.
   * 맵이 바뀌면 슬롯 구성이 통째로 달라지므로 노출 측정도 새로 시작된다.
   */
  async setStage(stage: Stage): Promise<void> {
    this.slots = stage.billboards.map((def) => new BillboardSlot(def));
    await this.loadCreatives();
  }

  /** 프로바이더에서 소재를 받아 각 슬롯을 채운다. */
  private async loadCreatives(): Promise<void> {
    const slotIds = this.slots.map((slot) => slot.id);
    try {
      const creatives = await this.provider.fetchBillboardCreatives(slotIds);
      for (const slot of this.slots) {
        slot.setCreative(creatives[slot.id] ?? null);
      }
    } catch (error) {
      // 광고 실패가 게임을 멈춰서는 안 된다.
      console.warn('[ads] 소재 로드 실패, 빈 슬롯으로 진행합니다.', error);
    }
  }

  /**
   * 노출 측정 갱신.
   * @param dtMs 프레임 시간
   * @param occluders 광고판을 가리는 사각형들(파이터 등)
   */
  update(dtMs: number, occluders: readonly Rect[]): void {
    for (const slot of this.slots) {
      const share = this.computeScreenShare(slot, occluders);
      slot.accumulate(dtMs, share >= MIN_SCREEN_SHARE ? share : 0);

      if (
        !slot.hasReportedImpression() &&
        slot.getVisibleMs() >= IMPRESSION_THRESHOLD_MS
      ) {
        const creative = slot.getCreative();
        if (creative) {
          slot.markImpressionReported();
          this.provider.reportImpression({
            slotId: slot.id,
            creativeId: creative.id,
            cumulativeVisibleMs: slot.getVisibleMs(),
            averageScreenShare: slot.getAverageScreenShare(),
          });
        }
      }
    }
  }

  /** 진행률 표시용. 0~1 사이로 클램프된 값. */
  getImpressionProgress(slot: BillboardSlot): number {
    return Math.min(1, slot.getVisibleMs() / IMPRESSION_THRESHOLD_MS);
  }

  /**
   * 광고판이 화면에서 실제로 차지하는 면적 비율.
   * 뷰포트 클리핑 + 가림(occlusion)을 반영한다.
   */
  private computeScreenShare(slot: BillboardSlot, occluders: readonly Rect[]): number {
    // 먼저 뷰포트로 자른다. 화면 밖 영역은 노출이 아니다.
    const left = Math.max(slot.x, 0);
    const top = Math.max(slot.y, 0);
    const right = Math.min(slot.x + slot.width, VIEW_WIDTH);
    const bottom = Math.min(slot.y + slot.height, VIEW_HEIGHT);

    if (right <= left || bottom <= top) return 0;

    let area = (right - left) * (bottom - top);

    // 가림 면적을 뺀다. 반드시 '화면에 보이는 영역'과 교차시켜야 한다.
    // 원본 슬롯 사각형과 교차시키면 화면 밖 부분까지 차감되어 과대 차감된다.
    // 가림막끼리 겹치면 중복 차감될 수 있지만, 이는 노출을 적게 세는
    // 보수적인 방향이라 수익을 과대계상할 위험은 없다.
    for (const occluder of occluders) {
      const overlapWidth =
        Math.min(right, occluder.x + occluder.width) - Math.max(left, occluder.x);
      const overlapHeight =
        Math.min(bottom, occluder.y + occluder.height) - Math.max(top, occluder.y);
      if (overlapWidth > 0 && overlapHeight > 0) {
        area -= overlapWidth * overlapHeight;
      }
    }

    if (area <= 0) return 0;
    return area / SCREEN_AREA;
  }
}
