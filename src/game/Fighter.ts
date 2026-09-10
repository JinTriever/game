import Matter from 'matter-js';
import { FIGHTER } from './constants';

export type PlayerId = 'p1' | 'p2';

/** 조작 의도. 사람 입력이든 AI든 이 형태로 통일해서 Fighter에 넣는다. */
export interface FighterIntent {
  /** -1(좌) ~ 1(우) */
  moveX: number;
  /** 이번 프레임에 점프 입력이 들어왔는지 (edge) */
  jump: boolean;
  /** 대시 차지 버튼을 누르고 있는지 (hold) */
  charge: boolean;
  /**
   * 대시 조준 수직 성분. -1이면 위쪽 대각, 0이면 수평.
   * 차지 중에만 의미가 있다.
   */
  aimY: number;
}

export const NEUTRAL_INTENT: FighterIntent = {
  moveX: 0,
  jump: false,
  charge: false,
  aimY: 0,
};

export class Fighter {
  readonly id: PlayerId;
  readonly body: Matter.Body;

  facing: 1 | -1;
  grounded = false;

  /** 현재 차지 누적 시간(ms). 렌더러가 게이지로 표시한다. */
  chargeMs = 0;
  /** 차지 중 조준 방향(-1 위 / 0 수평). 렌더러의 조준 화살표에 쓴다. */
  aimY = 0;

  /** 타격을 받은 직후 흰색으로 번쩍이는 잔여 시간(ms). */
  hitFlashMs = 0;
  /** 이번 프레임에 착지했는지. 착지 먼지 이펙트에 쓴다. */
  justLanded = false;
  /** 착지 순간의 낙하 속도. 먼지 크기에 쓴다. */
  landingImpact = 0;

  private dashActiveMs = 0;
  private dashCooldownMs = 0;
  /** 대시를 시작한 시점의 차지량(0~1). 넉백 계산에 쓴다. */
  private dashPower = 0;
  /** 실제로 발사된 대시의 각도(라디안, 화면 좌표계). 렌더러 잔상 방향에 쓴다. */
  private dashAngle = 0;
  private chargeHeldLastFrame = false;
  /** 착지 전까지 사용한 공중 대시 횟수. */
  private airDashesUsed = 0;
  private groundedLastFrame = false;
  /** 공중에 있던 마지막 프레임의 수직 속도. 착지 강도 계산에 쓴다. */
  private lastAirborneVy = 0;

  constructor(id: PlayerId, x: number, y: number, facing: 1 | -1) {
    this.id = id;
    this.facing = facing;
    this.body = Matter.Bodies.circle(x, y, FIGHTER.radius, {
      label: `fighter:${id}`,
      friction: 0.02,
      frictionAir: 0.012,
      restitution: 0.36,
      density: 0.0018,
    });
  }

  get x(): number {
    return this.body.position.x;
  }

  get y(): number {
    return this.body.position.y;
  }

  get chargeRatio(): number {
    return Math.min(1, this.chargeMs / FIGHTER.chargeTimeMs);
  }

  isDashing(): boolean {
    return this.dashActiveMs > 0;
  }

  getDashAngle(): number {
    return this.dashAngle;
  }

  /** 대시가 가능한 상태인지. 쿨다운과 공중 대시 제한을 함께 본다. */
  canDash(): boolean {
    if (this.dashCooldownMs > 0) return false;
    if (!this.grounded && this.airDashesUsed >= FIGHTER.airDashLimit) return false;
    return true;
  }

  /** 사각형 바운딩 박스. 광고판 가림 계산에 쓴다. */
  getBounds(): { x: number; y: number; width: number; height: number } {
    const r = FIGHTER.radius;
    return { x: this.x - r, y: this.y - r, width: r * 2, height: r * 2 };
  }

  flashHit(): void {
    this.hitFlashMs = 160;
  }

  update(dtMs: number, intent: FighterIntent): void {
    this.dashActiveMs = Math.max(0, this.dashActiveMs - dtMs);
    this.dashCooldownMs = Math.max(0, this.dashCooldownMs - dtMs);
    this.hitFlashMs = Math.max(0, this.hitFlashMs - dtMs);

    // 착지 감지. 공중 대시 횟수를 여기서 되돌린다.
    this.justLanded = this.grounded && !this.groundedLastFrame;
    if (this.justLanded) {
      // 충돌이 이미 수직 속도를 죽였기 때문에 지금 velocity.y를 읽으면 거의 0이다.
      // 공중에 있던 마지막 프레임의 낙하 속도를 써야 착지 강도가 나온다.
      this.landingImpact = Math.abs(this.lastAirborneVy);
      this.airDashesUsed = 0;
    }
    this.groundedLastFrame = this.grounded;
    if (!this.grounded) {
      this.lastAirborneVy = this.body.velocity.y;
    }

    if (intent.moveX !== 0) {
      this.facing = intent.moveX > 0 ? 1 : -1;
      this.applyMovement(intent.moveX);
    }

    // 차지 중에는 W/↑가 점프가 아니라 조준으로 동작한다.
    // 그래야 지상에서도 위쪽 대각 대시를 모을 수 있다.
    //
    // 중요: 차지가 끝난 프레임에 aimY를 0으로 지우면 안 된다.
    // 대시가 발사되는 시점이 바로 '버튼을 뗀 프레임'이고, launchDash()가
    // 이 값을 읽어서 각도를 정한다. 지워버리면 위쪽 대각 대시가 영원히 안 나간다.
    // 그래서 차지 중일 때만 갱신하고, 뗀 순간에는 마지막 값을 유지한다.
    if (intent.charge) {
      this.aimY = intent.aimY;
    }

    if (intent.jump && this.grounded && !intent.charge) {
      this.launchJump(intent.moveX);
    }

    this.updateCharge(dtMs, intent.charge);
    this.chargeHeldLastFrame = intent.charge;
  }

  /**
   * 공격 판정 소비. 대시 한 번에 한 번만 명중하도록 여기서 대시를 끝낸다.
   * @returns 명중 시 넉백 계산에 쓸 위력(0~1). 공격 상태가 아니면 null.
   */
  consumeAttack(): number | null {
    if (this.dashActiveMs <= 0) return null;
    const power = this.dashPower;
    this.dashActiveMs = 0;
    return power;
  }

  /**
   * 화면 아래로 한참 떨어졌으면 그 자리에 고정한다.
   *
   * 라운드가 끝난 뒤에도 물리는 계속 도는데, 떨어진 파이터를 그대로 두면
   * y좌표가 계속 커져서 수치가 폭주한다. 어차피 보이지 않는 위치다.
   */
  parkIfFallenFar(limitY: number): void {
    if (this.y <= limitY) return;
    Matter.Body.setPosition(this.body, { x: this.x, y: limitY });
    Matter.Body.setVelocity(this.body, { x: 0, y: 0 });
    Matter.Body.setAngularVelocity(this.body, 0);
  }

  /** 라운드 리셋. 물리 상태와 조작 상태를 모두 초기화한다. */
  reset(x: number, y: number, facing: 1 | -1): void {
    Matter.Body.setPosition(this.body, { x, y });
    Matter.Body.setVelocity(this.body, { x: 0, y: 0 });
    Matter.Body.setAngle(this.body, 0);
    Matter.Body.setAngularVelocity(this.body, 0);
    this.facing = facing;
    this.grounded = false;
    this.groundedLastFrame = false;
    this.chargeMs = 0;
    this.aimY = 0;
    this.hitFlashMs = 0;
    this.justLanded = false;
    this.landingImpact = 0;
    this.lastAirborneVy = 0;
    this.dashActiveMs = 0;
    this.dashCooldownMs = 0;
    this.dashPower = 0;
    this.dashAngle = 0;
    this.chargeHeldLastFrame = false;
    this.airDashesUsed = 0;
  }

  /**
   * 대각 점프.
   * 방향을 누른 채 점프하면 수평 임펄스가 더해져서 크게 도약한다.
   * 발판 사이가 갈라진 스테이지를 건너는 주 수단이다.
   */
  private launchJump(moveX: number): void {
    const horizontalBoost = moveX === 0 ? 0 : Math.sign(moveX) * FIGHTER.jumpHorizontalBoost;
    Matter.Body.setVelocity(this.body, {
      x: this.body.velocity.x + horizontalBoost,
      y: FIGHTER.jumpVelocity,
    });
    this.grounded = false;
    this.groundedLastFrame = false;
  }

  private applyMovement(moveX: number): void {
    const target = moveX * FIGHTER.maxSpeed;
    const current = this.body.velocity.x;

    // 대시 중에는 조작 개입을 거의 막는다. 그래야 임펄스가 살아있고,
    // 과하게 차지하면 링 밖으로 날아가는 "자기 발등 찍기"가 성립한다.
    let control = this.grounded ? FIGHTER.accel : FIGHTER.accel * FIGHTER.airControl;
    if (this.dashActiveMs > 0) {
      control = 0.04;
    }

    Matter.Body.setVelocity(this.body, {
      x: current + (target - current) * control,
      y: this.body.velocity.y,
    });
  }

  private updateCharge(dtMs: number, chargeHeld: boolean): void {
    if (chargeHeld && this.canDash()) {
      this.chargeMs = Math.min(FIGHTER.chargeTimeMs, this.chargeMs + dtMs);
      return;
    }

    const released = this.chargeHeldLastFrame && !chargeHeld;
    // 아주 짧은 탭은 무시해서 오조작으로 대시가 나가지 않게 한다.
    if (released && this.chargeMs > 80 && this.canDash()) {
      this.launchDash();
    }

    if (!chargeHeld) {
      this.chargeMs = 0;
    }
  }

  private launchDash(): void {
    const power = this.chargeRatio;
    const magnitude = FIGHTER.dashBase + power * FIGHTER.dashScale;

    // aimY가 -1이면 위쪽 대각으로, 0이면 수평(약간의 부양)으로 발사한다.
    let vx: number;
    let vy: number;
    if (this.aimY < 0) {
      const angle = FIGHTER.dashUpAngle;
      vx = Math.cos(angle) * magnitude * this.facing;
      vy = -Math.sin(angle) * magnitude;
      this.dashAngle = Math.atan2(vy, vx);
    } else {
      vx = this.facing * magnitude;
      vy = this.body.velocity.y - FIGHTER.dashLift;
      this.dashAngle = this.facing > 0 ? 0 : Math.PI;
    }

    Matter.Body.setVelocity(this.body, { x: vx, y: vy });

    if (!this.grounded) {
      this.airDashesUsed += 1;
    }

    this.dashPower = power;
    this.dashActiveMs = FIGHTER.dashActiveMs;
    this.dashCooldownMs = FIGHTER.dashActiveMs + FIGHTER.dashCooldownMs;
    this.chargeMs = 0;
  }
}
