import { BillboardManager } from '../ads/BillboardManager';
import type { Rect } from '../ads/BillboardManager';
import type { AdProvider } from '../ads/AdProvider';
import { AiController } from './AiController';
import { Arena } from './Arena';
import type { HitInfo } from './Arena';
import { EFFECTS, FIXED_DT_MS, MATCH, RINGOUT_Y, UI_COLORS } from './constants';
import { Fighter, NEUTRAL_INTENT } from './Fighter';
import type { FighterIntent, PlayerId } from './Fighter';
import { Input } from './Input';
import { Renderer } from './Renderer';
import type { MatchPhase, RenderState } from './Renderer';
import { detectRingOut, resolveTimeout } from './roundRules';
import type { RoundEndReason } from './roundRules';
import { STAGES, getStageCenterX } from './stages';
import type { Stage } from './stages';

export type GameMode = 'ai' | 'local2p';

/** 떨어진 파이터를 고정할 y좌표. 링아웃 판정선보다 충분히 아래. */
const PARK_Y = RINGOUT_Y + 400;

export class Game {
  private readonly renderer: Renderer;
  private readonly input: Input;
  private readonly ads: AdProvider;
  private readonly billboards: BillboardManager;

  private stageIndex = 0;
  private stage: Stage;
  private stageCenterX: number;

  private arena!: Arena;
  private p1!: Fighter;
  private p2!: Fighter;
  private ai: AiController;

  private mode: GameMode = 'ai';
  private phase: MatchPhase = 'title';
  private scores: Record<PlayerId, number> = { p1: 0, p2: 0 };

  private countdownMs = 0;
  private phaseTimerMs = 0;
  private fightBannerMs = 0;
  private roundTimeLeftMs: number = MATCH.roundTimeMs;
  private shake = 0;
  /** 타격 순간 물리를 멈추는 시간(ms). 타격감의 대부분이 여기서 나온다. */
  private hitstopMs = 0;
  private showAdMetrics = false;

  private roundWinner: PlayerId | null = null;
  private roundEndReason: RoundEndReason = 'ringout';
  private matchWinner: PlayerId | null = null;
  /**
   * 연속 무승부 횟수.
   * 두 플레이어가 완전히 대칭으로 가만히 있으면 시간초과 판정도 무승부가 나고
   * 라운드가 영원히 반복된다. 그 무한 루프를 끊기 위한 카운터.
   */
  private consecutiveDraws = 0;

  /** 점프 입력 버퍼. 물리 스텝이 없는 프레임에서 입력이 사라지는 것을 막는다. */
  private readonly pendingJump: Record<PlayerId, boolean> = { p1: false, p2: false };

  /** 리워드 광고 이어하기는 매치당 한 번만 제공한다. */
  private continueUsed = false;
  /** 광고 오버레이가 화면을 덮고 있는 동안은 시뮬레이션과 노출 측정을 멈춘다. */
  private adPlaying = false;
  private transientMessage = '';
  private transientMessageMs = 0;
  private matchesPlayed = 0;

  private lastTimestamp = 0;
  private accumulator = 0;

  constructor(canvas: HTMLCanvasElement, ads: AdProvider) {
    const firstStage = STAGES[0];
    if (!firstStage) {
      throw new Error('스테이지가 하나도 정의되지 않았습니다.');
    }
    this.stage = firstStage;
    this.stageCenterX = getStageCenterX(firstStage);

    this.renderer = new Renderer(canvas);
    this.input = new Input();
    this.ads = ads;
    this.billboards = new BillboardManager(ads);
    this.ai = new AiController(firstStage);
    this.buildArena();
  }

  async start(): Promise<void> {
    await this.ads.init();
    await this.billboards.setStage(this.stage);
    this.lastTimestamp = performance.now();
    requestAnimationFrame((timestamp) => this.frame(timestamp));
  }

  // ------------------------------------------------------------- 스테이지

  private buildArena(): void {
    this.arena = new Arena(this.stage);

    const [spawn1, spawn2] = this.stage.spawns;
    this.p1 = new Fighter('p1', spawn1.x, spawn1.y, 1);
    this.p2 = new Fighter('p2', spawn2.x, spawn2.y, -1);
    this.arena.addFighter(this.p1);
    this.arena.addFighter(this.p2);
    this.arena.onHit = (info) => this.onHit(info);
  }

  /**
   * 맵 교체. 물리 월드와 파이터를 새로 만들고 광고판 배치도 갈아끼운다.
   * 슬롯 구성이 바뀌므로 노출 측정은 새 스테이지 기준으로 다시 시작된다.
   */
  private applyStage(index: number): void {
    const stage = STAGES[index % STAGES.length];
    if (!stage) return;

    this.stageIndex = index % STAGES.length;
    this.stage = stage;
    this.stageCenterX = getStageCenterX(stage);

    this.buildArena();
    this.ai.setStage(stage);
    void this.billboards.setStage(stage);

    this.resetMatch();
    this.phase = 'title';
    this.shake = 0;
    this.hitstopMs = 0;
  }

  // ---------------------------------------------------------------- 루프

  private onHit(info: HitInfo): void {
    this.shake = Math.min(EFFECTS.shakeMax, 6 + info.power * 16);
    this.hitstopMs = EFFECTS.hitstopBaseMs + info.power * EFFECTS.hitstopScaleMs;
    const color = info.victim.id === 'p1' ? UI_COLORS.p1 : UI_COLORS.p2;
    this.renderer.hitEffect(info.x, info.y, info.power, color, info.direction);
  }

  private frame(timestamp: number): void {
    // 탭 전환 후 복귀 시 델타가 폭주하는 것을 막는다.
    const rawDelta = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;
    const delta = Math.min(rawDelta, 100);

    this.handleGlobalInput();

    if (this.hitstopMs > 0) {
      // 물리는 멈추고 이펙트만 흐른다.
      this.hitstopMs = Math.max(0, this.hitstopMs - delta);
      // 화면은 그대로 보이고 있으므로 광고 노출은 계속 집계해야 한다.
      // 여기서 빼먹으면 타격이 잦은 라운드일수록 수익 지표가 과소 계상된다.
      this.accumulateAdExposure(delta);
    } else if (!this.adPlaying) {
      this.accumulator += delta;
      let steps = 0;
      let firstStep = true;
      while (this.accumulator >= FIXED_DT_MS && steps < 3) {
        this.simulate(FIXED_DT_MS, firstStep);
        this.accumulator -= FIXED_DT_MS;
        steps += 1;
        firstStep = false;
        // 타격이 발생하면 즉시 멈춰서 임팩트를 살린다.
        if (this.hitstopMs > 0) break;
      }
      if (this.accumulator > FIXED_DT_MS * 3) {
        this.accumulator = 0;
      }
    }

    this.renderer.draw(this.buildRenderState(), this.billboards, delta);
    this.input.endFrame();
    requestAnimationFrame((next) => this.frame(next));
  }

  private handleGlobalInput(): void {
    if (this.adPlaying) return;

    // 점프는 '눌린 순간'만 유효한 입력인데, 물리는 60Hz 고정 스텝으로 돌고
    // 화면은 그보다 빠를 수 있다(144Hz 등). 그런 프레임에서는 물리 스텝이
    // 아예 없어서 그냥 읽으면 입력이 통째로 사라진다.
    // 그래서 프레임마다 버퍼에 latch하고, 물리 스텝이 소비할 때 비운다.
    if (this.input.wasPressed('KeyW')) this.pendingJump.p1 = true;
    if (this.input.wasPressed('ArrowUp')) this.pendingJump.p2 = true;

    if (this.input.wasPressed('KeyI')) {
      this.showAdMetrics = !this.showAdMetrics;
    }

    if (this.input.wasPressed('KeyC') && this.phase !== 'fight') {
      this.applyStage(this.stageIndex + 1);
      return;
    }

    if (this.input.wasPressed('KeyM')) {
      this.mode = this.mode === 'ai' ? 'local2p' : 'ai';
      this.resetMatch();
      this.phase = 'title';
      return;
    }

    if (this.input.wasPressed('Space')) {
      if (this.phase === 'title') {
        this.resetMatch();
        this.startRound();
      } else if (this.phase === 'matchEnd') {
        // 다음 매치는 다음 맵에서. 맵이 돌아가면 광고판 소재도 새로 붙는다.
        this.applyStage(this.stageIndex + 1);
        this.startRound();
      }
    }

    if (
      this.input.wasPressed('KeyR') &&
      this.phase === 'matchEnd' &&
      this.canOfferContinue()
    ) {
      void this.continueWithRewardedAd();
    }
  }

  // ------------------------------------------------------------------ 광고

  private canOfferContinue(): boolean {
    // 플레이어(1P)가 졌을 때만, 그리고 매치당 한 번만.
    return !this.continueUsed && this.matchWinner === 'p2';
  }

  private async continueWithRewardedAd(): Promise<void> {
    this.adPlaying = true;
    let result: Awaited<ReturnType<AdProvider['showRewarded']>>;
    try {
      result = await this.ads.showRewarded('continue_after_loss');
    } catch (error) {
      console.warn('[ads] 리워드 광고 실패', error);
      result = 'unavailable';
    }
    this.adPlaying = false;
    // 광고 동안 흐른 시간은 시뮬레이션에 반영하지 않는다.
    this.lastTimestamp = performance.now();
    this.accumulator = 0;

    if (result === 'completed') {
      this.continueUsed = true;
      this.scores.p2 = Math.max(0, this.scores.p2 - 1);
      this.matchWinner = null;
      this.startRound();
      return;
    }

    this.setTransientMessage(
      result === 'dismissed'
        ? '광고를 끝까지 봐야 이어할 수 있습니다'
        : '광고를 불러올 수 없습니다',
    );
  }

  private setTransientMessage(message: string): void {
    this.transientMessage = message;
    this.transientMessageMs = 2400;
  }

  // ------------------------------------------------------------- 매치 진행

  private resetMatch(): void {
    this.scores = { p1: 0, p2: 0 };
    this.roundWinner = null;
    this.matchWinner = null;
    this.consecutiveDraws = 0;
    this.continueUsed = false;
    this.transientMessage = '';
    this.transientMessageMs = 0;
  }

  private startRound(): void {
    const [spawn1, spawn2] = this.stage.spawns;
    this.p1.reset(spawn1.x, spawn1.y, 1);
    this.p2.reset(spawn2.x, spawn2.y, -1);
    this.ai.reset();
    // 라운드 시작 전에 쌓인 점프 입력은 버린다.
    this.pendingJump.p1 = false;
    this.pendingJump.p2 = false;
    this.roundWinner = null;
    this.phase = 'countdown';
    this.countdownMs = MATCH.countdownMs;
    this.roundTimeLeftMs = MATCH.roundTimeMs;
    this.shake = 0;
    this.hitstopMs = 0;
  }

  private simulate(dtMs: number, allowEdgeInput: boolean): void {
    this.shake = Math.max(0, this.shake - dtMs * EFFECTS.shakeDecay);
    this.transientMessageMs = Math.max(0, this.transientMessageMs - dtMs);
    if (this.transientMessageMs === 0) {
      this.transientMessage = '';
    }

    switch (this.phase) {
      case 'countdown': {
        this.countdownMs -= dtMs;
        this.stepFighters(dtMs, NEUTRAL_INTENT, NEUTRAL_INTENT);
        if (this.countdownMs <= 0) {
          this.phase = 'fight';
          this.fightBannerMs = 700;
        }
        break;
      }

      case 'fight': {
        this.fightBannerMs = Math.max(0, this.fightBannerMs - dtMs);
        this.roundTimeLeftMs = Math.max(0, this.roundTimeLeftMs - dtMs);
        const p1Intent = this.readHumanIntent('p1', allowEdgeInput);
        const p2Intent =
          this.mode === 'ai'
            ? this.ai.update(dtMs, this.p2, this.p1)
            : this.readHumanIntent('p2', allowEdgeInput);
        this.stepFighters(dtMs, p1Intent, p2Intent);
        this.checkRoundEnd();
        break;
      }

      case 'roundEnd': {
        this.phaseTimerMs -= dtMs;
        this.stepFighters(dtMs, NEUTRAL_INTENT, NEUTRAL_INTENT);
        if (this.phaseTimerMs <= 0) {
          this.advanceAfterRound();
        }
        break;
      }

      case 'title':
      case 'matchEnd': {
        this.stepFighters(dtMs, NEUTRAL_INTENT, NEUTRAL_INTENT);
        break;
      }
    }

    this.accumulateAdExposure(dtMs);
  }

  /**
   * 광고판 노출 측정. 파이터가 배너를 가리는 만큼 차감된다.
   * 화면이 실제로 보이는 동안에만 호출해야 한다(광고 오버레이 중에는 호출 금지).
   */
  private accumulateAdExposure(dtMs: number): void {
    const occluders: Rect[] = [this.p1.getBounds(), this.p2.getBounds()];
    this.billboards.update(dtMs, occluders);
  }

  private stepFighters(dtMs: number, p1Intent: FighterIntent, p2Intent: FighterIntent): void {
    this.p1.update(dtMs, p1Intent);
    this.p2.update(dtMs, p2Intent);
    this.arena.step(dtMs);

    for (const fighter of [this.p1, this.p2]) {
      // 착지 먼지는 물리 결과를 보고 뿌린다.
      if (fighter.justLanded) {
        this.renderer.landingDust(fighter.x, fighter.y + 30, fighter.landingImpact);
      }
      // 라운드가 끝난 뒤에도 물리가 도니까, 떨어진 파이터의 좌표 폭주를 막는다.
      fighter.parkIfFallenFar(PARK_Y);
    }
  }

  private readHumanIntent(id: PlayerId, allowEdgeInput: boolean): FighterIntent {
    const keys =
      id === 'p1'
        ? { left: 'KeyA', right: 'KeyD', up: 'KeyW', charge: 'KeyS' }
        : { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', charge: 'ArrowDown' };

    const left = this.input.isDown(keys.left) ? -1 : 0;
    const right = this.input.isDown(keys.right) ? 1 : 0;
    const charging = this.input.isDown(keys.charge);
    const upHeld = this.input.isDown(keys.up);

    // 차지 중에는 위 키가 점프가 아니라 조준이다. 버퍼에 쌓인 점프는 버려서
    // 대시를 놓은 뒤에 엉뚱하게 점프가 튀어나오지 않게 한다.
    if (charging) {
      this.pendingJump[id] = false;
    }

    let jump = false;
    // edge 입력은 한 프레임의 첫 서브스텝에서만 소비한다.
    if (allowEdgeInput && this.pendingJump[id]) {
      jump = true;
      this.pendingJump[id] = false;
    }

    return {
      moveX: left + right,
      jump,
      charge: charging,
      // 위 키는 평소엔 점프, 차지 중에는 대시 조준으로 동작한다.
      aimY: charging && upHeld ? -1 : 0,
    };
  }

  private checkRoundEnd(): void {
    const outcome =
      detectRingOut(this.p1, this.p2) ??
      (this.roundTimeLeftMs <= 0
        ? resolveTimeout(this.p1, this.p2, this.stageCenterX)
        : null);

    if (!outcome) return;

    this.roundWinner = outcome.winner;
    this.roundEndReason = outcome.reason;
    if (outcome.winner) {
      this.scores[outcome.winner] += 1;
    }
    this.phase = 'roundEnd';
    this.phaseTimerMs = MATCH.roundEndDelayMs;
  }

  private advanceAfterRound(): void {
    if (this.roundWinner === null) {
      this.consecutiveDraws += 1;
      // 무승부가 계속되면 라운드가 무한히 반복된다. 세 번째에 매치를 무승부로 끝낸다.
      if (this.consecutiveDraws >= 3) {
        this.matchWinner = null;
        this.endMatch();
        return;
      }
    } else {
      this.consecutiveDraws = 0;
    }

    const p1Wins = this.scores.p1 >= MATCH.roundsToWin;
    const p2Wins = this.scores.p2 >= MATCH.roundsToWin;

    if (p1Wins || p2Wins) {
      this.matchWinner = p1Wins ? 'p1' : 'p2';
      this.endMatch();
      return;
    }

    this.startRound();
  }

  private endMatch(): void {
    this.phase = 'matchEnd';
    this.matchesPlayed += 1;
    // 매 매치마다 인터스티셜을 띄우면 이탈이 커진다. 두 매치에 한 번.
    if (this.matchesPlayed % 2 === 0) {
      void this.ads.showInterstitial('match_end');
    }
  }

  private buildRenderState(): RenderState {
    let bannerTitle = '';
    let bannerSubtitle = '';

    switch (this.phase) {
      case 'title':
        bannerTitle = 'RING OUT ARENA';
        bannerSubtitle = 'Space로 시작   ·   상대를 발판 밖으로 밀어내면 승리';
        break;
      case 'fight':
        if (this.fightBannerMs > 0) bannerTitle = 'FIGHT!';
        break;
      case 'roundEnd': {
        if (this.roundWinner) {
          bannerTitle = `${this.roundWinner === 'p1' ? '1P' : '2P'} 라운드 획득`;
          bannerSubtitle =
            this.roundEndReason === 'timeout' ? '시간 초과 · 중앙에 더 가까운 쪽 승리' : '';
        } else {
          bannerTitle =
            this.roundEndReason === 'double_ringout' ? '동시 링아웃' : '시간 초과 · 무승부';
          bannerSubtitle = '라운드를 다시 진행합니다';
        }
        break;
      }
      case 'matchEnd': {
        bannerTitle = this.matchWinner
          ? `${this.matchWinner === 'p1' ? '1P' : '2P'} 승리`
          : '무승부';
        if (this.transientMessage) {
          bannerSubtitle = this.transientMessage;
        } else if (this.canOfferContinue()) {
          bannerSubtitle = 'R: 광고 보고 한 라운드 되돌리기   ·   Space: 다음 맵으로';
        } else {
          bannerSubtitle = 'Space: 다음 맵으로';
        }
        break;
      }
      case 'countdown':
        break;
    }

    return {
      stage: this.stage,
      fighters: [this.p1, this.p2],
      phase: this.phase,
      countdownMs: this.countdownMs,
      roundTimeLeftMs: this.roundTimeLeftMs,
      scores: this.scores,
      bannerTitle,
      bannerSubtitle,
      shake: this.shake,
      mode: this.mode,
      showAdMetrics: this.showAdMetrics,
    };
  }
}
