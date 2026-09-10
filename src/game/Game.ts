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
import {
  LAST_LEVEL,
  getLevel,
  isCampaignComplete,
  loadProgress,
  nextLevelNumber,
  saveProgress,
} from './levels';
import type { Level, Progress } from './levels';
import { getMotionProfile, loadMotionLevel, saveMotionLevel } from './motion';
import type { MotionLevel } from './motion';
import { Renderer } from './Renderer';
import type { MatchPhase, RenderState } from './Renderer';
import { detectRingOut, resolveTimeout } from './roundRules';
import type { RoundEndReason } from './roundRules';
import { STAGES, getStageById, getStageCenterX } from './stages';
import type { Stage } from './stages';
import type { TouchControls } from './TouchControls';

export type GameMode = 'campaign' | 'local2p';

/** 떨어진 파이터를 고정할 y좌표. 링아웃 판정선보다 충분히 아래. */
const PARK_Y = RINGOUT_Y + 400;

export class Game {
  private readonly renderer: Renderer;
  private readonly input: Input;
  private readonly touch: TouchControls;
  private readonly ads: AdProvider;
  private readonly billboards: BillboardManager;

  private stage: Stage;
  private stageCenterX: number;
  /** local2p 모드에서 맵을 순환할 때 쓰는 인덱스. */
  private stageIndex = 0;

  private arena!: Arena;
  private p1!: Fighter;
  private p2!: Fighter;
  private readonly ai: AiController;

  private mode: GameMode = 'campaign';
  private progress: Progress;
  private levelNumber: number;
  private level: Level | null;

  private phase: MatchPhase = 'title';
  private scores: Record<PlayerId, number> = { p1: 0, p2: 0 };

  private countdownMs = 0;
  private phaseTimerMs = 0;
  private fightBannerMs = 0;
  private roundTimeLeftMs: number = MATCH.roundTimeMs;
  private shake = 0;
  private hitstopMs = 0;
  private showAdMetrics = false;
  /** 연출 강도. OS의 '동작 줄이기' 설정을 기본으로 따른다. */
  private motionLevel: MotionLevel;

  private roundWinner: PlayerId | null = null;
  private roundEndReason: RoundEndReason = 'ringout';
  private matchWinner: PlayerId | null = null;
  /** 이번 매치로 레벨을 처음 클리어했는지. 배너 문구에 쓴다. */
  private levelJustCleared = false;
  private consecutiveDraws = 0;

  private readonly pendingJump: Record<PlayerId, boolean> = { p1: false, p2: false };

  private continueUsed = false;
  private adPlaying = false;
  private transientMessage = '';
  private transientMessageMs = 0;
  private matchesPlayed = 0;

  private lastTimestamp = 0;
  private accumulator = 0;

  constructor(canvas: HTMLCanvasElement, ads: AdProvider, touch: TouchControls) {
    this.progress = loadProgress();
    this.levelNumber = nextLevelNumber(this.progress);
    this.level = getLevel(this.levelNumber);

    const firstStage = this.resolveStageForLevel(this.level);
    this.stage = firstStage;
    this.stageCenterX = getStageCenterX(firstStage);
    this.stageIndex = Math.max(
      0,
      STAGES.findIndex((s) => s.id === firstStage.id),
    );

    this.renderer = new Renderer(canvas);
    this.input = new Input();
    this.touch = touch;
    this.ads = ads;
    this.billboards = new BillboardManager(ads);
    this.ai = new AiController(firstStage, this.level?.aiSkill ?? 0.62);

    this.motionLevel = loadMotionLevel();
    this.renderer.setMotionProfile(getMotionProfile(this.motionLevel));
    this.touch.setMotionReduced(this.motionLevel === 'reduced');

    this.buildArena();
  }

  /** 연출 강도 전환. 어지러움을 호소하는 경우를 위한 접근성 설정. */
  private toggleMotionLevel(): void {
    this.motionLevel = this.motionLevel === 'full' ? 'reduced' : 'full';
    saveMotionLevel(this.motionLevel);
    this.renderer.setMotionProfile(getMotionProfile(this.motionLevel));
    this.touch.setMotionReduced(this.motionLevel === 'reduced');
    // 이미 진행 중인 흔들림도 즉시 반영한다. 껐는데 계속 흔들리면 이상하다.
    if (this.motionLevel === 'reduced') {
      this.shake = 0;
    }
    this.setTransientMessage(
      this.motionLevel === 'reduced' ? '연출 줄이기: 켜짐' : '연출 줄이기: 꺼짐',
    );
  }

  async start(): Promise<void> {
    await this.ads.init();
    await this.billboards.setStage(this.stage);
    this.lastTimestamp = performance.now();
    requestAnimationFrame((timestamp) => this.frame(timestamp));
  }

  // ------------------------------------------------------------- 스테이지

  private resolveStageForLevel(level: Level | null): Stage {
    const fallback = STAGES[0];
    if (!fallback) {
      throw new Error('스테이지가 하나도 정의되지 않았습니다.');
    }
    if (!level) return fallback;
    return getStageById(level.stageId) ?? fallback;
  }

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
  private applyStage(stage: Stage): void {
    this.stage = stage;
    this.stageCenterX = getStageCenterX(stage);
    this.stageIndex = Math.max(
      0,
      STAGES.findIndex((s) => s.id === stage.id),
    );

    this.buildArena();
    this.ai.setStage(stage);
    void this.billboards.setStage(stage);

    this.shake = 0;
    this.hitstopMs = 0;
  }

  /** 캠페인 레벨 진입. 맵과 난이도를 함께 세팅한다. */
  private enterLevel(levelNumber: number): void {
    const clamped = Math.min(LAST_LEVEL, Math.max(1, levelNumber));
    this.levelNumber = clamped;
    this.level = getLevel(clamped);
    this.applyStage(this.resolveStageForLevel(this.level));
    this.ai.setSkill(this.level?.aiSkill ?? 0.62);
    this.resetMatch();
  }

  /** 이 매치에서 필요한 라운드 승수. 레벨마다 다르다. */
  private get roundsToWin(): number {
    if (this.mode === 'campaign' && this.level) return this.level.roundsToWin;
    return MATCH.roundsToWin;
  }

  // ---------------------------------------------------------------- 루프

  private onHit(info: HitInfo): void {
    const motion = getMotionProfile(this.motionLevel);
    const rawShake = Math.min(
      EFFECTS.shakeMax,
      EFFECTS.shakeBase + info.power * EFFECTS.shakeScale,
    );
    this.shake = rawShake * motion.shake;
    this.hitstopMs =
      (EFFECTS.hitstopBaseMs + info.power * EFFECTS.hitstopScaleMs) * motion.hitstop;
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

    this.syncTouchUi();
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
    if (this.touch.consumeJump()) this.pendingJump.p1 = true;

    if (this.input.wasPressed('KeyI')) {
      this.showAdMetrics = !this.showAdMetrics;
    }

    if (this.input.wasPressed('KeyV') || this.touch.consumeMotionToggle()) {
      this.toggleMotionLevel();
    }

    // 맵 수동 변경은 자유 대전에서만. 캠페인은 레벨이 맵을 정한다.
    if (
      this.input.wasPressed('KeyC') &&
      this.mode === 'local2p' &&
      this.phase !== 'fight'
    ) {
      this.cycleStage();
      return;
    }

    if (this.input.wasPressed('KeyM')) {
      this.toggleMode();
      return;
    }

    if (this.input.wasPressed('Space') || this.touch.consumeStart()) {
      this.handleAdvanceRequest();
    }

    const continueRequested =
      this.input.wasPressed('KeyR') || this.touch.consumeContinue();
    if (continueRequested && this.phase === 'matchEnd' && this.canOfferContinue()) {
      void this.continueWithRewardedAd();
    }
  }

  private toggleMode(): void {
    this.mode = this.mode === 'campaign' ? 'local2p' : 'campaign';
    if (this.mode === 'campaign') {
      this.levelNumber = nextLevelNumber(this.progress);
      this.enterLevel(this.levelNumber);
    } else {
      this.level = null;
      this.resetMatch();
    }
    this.phase = 'title';
  }

  private cycleStage(): void {
    const next = STAGES[(this.stageIndex + 1) % STAGES.length];
    if (!next) return;
    this.applyStage(next);
    this.resetMatch();
    this.phase = 'title';
  }

  /** Space 또는 모바일 시작 버튼. 페이즈에 따라 의미가 달라진다. */
  private handleAdvanceRequest(): void {
    if (this.phase === 'title') {
      if (this.mode === 'campaign') {
        this.enterLevel(this.levelNumber);
      } else {
        this.resetMatch();
      }
      this.startRound();
      return;
    }

    if (this.phase !== 'matchEnd') return;

    if (this.mode === 'local2p') {
      // 자유 대전은 매치마다 다음 맵으로 넘어간다.
      const next = STAGES[(this.stageIndex + 1) % STAGES.length];
      if (next) this.applyStage(next);
      this.resetMatch();
      this.startRound();
      return;
    }

    // 캠페인: 이겼으면 다음 레벨, 졌으면 같은 레벨 재도전.
    if (this.matchWinner === 'p1') {
      if (isCampaignComplete(this.progress) && this.levelNumber >= LAST_LEVEL) {
        // 전부 깼다. 진행도는 남기고 처음부터 다시 돌 수 있게 한다.
        this.enterLevel(1);
      } else {
        this.enterLevel(this.levelNumber + 1);
      }
    } else {
      this.enterLevel(this.levelNumber);
    }
    this.startRound();
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
    this.touch.releaseAll();

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
    this.levelJustCleared = false;
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
          this.mode === 'local2p'
            ? this.readHumanIntent('p2', allowEdgeInput)
            : this.ai.update(dtMs, this.p2, this.p1);
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
    let moveX = left + right;
    let charging = this.input.isDown(keys.charge);
    let upHeld = this.input.isDown(keys.up);

    // 1P는 화면 버튼 입력도 함께 받는다. 키보드와 터치를 동시에 써도 동작한다.
    if (id === 'p1') {
      const touchMoveX = this.touch.getMoveX();
      if (touchMoveX !== 0) moveX = touchMoveX;
      charging = charging || this.touch.isCharging();
      upHeld = upHeld || this.touch.isAimingUp();
    }

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
      moveX,
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

    const target = this.roundsToWin;
    const p1Wins = this.scores.p1 >= target;
    const p2Wins = this.scores.p2 >= target;

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

    // 캠페인에서 이겼으면 진행도를 갱신하고 저장한다.
    if (this.mode === 'campaign' && this.matchWinner === 'p1') {
      if (this.levelNumber > this.progress.clearedUpTo) {
        this.progress = { clearedUpTo: this.levelNumber };
        saveProgress(this.progress);
        this.levelJustCleared = true;
      }
    }

    // 매 매치마다 인터스티셜을 띄우면 이탈이 커진다. 두 매치에 한 번.
    if (this.matchesPlayed % 2 === 0) {
      void this.ads.showInterstitial('match_end');
    }
  }

  // ------------------------------------------------------------- 모바일 UI

  private syncTouchUi(): void {
    if (!this.touch.isEnabled()) return;

    this.touch.setContinueVisible(this.phase === 'matchEnd' && this.canOfferContinue());

    // 문구를 빈 값으로 두면 라운드가 넘어갈 때마다 깜빡인다.
    // 전투 중 안내는 countdown~roundEnd 구간에서 계속 유지한다.
    switch (this.phase) {
      case 'title':
        this.touch.setHint('시작 버튼을 누르세요');
        break;
      case 'matchEnd':
        this.touch.setHint(
          this.matchWinner === 'p1' ? '다시하기 버튼으로 계속' : '다시하기 버튼으로 재도전',
        );
        break;
      case 'countdown':
      case 'fight':
      case 'roundEnd':
        this.touch.setHint('대시를 꾹 눌러 모았다가 떼세요 · 대시 중 점프를 누르면 위로');
        break;
    }
  }

  // ---------------------------------------------------------- 렌더 상태

  private buildRenderState(): RenderState {
    let bannerTitle = '';
    let bannerSubtitle = '';

    switch (this.phase) {
      case 'title':
        if (this.mode === 'campaign') {
          bannerTitle = `STAGE ${this.levelNumber}`;
          bannerSubtitle = this.level
            ? `상대: ${this.level.opponent}   ·   ${this.level.roundsToWin}선승`
            : '';
        } else {
          bannerTitle = '자유 대전';
          bannerSubtitle = '2P와 같은 키보드로 대결   ·   C로 맵 변경';
        }
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
        bannerTitle = this.buildMatchEndTitle();
        if (this.transientMessage) {
          bannerSubtitle = this.transientMessage;
        } else {
          bannerSubtitle = this.buildMatchEndSubtitle();
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
      roundsToWin: this.roundsToWin,
      bannerTitle,
      bannerSubtitle,
      shake: this.shake,
      mode: this.mode,
      levelNumber: this.mode === 'campaign' ? this.levelNumber : null,
      levelOpponent: this.mode === 'campaign' ? (this.level?.opponent ?? null) : null,
      clearedUpTo: this.progress.clearedUpTo,
      totalLevels: LAST_LEVEL,
      touchEnabled: this.touch.isEnabled(),
      motionReduced: this.motionLevel === 'reduced',
      showAdMetrics: this.showAdMetrics,
    };
  }

  private buildMatchEndTitle(): string {
    if (!this.matchWinner) return '무승부';
    if (this.mode === 'local2p') {
      return `${this.matchWinner === 'p1' ? '1P' : '2P'} 승리`;
    }
    if (this.matchWinner === 'p1') {
      if (this.levelNumber >= LAST_LEVEL) return '전 스테이지 클리어';
      return `STAGE ${this.levelNumber} 클리어`;
    }
    return '패배';
  }

  private buildMatchEndSubtitle(): string {
    if (this.mode === 'local2p') return 'Space: 다음 맵으로';

    if (this.matchWinner === 'p1') {
      if (this.levelNumber >= LAST_LEVEL) {
        return '축하합니다   ·   Space: 처음부터 다시';
      }
      const cleared = this.levelJustCleared ? '진행도 저장됨   ·   ' : '';
      return `${cleared}Space: STAGE ${this.levelNumber + 1}로`;
    }

    if (this.canOfferContinue()) {
      return 'R: 광고 보고 한 라운드 되돌리기   ·   Space: 재도전';
    }
    return 'Space: 재도전';
  }
}
