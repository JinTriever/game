import Matter from 'matter-js';
import { FIGHTER } from './constants';
import type { Fighter } from './Fighter';
import type { Stage } from './stages';

export interface HitInfo {
  attacker: Fighter;
  victim: Fighter;
  /** 0~1. 차지량. 연출 강도와 넉백에 함께 쓰인다. */
  power: number;
  x: number;
  y: number;
  /** 넉백이 향하는 방향(-1 또는 1). 충격파 연출 방향에 쓴다. */
  direction: number;
}

/**
 * 물리 월드와 스테이지 구조물, 충돌 해석을 담당한다.
 * 발판 구성은 Stage 데이터에서 그대로 가져온다.
 */
export class Arena {
  readonly engine: Matter.Engine;
  readonly stage: Stage;

  onHit: ((info: HitInfo) => void) | null = null;

  private readonly fightersByBodyId = new Map<number, Fighter>();
  private readonly platformBodies: Matter.Body[] = [];

  constructor(stage: Stage) {
    this.stage = stage;
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 1.6, scale: 0.001 },
    });

    for (const [index, platform] of stage.platforms.entries()) {
      const body = Matter.Bodies.rectangle(
        platform.x + platform.width / 2,
        platform.y + platform.height / 2,
        platform.width,
        platform.height,
        { isStatic: true, friction: 0.06, label: `platform:${index}` },
      );
      this.platformBodies.push(body);
    }

    Matter.Composite.add(this.engine.world, this.platformBodies);
    this.wireCollisionEvents();
  }

  addFighter(fighter: Fighter): void {
    this.fightersByBodyId.set(fighter.body.id, fighter);
    Matter.Composite.add(this.engine.world, fighter.body);
  }

  step(dtMs: number): void {
    // 접지 상태는 매 스텝 물리 결과로 다시 판정한다.
    for (const fighter of this.fightersByBodyId.values()) {
      fighter.grounded = false;
    }
    Matter.Engine.update(this.engine, dtMs);
  }

  private wireCollisionEvents(): void {
    const handlePairs = (event: Matter.IEventCollision<Matter.Engine>) => {
      for (const pair of event.pairs) {
        const a = this.fightersByBodyId.get(pair.bodyA.id);
        const b = this.fightersByBodyId.get(pair.bodyB.id);

        if (a && b) {
          // 파이터끼리 부딪힘. collisionStart에서만 처리한다.
          if (event.name === 'collisionStart') {
            this.resolveClash(a, b);
          }
          continue;
        }

        // 파이터 하나 + 발판 → 접지 판정.
        const fighter = a ?? b;
        const other = a ? pair.bodyB : pair.bodyA;
        if (fighter && other.label.startsWith('platform:')) {
          // 위로 빠르게 올라가는 중이면 접지로 보지 않는다(점프 직후 이중 점프 방지).
          if (fighter.body.velocity.y > -2) {
            fighter.grounded = true;
          }
        }
      }
    };

    Matter.Events.on(this.engine, 'collisionStart', handlePairs);
    Matter.Events.on(this.engine, 'collisionActive', handlePairs);
  }

  /**
   * 파이터 충돌 해석.
   * 양쪽이 동시에 대시하면 서로 튕겨나가고, 한쪽만 대시하면 일방적으로 밀린다.
   */
  private resolveClash(a: Fighter, b: Fighter): void {
    const aPower = a.consumeAttack();
    const bPower = b.consumeAttack();

    if (aPower === null && bPower === null) {
      // 둘 다 공격이 아니면 Matter의 기본 운동량 전달에 맡긴다.
      return;
    }

    const contactX = (a.x + b.x) / 2;
    const contactY = (a.y + b.y) / 2;

    if (aPower !== null && bPower !== null) {
      // 상쇄. 각자 상대의 위력만큼 밀린다.
      const direction = this.applyKnockback(b, a, aPower);
      this.applyKnockback(a, b, bPower);
      a.flashHit();
      b.flashHit();
      this.onHit?.({
        attacker: a,
        victim: b,
        power: Math.max(aPower, bPower),
        x: contactX,
        y: contactY,
        direction,
      });
      return;
    }

    const attacker = aPower !== null ? a : b;
    const victim = aPower !== null ? b : a;
    const power = aPower ?? bPower ?? 0;

    const direction = this.applyKnockback(victim, attacker, power);
    victim.flashHit();
    this.onHit?.({ attacker, victim, power, x: contactX, y: contactY, direction });
  }

  /** @returns 넉백 방향(-1 또는 1) */
  private applyKnockback(victim: Fighter, attacker: Fighter, power: number): number {
    const direction = Math.sign(victim.x - attacker.x) || attacker.facing;
    const magnitude = FIGHTER.knockbackBase + power * FIGHTER.knockbackScale;

    Matter.Body.setVelocity(victim.body, {
      x: direction * magnitude,
      // 살짝 띄워서 그대로 발판 밖으로 날아가는 그림이 나오게 한다.
      y: victim.body.velocity.y - 4.5,
    });
    Matter.Body.setAngularVelocity(victim.body, direction * 0.35 * (0.5 + power));

    // 때린 쪽도 반동으로 뒤로 밀린다. 무작정 최대 차지가 정답이 되지 않게 하는 장치.
    Matter.Body.setVelocity(attacker.body, {
      x: -direction * magnitude * FIGHTER.recoil,
      y: attacker.body.velocity.y,
    });

    return direction;
  }
}
