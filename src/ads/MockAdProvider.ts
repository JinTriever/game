import type {
  AdProvider,
  BillboardCreative,
  ImpressionReport,
  RewardedAdResult,
} from './AdProvider';

/**
 * 개발용 광고 구현체.
 *
 * - 리워드 광고는 3초 카운트다운 오버레이로 대체한다.
 * - 광고판 소재는 자체 플레이스홀더로 채운다.
 * - impression은 콘솔에 기록한다.
 *
 * 실제 네트워크 연동 시 이 파일만 대체하면 된다.
 */

const PLACEHOLDER_CREATIVES: readonly BillboardCreative[] = [
  {
    id: 'house-main',
    brand: 'YOUR BRAND HERE',
    caption: '이 자리에 광고가 들어갑니다',
    background: '#1f3b73',
    foreground: '#dce7ff',
    imageUrl: null,
    clickUrl: null,
  },
  {
    id: 'house-left',
    brand: 'AD SLOT',
    caption: '1:1',
    background: '#3a2a5c',
    foreground: '#e6dcff',
    imageUrl: null,
    clickUrl: null,
  },
  {
    id: 'house-right',
    brand: 'AD SLOT',
    caption: '1:1',
    background: '#2a5c4a',
    foreground: '#dcfff2',
    imageUrl: null,
    clickUrl: null,
  },
  {
    id: 'house-fence-a',
    brand: 'FENCE BANNER',
    caption: '4:1',
    background: '#5c2a3a',
    foreground: '#ffdce6',
    imageUrl: null,
    clickUrl: null,
  },
  {
    id: 'house-fence-b',
    brand: 'FENCE BANNER',
    caption: '4:1',
    background: '#5c4a2a',
    foreground: '#fff2dc',
    imageUrl: null,
    clickUrl: null,
  },
];

export class MockAdProvider implements AdProvider {
  readonly name = 'mock';

  private readonly overlay: HTMLElement | null;
  private readonly timerLabel: HTMLElement | null;

  constructor() {
    this.overlay = document.getElementById('ad-overlay');
    this.timerLabel = document.getElementById('ad-timer');
  }

  async init(): Promise<void> {
    // 실제 SDK라면 여기서 로드/핸드셰이크를 한다.
  }

  async showRewarded(placement: string): Promise<RewardedAdResult> {
    if (!this.overlay || !this.timerLabel) {
      return 'unavailable';
    }

    console.info(`[ads] rewarded 요청: ${placement}`);
    this.overlay.hidden = false;

    for (let remaining = 3; remaining > 0; remaining -= 1) {
      this.timerLabel.textContent = String(remaining);
      await delay(1000);
    }

    this.overlay.hidden = true;
    console.info(`[ads] rewarded 완료: ${placement}`);
    return 'completed';
  }

  async showInterstitial(placement: string): Promise<void> {
    console.info(`[ads] interstitial: ${placement}`);
  }

  async fetchBillboardCreatives(
    slotIds: readonly string[],
  ): Promise<Record<string, BillboardCreative | null>> {
    const result: Record<string, BillboardCreative | null> = {};
    slotIds.forEach((slotId, index) => {
      result[slotId] = PLACEHOLDER_CREATIVES[index % PLACEHOLDER_CREATIVES.length] ?? null;
    });
    return result;
  }

  reportImpression(report: ImpressionReport): void {
    console.info(
      `[ads] impression | slot=${report.slotId} creative=${report.creativeId} ` +
        `visible=${(report.cumulativeVisibleMs / 1000).toFixed(1)}s ` +
        `screenShare=${(report.averageScreenShare * 100).toFixed(2)}%`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
