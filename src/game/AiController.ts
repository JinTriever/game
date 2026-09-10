import { FIGHTER } from './constants';
import type { Fighter, FighterIntent } from './Fighter';
import { findSupportingPlatform, getEdgeMargin } from './stages';
import type { PlatformDef, Stage } from './stages';

/**
 * AI 상대.
 *
 * 완벽하게 두지 않는 게 목적이다. 반응 지연과 차지 오차를 넣어서
 * 플레이어가 이길 여지를 남긴다. 대신 아래 두 가지는 확실하게 해야
 * 게임이 성립한다.
 *  - 발판이 갈라진 맵에서 대각 점프로 건너올 것
 *  - 허공에 떴을 때 진행 방향을 유지하며 복귀할 것 (되돌아가면 공중에서 왕복한다)
 */
export class AiController {
  /** 0(허술함) ~ 1(빈틈 없음). 레벨마다 바뀐다. */
  private skill: number;

  private stage: Stage;

  private state: 'approach' | 'charge' | 'recover' = 'approach';
  private stateTimer = 0;
  private chargeTargetMs = 0;
  private jumpCooldownMs = 0;

  /** 공중 복귀 대시를 위한 차지 홀드 누적. */
  private liftHoldMs = 0;

  /** 발판 건너기 단계. 조주거리를 확보하는 중인지 달려가는 중인지. */
  private crossStage: 'run-up' | 'back-up' = 'run-up';
  private crossTimerMs = 0;

  constructor(stage: Stage, skill = 0.62) {
    this.stage = stage;
    this.skill = Math.min(1, Math.max(0, skill));
  }

  setStage(stage: Stage): void {
    this.stage = stage;
    this.reset();
  }

  /** 레벨이 바뀔 때 난이도를 갈아끼운다. */
  setSkill(skill: number): void {
    this.skill = Math.min(1, Math.max(0, skill));
  }

  reset(): void {
    this.state = 'approach';
    this.stateTimer = 0;
    this.chargeTargetMs = 0;
    this.jumpCooldownMs = 0;
    this.liftHoldMs = 0;
    this.crossStage = 'run-up';
    this.crossTimerMs = 0;
  }

  update(dtMs: number, self: Fighter, opponent: Fighter): FighterIntent {
    this.stateTimer += dtMs;
    this.jumpCooldownMs = Math.max(0, this.jumpCooldownMs - dtMs);
    if (self.grounded) {
      this.liftHoldMs = 0;
    }

    const support = findSupportingPlatform(this.stage, self.x, self.y);
    const opponentSupport = findSupportingPlatform(this.stage, opponent.x, opponent.y);

    // 1. 발 밑에 발판이 없다. 복귀가 유일한 목표.
    //    이 판단이 다른 무엇보다 먼저 와야 한다. 아래 로직들이 개입하면
    //    공중에서 방향이 뒤집혀서 그대로 떨어진다.
    if (!support) {
      const target = this.pickRecoveryPlatform(self);
      return target ? this.steerToPlatform(dtMs, self, target) : intent({});
    }

    // 2. 상대가 다른 발판에 있으면 건너가야 한다.
    //    공중이어도 계속 목표를 향해 밀어줘야 착지에 성공한다.
    if (opponentSupport && opponentSupport !== support) {
      return this.attemptCross(dtMs, self, support, opponentSupport);
    }

    const platformCenterX = support.x + support.width / 2;
    // '안전한 방향'은 스테이지 중앙이 아니라 지금 밟고 있는 발판의 중앙이다.
    // 스테이지 중앙은 맵에 따라 허공일 수 있다.
    const towardSafety: 1 | -1 = self.x < platformCenterX ? 1 : -1;
    const edgeMargin = getEdgeMargin(support, self.x);

    const dx = opponent.x - self.x;
    const distance = Math.abs(dx);
    const towardOpponent = Math.sign(dx) || self.facing;

    // 3. 발판 끝에 몰렸으면 안쪽으로 자리를 되찾는다.
    if (edgeMargin < 60) {
      this.state = 'approach';
      return intent({ moveX: towardSafety });
    }

    // 4. 상대가 큰 대시를 준비 중이면 회피.
    const threatened = opponent.chargeRatio > 0.5 && distance < 230;
    if (threatened && this.state !== 'charge') {
      const wantsJump =
        this.jumpCooldownMs <= 0 && self.grounded && Math.random() < this.skill * 0.5;
      if (wantsJump) {
        this.jumpCooldownMs = 900;
        return intent({ moveX: towardSafety, jump: true });
      }
      if (edgeMargin < 210) {
        return intent({ moveX: towardSafety });
      }
    }

    // 상대가 위에 있으면 위쪽 대각으로 조준한다.
    const aimY = opponent.y < self.y - 55 ? -1 : 0;

    switch (this.state) {
      case 'approach': {
        const engageDistance = 150;
        if (distance <= engageDistance && self.canDash() && edgeMargin > 90) {
          this.state = 'charge';
          this.stateTimer = 0;
          this.chargeTargetMs = this.pickChargeDuration(distance);
          return intent({ charge: true, aimY });
        }
        // 접근. 실력이 낮으면 가끔 멈칫하게 해서 빈틈을 만든다.
        const hesitates = Math.random() > 0.35 + this.skill * 0.65;
        return intent({ moveX: hesitates ? 0 : towardOpponent });
      }

      case 'charge': {
        const lostTarget = distance > 320;
        const chargeDone = this.stateTimer >= this.chargeTargetMs;
        if (chargeDone || lostTarget) {
          this.state = 'recover';
          this.stateTimer = 0;
          // charge를 false로 내리는 순간이 곧 대시 발사다.
          return intent({});
        }
        const canStepIn = edgeMargin > 130 && distance > 90;
        return intent({ moveX: canStepIn ? towardOpponent : 0, charge: true, aimY });
      }

      case 'recover': {
        const recoverMs = 260 + (1 - this.skill) * 420;
        if (this.stateTimer >= recoverMs) {
          this.state = 'approach';
          this.stateTimer = 0;
        }
        return intent({ moveX: edgeMargin < 170 ? towardSafety : 0 });
      }
    }
  }

  /**
   * 허공에서 어느 발판으로 갈지 고른다.
   *
   * 발판 '중심'까지의 거리로 고르면 안 된다. 틈 한가운데에서는 항상
   * 방금 떠난 발판이 더 가깝게 나와서, 건너던 도중에 뒤로 돌아버린다.
   * 그래서 착지 가능한 가장 가까운 지점까지의 거리로 재고,
   * 이미 그 방향으로 날아가고 있으면 비용을 크게 깎아 관성을 살린다.
   */
  private pickRecoveryPlatform(self: Fighter): PlatformDef | null {
    let best: PlatformDef | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    const vx = self.body.velocity.x;

    for (const platform of this.stage.platforms) {
      const landingX = clamp(self.x, platform.x + 45, platform.x + platform.width - 45);
      const horizontal = Math.abs(landingX - self.x);
      // 올라가야 하는 높이는 수평 이동보다 비싸다.
      const rise = Math.max(0, self.y + FIGHTER.radius - platform.y);
      let cost = horizontal + rise * 1.7;

      const goingThatWay = Math.sign(landingX - self.x);
      if (goingThatWay !== 0 && goingThatWay === Math.sign(vx) && Math.abs(vx) > 1.5) {
        cost *= 0.4;
      }

      if (cost < bestCost) {
        bestCost = cost;
        best = platform;
      }
    }

    return best;
  }

  /**
   * 목표 발판으로 몸을 몰아간다.
   * 발판 높이보다 아래로 떨어졌고 아직 공중 대시가 남았으면
   * 위쪽 대각 대시로 솟구쳐 올라온다.
   */
  private steerToPlatform(dtMs: number, self: Fighter, target: PlatformDef): FighterIntent {
    const landingX = clamp(self.x, target.x + 45, target.x + target.width - 45);
    const towardTarget = Math.sign(landingX - self.x) || self.facing;

    // 발판보다 '확실히' 아래로 떨어졌을 때만 복귀 대시를 쓴다.
    // 점프 도중에도 발판보다 낮은 순간이 있는데, 그때 대시가 나가면
    // 수평 임펄스까지 얹혀서 목표를 지나쳐 반대편으로 날아간다.
    const wellBelowDeck = self.y > target.y + 60;
    const falling = self.body.velocity.y > 0.4;

    if (wellBelowDeck && falling && self.canDash()) {
      const holdMs = 240;
      if (this.liftHoldMs < holdMs) {
        this.liftHoldMs += dtMs;
        // moveX를 목표 쪽으로 유지해야 facing이 맞고, 대시가 목표 방향으로 나간다.
        return intent({ moveX: towardTarget, charge: true, aimY: -1 });
      }
      this.liftHoldMs = 0;
      // charge를 내려서 위쪽 대각 대시를 발사한다.
      return intent({ moveX: towardTarget });
    }

    return intent({ moveX: towardTarget });
  }

  /**
   * 다른 발판으로 건너가기.
   *
   * 도약 순간의 수평 속도가 도달 거리를 결정한다. 제자리에서 뛰면 못 건넌다.
   *
   * 여기서 조심할 함정이 하나 있다. '발판 끝'을 목표로 걸어가면 도착하는
   * 순간 속도가 0이 되어, 정작 속도가 필요한 지점에서 속도가 사라진다.
   * 그러면 도약 조건이 영원히 성립하지 않고 발판 끝에서 진동하며 갇힌다.
   * 그래서 조주거리가 부족하면 먼저 뒤로 물러난 뒤 달려와서 뛴다.
   */
  private attemptCross(
    dtMs: number,
    self: Fighter,
    support: PlatformDef,
    target: PlatformDef,
  ): FighterIntent {
    const targetIsRight = target.x > support.x;
    const direction: 1 | -1 = targetIsRight ? 1 : -1;

    // 이미 공중이면 목표를 향해 계속 밀어준다.
    if (!self.grounded) {
      this.crossStage = 'run-up';
      this.crossTimerMs = 0;
      return this.steerToPlatform(dtMs, self, target);
    }

    this.crossTimerMs += dtMs;

    const edgeX = targetIsRight ? support.x + support.width : support.x;
    const oppositeEdgeX = targetIsRight ? support.x : support.x + support.width;
    // 도약 방향 성분만 본다. 양수면 아직 발판 위, 음수면 이미 끝을 넘었다.
    const distanceToEdge = (edgeX - self.x) * direction;
    const approachSpeed = self.body.velocity.x * direction;
    const roomBehind = Math.abs(self.x - oppositeEdgeX);

    // 끝에 가까운데 속도가 없으면 조주거리를 확보해야 한다.
    if (this.crossStage === 'run-up' && distanceToEdge < 70 && approachSpeed < 3) {
      this.crossStage = 'back-up';
    }

    if (this.crossStage === 'back-up') {
      const gotEnoughRoom = distanceToEdge >= RUN_UP_DISTANCE;
      // 반대쪽 끝이 가까우면 더 물러날 수 없다. 있는 거리로 시도한다.
      const outOfRoom = roomBehind < 55;
      if (gotEnoughRoom || outOfRoom) {
        this.crossStage = 'run-up';
        this.crossTimerMs = 0;
      } else {
        return intent({ moveX: -direction });
      }
    }

    // 발판 끝에 충분한 속도로 도달했으면 도약.
    if (distanceToEdge <= 30 && approachSpeed > 3.2 && this.jumpCooldownMs <= 0) {
      this.jumpCooldownMs = 700;
      this.crossStage = 'run-up';
      this.crossTimerMs = 0;
      return intent({ moveX: direction, jump: true });
    }

    // 오래 못 건너고 있으면 어딘가 막힌 것이다. 물러나서 처음부터 다시.
    if (this.crossTimerMs > 2600) {
      this.crossTimerMs = 0;
      this.crossStage = 'back-up';
    }

    return intent({ moveX: direction });
  }

  /**
   * 거리에 따라 차지 시간을 고른다.
   * 가까우면 짧게 찔러넣고, 멀면 크게 모아서 한 방을 노린다.
   */
  private pickChargeDuration(distance: number): number {
    const normalized = Math.min(1, distance / 150);
    const ideal = FIGHTER.chargeTimeMs * (0.35 + normalized * 0.6);
    const errorRange = FIGHTER.chargeTimeMs * 0.35 * (1 - this.skill);
    const error = (Math.random() * 2 - 1) * errorRange;
    return Math.max(120, ideal + error);
  }
}

/**
 * 발판 건너기 전에 확보하려는 조주거리(px).
 * 최고 속도(5.2)까지 가속하는 데 필요한 거리보다 넉넉하게 잡는다.
 */
const RUN_UP_DISTANCE = 150;

/** 의도 객체를 기본값으로 채워서 만든다. */
function intent(partial: Partial<FighterIntent>): FighterIntent {
  return {
    moveX: partial.moveX ?? 0,
    jump: partial.jump ?? false,
    charge: partial.charge ?? false,
    aimY: partial.aimY ?? 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}
