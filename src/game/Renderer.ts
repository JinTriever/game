import type { BillboardManager } from '../ads/BillboardManager';
import type { BillboardSlot } from '../ads/BillboardSlot';
import { FIGHTER, MATCH, UI_COLORS, VIEW_HEIGHT, VIEW_WIDTH } from './constants';
import type { Fighter, PlayerId } from './Fighter';
import { findPlatformBelow } from './stages';
import type { PlatformDef, Stage } from './stages';

export type MatchPhase = 'title' | 'countdown' | 'fight' | 'roundEnd' | 'matchEnd';

export interface RenderState {
  stage: Stage;
  fighters: readonly Fighter[];
  phase: MatchPhase;
  /** countdown 단계에서 남은 시간(ms). */
  countdownMs: number;
  /** 라운드 제한 시간 잔량(ms). */
  roundTimeLeftMs: number;
  scores: Record<PlayerId, number>;
  bannerTitle: string;
  bannerSubtitle: string;
  /** 화면 흔들림 강도(px). */
  shake: number;
  mode: 'ai' | 'local2p';
  showAdMetrics: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifeMs: number;
  maxLifeMs: number;
  size: number;
  color: string;
  /** 프레임당 수직 가속. 0이면 중력을 받지 않는다(차지 오라 등). */
  gravity: number;
}

interface Shockwave {
  x: number;
  y: number;
  lifeMs: number;
  maxLifeMs: number;
  maxRadius: number;
  color: string;
  /** 넉백 방향. 링을 타원으로 늘려 방향감을 준다. */
  direction: number;
}

interface CrowdDot {
  x: number;
  y: number;
  color: string;
  phase: number;
}

const FONT = 'Inter, system-ui, -apple-system, sans-serif';

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private readonly particles: Particle[] = [];
  private readonly shockwaves: Shockwave[] = [];
  private readonly crowdFlashes: { x: number; y: number; lifeMs: number }[] = [];

  private crowd: readonly CrowdDot[] = [];
  private crowdStageId = '';

  private vignette: CanvasGradient | null = null;
  private flashMs = 0;
  private flashPeak = 0;
  private elapsedMs = 0;
  /** 이번 프레임의 실제 경과 시간. 프레임레이트 독립적인 연출 계산에 쓴다. */
  private lastDeltaMs = 16.667;

  /** 눈 깜빡임 타이밍. 캐릭터가 살아있어 보이게 하는 값싼 장치. */
  private readonly blink: Record<PlayerId, { nextMs: number; untilMs: number }> = {
    p1: { nextMs: 1800, untilMs: 0 },
    p2: { nextMs: 3100, untilMs: 0 },
  };

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D 캔버스 컨텍스트를 생성할 수 없습니다.');
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** 고해상도 디스플레이에서 선명하게 나오도록 백버퍼를 DPR만큼 키운다. */
  resize(): void {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(VIEW_WIDTH * dpr);
    this.canvas.height = Math.round(VIEW_HEIGHT * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 캔버스 크기가 바뀌면 캐시한 그라디언트를 버린다.
    this.vignette = null;
  }

  /** 타격 연출 일괄 처리. 파편 + 충격파 + 화면 플래시. */
  hitEffect(x: number, y: number, power: number, color: string, direction: number): void {
    this.burst(x, y, power, color);
    this.shockwaves.push({
      x,
      y,
      lifeMs: 0,
      maxLifeMs: 260 + power * 160,
      maxRadius: 60 + power * 140,
      color,
      direction,
    });
    this.flashPeak = Math.max(this.flashPeak, 0.1 + power * 0.22);
    this.flashMs = 110;
  }

  /** 타격 지점에 파편을 뿌린다. */
  burst(x: number, y: number, power: number, color: string): void {
    const count = Math.round(12 + power * 26);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * (3 + power * 8);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.5,
        lifeMs: 0,
        maxLifeMs: 380 + Math.random() * 460,
        size: 2 + Math.random() * (2 + power * 4),
        color,
        gravity: 0.28,
      });
    }
  }

  /** 착지 먼지. */
  landingDust(x: number, y: number, impact: number): void {
    if (impact < 4) return;
    const count = Math.round(Math.min(16, impact * 1.6));
    for (let i = 0; i < count; i += 1) {
      const side = Math.random() < 0.5 ? -1 : 1;
      this.particles.push({
        x: x + side * (4 + Math.random() * 14),
        y,
        vx: side * (0.6 + Math.random() * 2.4),
        vy: -Math.random() * 1.6,
        lifeMs: 0,
        maxLifeMs: 300 + Math.random() * 260,
        size: 2 + Math.random() * 4,
        color: 'rgba(220, 228, 250, 0.5)',
        gravity: 0.06,
      });
    }
  }

  draw(state: RenderState, billboards: BillboardManager, dtMs: number): void {
    this.elapsedMs += dtMs;
    this.lastDeltaMs = dtMs;
    this.syncCrowd(state.stage);
    this.updateEffects(dtMs, state);

    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

    this.drawBackdrop(state.stage);

    // 월드는 흔들리고 HUD는 고정된다.
    const shakeX = state.shake > 0 ? (Math.random() * 2 - 1) * state.shake : 0;
    const shakeY = state.shake > 0 ? (Math.random() * 2 - 1) * state.shake : 0;

    ctx.save();
    ctx.translate(shakeX, shakeY);
    this.drawBillboards(state.stage, billboards, state.showAdMetrics);
    this.drawFence(state.stage);
    this.drawVoid(state.stage);
    for (const platform of state.stage.platforms) {
      this.drawPlatform(state.stage, platform);
    }
    this.drawShockwaves();
    for (const fighter of state.fighters) {
      this.drawFighter(state.stage, fighter);
    }
    this.drawParticles();
    ctx.restore();

    this.drawVignette();
    this.drawScreenFlash();
    this.drawHud(state);
    if (state.showAdMetrics) {
      this.drawAdMetrics(billboards);
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------- 배경

  private syncCrowd(stage: Stage): void {
    if (this.crowdStageId === stage.id) return;
    this.crowdStageId = stage.id;
    this.crowd = stage.crowd ? buildCrowd(stage.crowd.topY, stage.crowd.bottomY, stage.palette.crowdDots) : [];
    this.crowdFlashes.length = 0;
  }

  private drawBackdrop(stage: Stage): void {
    const ctx = this.ctx;
    const p = stage.palette;

    const sky = ctx.createLinearGradient(0, 0, 0, VIEW_HEIGHT);
    sky.addColorStop(0, p.skyTop);
    sky.addColorStop(0.55, p.skyMid);
    sky.addColorStop(1, p.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

    this.drawArches(stage);
    this.drawSpotlights(stage);

    if (stage.crowd) {
      this.drawCrowd(stage);
    }

    // 아레나 중앙 글로우
    const focusY = stage.platforms[0] ? stage.platforms[0].y - 60 : 500;
    const glow = ctx.createRadialGradient(VIEW_WIDTH / 2, focusY, 40, VIEW_WIDTH / 2, focusY, 660);
    glow.addColorStop(0, p.glow);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  }

  /** 원경 아치 실루엣. 공간에 깊이를 준다. */
  private drawArches(stage: Stage): void {
    const ctx = this.ctx;
    ctx.fillStyle = stage.palette.silhouette;
    const baseY = stage.crowd ? stage.crowd.topY + 40 : 480;

    for (let i = 0; i < 5; i += 1) {
      const centerX = 140 + i * 250;
      const radius = 150 + (i % 2) * 40;
      ctx.beginPath();
      ctx.moveTo(centerX - radius, baseY);
      ctx.arc(centerX, baseY, radius, Math.PI, 0);
      ctx.lineTo(centerX + radius, baseY);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** 천장 스포트라이트 빔. 아주 느리게 흔들린다. */
  private drawSpotlights(stage: Stage): void {
    const ctx = this.ctx;
    ctx.fillStyle = stage.palette.beam;

    for (let i = 0; i < 4; i += 1) {
      const originX = 220 + i * 280;
      const sway = Math.sin(this.elapsedMs / 3200 + i * 1.7) * 55;
      const spread = 150;
      ctx.beginPath();
      ctx.moveTo(originX - 18, 0);
      ctx.lineTo(originX + 18, 0);
      ctx.lineTo(originX + sway + spread, VIEW_HEIGHT);
      ctx.lineTo(originX + sway - spread, VIEW_HEIGHT);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawCrowd(stage: Stage): void {
    const ctx = this.ctx;
    const band = stage.crowd;
    if (!band) return;

    ctx.fillStyle = stage.palette.crowdBand;
    ctx.fillRect(0, band.topY, VIEW_WIDTH, band.bottomY - band.topY);

    for (const dot of this.crowd) {
      const bob = Math.sin(this.elapsedMs / 420 + dot.phase) * 2.2;
      ctx.fillStyle = dot.color;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y + bob, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 관중석 카메라 플래시. 정적인 배경을 살아있게 만드는 값싼 트릭.
    for (const flash of this.crowdFlashes) {
      const alpha = Math.max(0, flash.lifeMs / 130);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.9})`;
      ctx.beginPath();
      ctx.arc(flash.x, flash.y, 6.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 관중석 아래 그림자로 발판과 분리한다.
    const shade = ctx.createLinearGradient(0, band.bottomY - 40, 0, band.bottomY);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, band.bottomY - 40, VIEW_WIDTH, 40);
  }

  // ------------------------------------------------------------ 광고판

  private drawBillboards(stage: Stage, billboards: BillboardManager, showMetrics: boolean): void {
    for (const slot of billboards.getSlots()) {
      this.drawBillboardSlot(stage, slot, billboards.getImpressionProgress(slot), showMetrics);
    }
  }

  private drawBillboardSlot(
    stage: Stage,
    slot: BillboardSlot,
    progress: number,
    showMetrics: boolean,
  ): void {
    const ctx = this.ctx;
    const creative = slot.getCreative();

    this.drawBillboardMount(stage, slot);

    // 프레임
    ctx.fillStyle = '#0a0d18';
    ctx.fillRect(slot.x - 7, slot.y - 7, slot.width + 14, slot.height + 14);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(slot.x - 7.5, slot.y - 7.5, slot.width + 15, slot.height + 15);

    const image = slot.getImage();
    if (image) {
      // cover 방식으로 잘라 넣어서 비율이 깨지지 않게 한다.
      const scale = Math.max(slot.width / image.width, slot.height / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(slot.x, slot.y, slot.width, slot.height);
      ctx.clip();
      ctx.drawImage(
        image,
        slot.x + (slot.width - drawWidth) / 2,
        slot.y + (slot.height - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
      ctx.restore();
    } else if (creative) {
      ctx.fillStyle = creative.background;
      ctx.fillRect(slot.x, slot.y, slot.width, slot.height);

      ctx.save();
      ctx.beginPath();
      ctx.rect(slot.x, slot.y, slot.width, slot.height);
      ctx.clip();

      // 소재 안쪽에 옅은 대각 스트라이프를 넣어 평평함을 줄인다.
      ctx.globalAlpha = 0.06;
      ctx.strokeStyle = creative.foreground;
      ctx.lineWidth = 10;
      for (let i = -slot.height; i < slot.width + slot.height; i += 34) {
        ctx.beginPath();
        ctx.moveTo(slot.x + i, slot.y);
        ctx.lineTo(slot.x + i + slot.height, slot.y + slot.height);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      ctx.fillStyle = creative.foreground;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const brandSize = fitFontSize(
        ctx,
        creative.brand,
        slot.width - 24,
        Math.min(40, slot.height * 0.34),
      );
      ctx.font = `800 ${brandSize}px ${FONT}`;
      const centerX = slot.x + slot.width / 2;
      const hasCaption = Boolean(creative.caption);
      ctx.fillText(
        creative.brand,
        centerX,
        slot.y + slot.height / 2 - (hasCaption ? brandSize * 0.44 : 0),
      );

      if (creative.caption) {
        const captionSize = Math.max(10, brandSize * 0.44);
        ctx.font = `400 ${captionSize}px ${FONT}`;
        ctx.globalAlpha = 0.72;
        ctx.fillText(creative.caption, centerX, slot.y + slot.height / 2 + brandSize * 0.64);
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      // 보드 상단 광택
      const gloss = ctx.createLinearGradient(0, slot.y, 0, slot.y + slot.height);
      gloss.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
      gloss.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gloss;
      ctx.fillRect(slot.x, slot.y, slot.width, slot.height);
    } else {
      // 재고 없음. 빈 슬롯도 시각적으로 자연스럽게 보여야 한다.
      ctx.fillStyle = '#131829';
      ctx.fillRect(slot.x, slot.y, slot.width, slot.height);
    }

    // 광고 고지. 규정상 광고임을 알 수 있어야 한다.
    if (creative) {
      const tagWidth = 26;
      const tagHeight = 14;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(slot.x + slot.width - tagWidth - 4, slot.y + 4, tagWidth, tagHeight);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = `600 9px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AD', slot.x + slot.width - tagWidth / 2 - 4, slot.y + 4 + tagHeight / 2);
    }

    if (showMetrics) {
      const barHeight = 4;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(slot.x, slot.y + slot.height - barHeight, slot.width, barHeight);
      ctx.fillStyle = slot.hasReportedImpression() ? UI_COLORS.good : UI_COLORS.charge;
      ctx.fillRect(slot.x, slot.y + slot.height - barHeight, slot.width * progress, barHeight);
    }
  }

  /** 광고판 지지 구조. 기둥이냐 케이블이냐로 스테이지 분위기가 달라진다. */
  private drawBillboardMount(stage: Stage, slot: BillboardSlot): void {
    const ctx = this.ctx;

    if (slot.mount === 'stand' && slot.legBottomY !== null) {
      const legTop = slot.y + slot.height;
      const legWidth = 13;
      ctx.fillStyle = stage.palette.silhouette;
      ctx.fillRect(slot.x + slot.width * 0.2 - legWidth / 2, legTop, legWidth, slot.legBottomY - legTop);
      ctx.fillRect(slot.x + slot.width * 0.8 - legWidth / 2, legTop, legWidth, slot.legBottomY - legTop);
      // 교차 보강재
      ctx.strokeStyle = stage.palette.silhouette;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(slot.x + slot.width * 0.2, legTop + 12);
      ctx.lineTo(slot.x + slot.width * 0.8, slot.legBottomY - 12);
      ctx.moveTo(slot.x + slot.width * 0.8, legTop + 12);
      ctx.lineTo(slot.x + slot.width * 0.2, slot.legBottomY - 12);
      ctx.stroke();
      return;
    }

    if (slot.mount === 'hanging') {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(slot.x + slot.width * 0.22, 0);
      ctx.lineTo(slot.x + slot.width * 0.22, slot.y);
      ctx.moveTo(slot.x + slot.width * 0.78, 0);
      ctx.lineTo(slot.x + slot.width * 0.78, slot.y);
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ 구조물

  private drawFence(stage: Stage): void {
    const fence = stage.fence;
    if (!fence) return;
    const ctx = this.ctx;

    ctx.fillStyle = stage.palette.fence;
    ctx.fillRect(fence.x, fence.y, fence.width, fence.height);

    ctx.fillStyle = stage.palette.fenceRail;
    ctx.fillRect(fence.x, fence.y, fence.width, 8);

    // 세로 지주
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    for (let x = fence.x + 40; x < fence.x + fence.width; x += 96) {
      ctx.fillRect(x, fence.y, 6, fence.height);
    }
  }

  /** 발판 아래 낙하 구역. 떨어지면 죽는다는 걸 색으로 알려준다. */
  private drawVoid(stage: Stage): void {
    const ctx = this.ctx;
    let topY = VIEW_HEIGHT;
    for (const platform of stage.platforms) {
      topY = Math.min(topY, platform.y);
    }

    const pit = ctx.createLinearGradient(0, topY - 10, 0, VIEW_HEIGHT);
    pit.addColorStop(0, 'rgba(4, 5, 10, 0.35)');
    pit.addColorStop(0.4, 'rgba(4, 5, 10, 0.82)');
    pit.addColorStop(1, '#03040a');
    ctx.fillStyle = pit;
    ctx.fillRect(0, topY - 10, VIEW_WIDTH, VIEW_HEIGHT - topY + 10);
  }

  private drawPlatform(stage: Stage, platform: PlatformDef): void {
    const ctx = this.ctx;
    const p = stage.palette;
    const { x, y, width, height } = platform;

    // 본체
    ctx.fillStyle = p.platformBody;
    ctx.fillRect(x, y, width, height);

    // 아래쪽 음영으로 두께감
    const shade = ctx.createLinearGradient(0, y + height * 0.35, 0, y + height);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, p.platformShade);
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + height * 0.35, width, height * 0.65);

    // 세로 이음선
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)';
    ctx.lineWidth = 2;
    for (let seam = x + 80; seam < x + width; seam += 80) {
      ctx.beginPath();
      ctx.moveTo(seam, y + 10);
      ctx.lineTo(seam, y + height);
      ctx.stroke();
    }

    // 상단 매트
    ctx.fillStyle = p.platformTop;
    ctx.fillRect(x, y, width, 11);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(x, y, width, 3);

    // 양 끝 위험 표시. 여기서 떨어진다는 신호.
    const hazardWidth = Math.min(56, width * 0.16);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, hazardWidth, 11);
    ctx.rect(x + width - hazardWidth, y, hazardWidth, 11);
    ctx.clip();
    ctx.fillStyle = p.accent;
    ctx.globalAlpha = 0.75;
    for (let i = -12; i < hazardWidth + 12; i += 14) {
      ctx.beginPath();
      ctx.moveTo(x + i, y + 11);
      ctx.lineTo(x + i + 7, y);
      ctx.lineTo(x + i + 14, y);
      ctx.lineTo(x + i + 7, y + 11);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + width - hazardWidth + i, y + 11);
      ctx.lineTo(x + width - hazardWidth + i + 7, y);
      ctx.lineTo(x + width - hazardWidth + i + 14, y);
      ctx.lineTo(x + width - hazardWidth + i + 7, y + 11);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 좌우 끝단 발광 캡
    ctx.fillStyle = p.platformEdge;
    ctx.fillRect(x, y, 5, height);
    ctx.fillRect(x + width - 5, y, 5, height);
    ctx.shadowColor = p.accent;
    ctx.shadowBlur = 16;
    ctx.fillRect(x, y, 5, height);
    ctx.fillRect(x + width - 5, y, 5, height);
    ctx.shadowBlur = 0;
  }

  // -------------------------------------------------------------- 파이터

  private drawFighter(stage: Stage, fighter: Fighter): void {
    const ctx = this.ctx;
    const isP1 = fighter.id === 'p1';
    const main = isP1 ? UI_COLORS.p1 : UI_COLORS.p2;
    const dark = isP1 ? UI_COLORS.p1Dark : UI_COLORS.p2Dark;
    const glow = isP1 ? UI_COLORS.p1Glow : UI_COLORS.p2Glow;
    const r = FIGHTER.radius;

    this.drawFighterShadow(stage, fighter, r);
    this.drawDashTrail(fighter, main, r);
    this.drawChargeAura(fighter, main);

    const velocity = fighter.body.velocity;
    const speed = Math.hypot(velocity.x, velocity.y);
    // 빠를수록 진행 방향으로 늘어난다. 물리적 정확함보다 읽히는 속도감이 중요하다.
    const stretch = 1 + Math.min(0.34, speed * 0.013);
    const squash = 1 / stretch;
    const motionAngle = speed > 0.6 ? Math.atan2(velocity.y, velocity.x) : 0;

    // 본체
    ctx.save();
    ctx.translate(fighter.x, fighter.y);
    ctx.rotate(motionAngle);
    ctx.scale(stretch, squash);

    ctx.shadowColor = glow;
    ctx.shadowBlur = fighter.isDashing() ? 26 : 12;

    const bodyGradient = ctx.createRadialGradient(-r * 0.32, -r * 0.36, r * 0.16, 0, 0, r);
    bodyGradient.addColorStop(0, lighten(main));
    bodyGradient.addColorStop(0.55, main);
    bodyGradient.addColorStop(1, dark);
    ctx.fillStyle = bodyGradient;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 아래쪽 반사광
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, r - 1.5, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    // 위쪽 림 라이트
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r - 1, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();

    ctx.restore();

    // 피격 플래시
    if (fighter.hitFlashMs > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.85, fighter.hitFlashMs / 160);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(fighter.x, fighter.y, r + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    this.drawFace(fighter, r);
    this.drawChargeGauge(fighter, r);
  }

  private drawFighterShadow(stage: Stage, fighter: Fighter, r: number): void {
    const platform = findPlatformBelow(stage, fighter.x, fighter.y);
    if (!platform) return;

    const ctx = this.ctx;
    const height = Math.max(0, platform.y - fighter.y);
    const alpha = Math.max(0, 0.34 - height / 850);
    if (alpha <= 0) return;

    const scale = Math.max(0.45, 1 - height / 700);
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
    ctx.beginPath();
    ctx.ellipse(fighter.x, platform.y + 5, r * 0.92 * scale, r * 0.26 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawDashTrail(fighter: Fighter, color: string, r: number): void {
    if (!fighter.isDashing()) return;
    const ctx = this.ctx;
    const angle = fighter.getDashAngle();
    const speed = Math.hypot(fighter.body.velocity.x, fighter.body.velocity.y);

    // 진행 방향 반대쪽으로 잔상
    for (let i = 1; i <= 4; i += 1) {
      ctx.globalAlpha = 0.2 / i;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(
        fighter.x - Math.cos(angle) * i * speed * 0.9,
        fighter.y - Math.sin(angle) * i * speed * 0.9,
        r * (1 - i * 0.1),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    // 속도선
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i += 1) {
      const offset = (i - 2) * 12;
      const perpX = -Math.sin(angle) * offset;
      const perpY = Math.cos(angle) * offset;
      const length = 26 + Math.random() * 34;
      ctx.beginPath();
      ctx.moveTo(fighter.x + perpX - Math.cos(angle) * r, fighter.y + perpY - Math.sin(angle) * r);
      ctx.lineTo(
        fighter.x + perpX - Math.cos(angle) * (r + length),
        fighter.y + perpY - Math.sin(angle) * (r + length),
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** 차지 중 주변 입자가 안쪽으로 빨려 들어온다. 힘이 모이는 느낌. */
  private drawChargeAura(fighter: Fighter, color: string): void {
    if (fighter.chargeMs <= 0) return;
    const ratio = fighter.chargeRatio;
    // 생성 확률을 프레임 시간에 비례시킨다. 그러지 않으면 144Hz 화면에서
    // 입자가 2배 이상 쏟아져서 그림도 달라지고 부하도 커진다.
    const framesElapsed = this.lastDeltaMs / 16.667;
    if (Math.random() < (0.55 + ratio * 0.45) * framesElapsed) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 70 + Math.random() * 60;
      const speed = 1.6 + ratio * 2.6;
      this.particles.push({
        x: fighter.x + Math.cos(angle) * distance,
        y: fighter.y + Math.sin(angle) * distance,
        vx: -Math.cos(angle) * speed,
        vy: -Math.sin(angle) * speed,
        lifeMs: 0,
        maxLifeMs: distance / speed * 16,
        size: 1.6 + Math.random() * 2.2,
        color,
        gravity: 0,
      });
    }
  }

  private drawFace(fighter: Fighter, r: number): void {
    const ctx = this.ctx;
    const state = this.blink[fighter.id];
    const blinking = state.untilMs > 0;
    // 차지 중에는 눈을 찌푸린다.
    const charging = fighter.chargeMs > 0;

    ctx.save();
    ctx.translate(fighter.x, fighter.y);
    // 회전을 절반만 반영해서 굴러도 얼굴이 읽히게 한다.
    ctx.rotate(fighter.body.angle * 0.5);

    ctx.fillStyle = '#0a0d18';
    const frontX = fighter.facing * r * 0.36;
    const backX = fighter.facing * r * 0.04;
    const eyeY = -r * 0.14;

    if (blinking) {
      ctx.fillRect(frontX - r * 0.18, eyeY - 1.5, r * 0.36, 3);
      ctx.fillRect(backX - r * 0.14, eyeY - 1.5, r * 0.28, 3);
    } else if (charging) {
      // 찌푸린 눈
      ctx.fillRect(frontX - r * 0.18, eyeY - r * 0.05, r * 0.36, r * 0.14);
      ctx.fillRect(backX - r * 0.14, eyeY - r * 0.05, r * 0.28, r * 0.12);
    } else {
      ctx.beginPath();
      ctx.arc(frontX, eyeY, r * 0.17, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(backX, eyeY - r * 0.03, r * 0.13, 0, Math.PI * 2);
      ctx.fill();

      // 하이라이트
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(frontX + r * 0.05, eyeY - r * 0.06, r * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawChargeGauge(fighter: Fighter, r: number): void {
    if (fighter.chargeMs <= 0) return;
    const ctx = this.ctx;
    const ratio = fighter.chargeRatio;
    const full = ratio >= 1;
    const color = full ? UI_COLORS.chargeFull : UI_COLORS.charge;
    // 완충되면 맥동해서 "지금 놔라"를 알린다.
    const pulse = full ? 1 + Math.sin(this.elapsedMs / 70) * 0.08 : 1;

    ctx.save();
    ctx.translate(fighter.x, fighter.y);

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, (r + 10) * pulse, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = full ? 18 : 8;
    ctx.beginPath();
    ctx.arc(0, 0, (r + 10) * pulse, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 조준 화살표. aimY가 -1이면 위쪽 대각을 가리킨다.
    const aimAngle = fighter.aimY < 0 ? -FIGHTER.dashUpAngle : 0;
    const arrowLength = 18 + ratio * 48;
    ctx.rotate(fighter.facing > 0 ? aimAngle : Math.PI - aimAngle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r + 18, 0);
    ctx.lineTo(r + 18 + arrowLength, -10);
    ctx.lineTo(r + 18 + arrowLength, 10);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  // -------------------------------------------------------------- 이펙트

  private updateEffects(dtMs: number, state: RenderState): void {
    const frames = dtMs / 16.667;

    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      if (!p) continue;
      p.lifeMs += dtMs;
      if (p.lifeMs >= p.maxLifeMs) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * frames;
      p.y += p.vy * frames;
      p.vy += p.gravity * frames;
      p.vx *= 0.985;
    }

    for (let i = this.shockwaves.length - 1; i >= 0; i -= 1) {
      const wave = this.shockwaves[i];
      if (!wave) continue;
      wave.lifeMs += dtMs;
      if (wave.lifeMs >= wave.maxLifeMs) this.shockwaves.splice(i, 1);
    }

    this.flashMs = Math.max(0, this.flashMs - dtMs);
    if (this.flashMs === 0) this.flashPeak = 0;

    // 눈 깜빡임
    for (const id of ['p1', 'p2'] as const) {
      const blink = this.blink[id];
      blink.nextMs -= dtMs;
      if (blink.untilMs > 0) {
        blink.untilMs -= dtMs;
      } else if (blink.nextMs <= 0) {
        blink.untilMs = 110;
        blink.nextMs = 1600 + Math.random() * 3200;
      }
    }

    // 관중석 플래시
    for (let i = this.crowdFlashes.length - 1; i >= 0; i -= 1) {
      const flash = this.crowdFlashes[i];
      if (!flash) continue;
      flash.lifeMs -= dtMs;
      if (flash.lifeMs <= 0) this.crowdFlashes.splice(i, 1);
    }
    // 싸우는 중에는 플래시가 더 잦다.
    const flashChance = state.phase === 'fight' ? 0.07 : 0.02;
    if (this.crowd.length > 0 && Math.random() < flashChance) {
      const dot = this.crowd[Math.floor(Math.random() * this.crowd.length)];
      if (dot) this.crowdFlashes.push({ x: dot.x, y: dot.y, lifeMs: 130 });
    }
  }

  private drawShockwaves(): void {
    const ctx = this.ctx;
    for (const wave of this.shockwaves) {
      const progress = wave.lifeMs / wave.maxLifeMs;
      const radius = wave.maxRadius * easeOut(progress);
      const alpha = (1 - progress) * 0.7;

      ctx.save();
      ctx.translate(wave.x, wave.y);
      // 넉백 방향으로 살짝 늘려서 힘의 방향을 보여준다.
      ctx.scale(1 + wave.direction * 0.14, 1 - Math.abs(wave.direction) * 0.14);
      ctx.strokeStyle = wave.color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(1, 8 * (1 - progress));
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = alpha * 0.55;
      ctx.lineWidth = Math.max(1, 3 * (1 - progress));
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const life = 1 - p.lifeMs / p.maxLifeMs;
      ctx.globalAlpha = Math.max(0, life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    if (!this.vignette) {
      const gradient = ctx.createRadialGradient(
        VIEW_WIDTH / 2,
        VIEW_HEIGHT / 2,
        VIEW_HEIGHT * 0.42,
        VIEW_WIDTH / 2,
        VIEW_HEIGHT / 2,
        VIEW_WIDTH * 0.78,
      );
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
      this.vignette = gradient;
    }
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  }

  private drawScreenFlash(): void {
    if (this.flashMs <= 0) return;
    const ctx = this.ctx;
    ctx.fillStyle = `rgba(255, 255, 255, ${this.flashPeak * (this.flashMs / 110)})`;
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  }

  // ------------------------------------------------------------------ HUD

  private drawHud(state: RenderState): void {
    const ctx = this.ctx;

    this.drawScorePips('p1', state.scores.p1, 44, 'left');
    this.drawScorePips('p2', state.scores.p2, VIEW_WIDTH - 44, 'right');

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 라운드 타이머
    if (state.phase === 'fight' || state.phase === 'countdown') {
      const seconds = Math.ceil(state.roundTimeLeftMs / 1000);
      const warning = state.roundTimeLeftMs <= MATCH.roundTimeWarningMs;
      ctx.fillStyle = warning ? UI_COLORS.chargeFull : UI_COLORS.text;
      ctx.font = `700 42px ${FONT}`;
      if (warning) {
        ctx.shadowColor = UI_COLORS.chargeFull;
        ctx.shadowBlur = 18;
      }
      ctx.fillText(String(seconds), VIEW_WIDTH / 2, 50);
      ctx.shadowBlur = 0;
    }

    // 스테이지 이름
    ctx.fillStyle = state.stage.palette.accent;
    ctx.font = `700 12px ${FONT}`;
    ctx.fillText(state.stage.name, VIEW_WIDTH / 2, 84);

    // 중앙 배너
    if (state.phase === 'countdown') {
      const remainingSeconds = Math.ceil(state.countdownMs / 1000);
      // 숫자가 바뀔 때마다 커졌다 작아진다.
      const fraction = (state.countdownMs % 1000) / 1000;
      const scale = 1 + (1 - fraction) * 0.22;
      ctx.save();
      ctx.translate(VIEW_WIDTH / 2, 250);
      ctx.scale(scale, scale);
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = `800 118px ${FONT}`;
      ctx.shadowColor = state.stage.palette.accent;
      ctx.shadowBlur = 30;
      ctx.fillText(String(remainingSeconds), 0, 0);
      ctx.restore();
      ctx.shadowBlur = 0;
    } else if (state.bannerTitle) {
      const bandHeight = state.bannerSubtitle ? 150 : 104;
      const band = ctx.createLinearGradient(0, 190, 0, 190 + bandHeight);
      band.addColorStop(0, 'rgba(6, 8, 16, 0)');
      band.addColorStop(0.5, 'rgba(6, 8, 16, 0.72)');
      band.addColorStop(1, 'rgba(6, 8, 16, 0)');
      ctx.fillStyle = band;
      ctx.fillRect(0, 190, VIEW_WIDTH, bandHeight);

      const titleSize = state.phase === 'fight' ? 68 : 54;
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = `800 ${titleSize}px ${FONT}`;
      ctx.shadowColor = state.stage.palette.accent;
      ctx.shadowBlur = 24;
      ctx.fillText(state.bannerTitle, VIEW_WIDTH / 2, 242);
      ctx.shadowBlur = 0;

      if (state.bannerSubtitle) {
        ctx.fillStyle = UI_COLORS.textDim;
        ctx.font = `500 21px ${FONT}`;
        ctx.fillText(state.bannerSubtitle, VIEW_WIDTH / 2, 306);
      }

      // 타이틀 화면에서는 맵 설명을 함께 보여준다.
      if (state.phase === 'title') {
        ctx.fillStyle = state.stage.palette.accent;
        ctx.font = `600 17px ${FONT}`;
        ctx.fillText(`${state.stage.name} — ${state.stage.tagline}`, VIEW_WIDTH / 2, 344);
      }
    }

    // 하단 조작 안내
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = `500 14px ${FONT}`;
    const p2Hint =
      state.mode === 'ai' ? 'AI 상대' : '2P ←/→ 이동, ↑ 점프, ↓ 꾹 눌러 대시(↑로 위 조준)';
    ctx.fillText(
      `1P A/D 이동, W 점프(이동 중이면 대각), S 꾹 눌러 대시(W로 위 조준)   ·   ${p2Hint}`,
      VIEW_WIDTH / 2,
      VIEW_HEIGHT - 38,
    );
    ctx.fillText(
      'Space 시작   ·   M 모드 변경   ·   C 맵 변경   ·   I 광고 지표',
      VIEW_WIDTH / 2,
      VIEW_HEIGHT - 18,
    );
  }

  private drawScorePips(id: PlayerId, wins: number, x: number, align: 'left' | 'right'): void {
    const ctx = this.ctx;
    const color = id === 'p1' ? UI_COLORS.p1 : UI_COLORS.p2;
    const direction = align === 'left' ? 1 : -1;

    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.font = `800 18px ${FONT}`;
    ctx.fillText(id === 'p1' ? '1P' : '2P', x, 40);

    for (let i = 0; i < MATCH.roundsToWin; i += 1) {
      const pipX = x + direction * (i * 26 + 6);
      ctx.beginPath();
      ctx.arc(pipX, 72, 9, 0, Math.PI * 2);
      if (i < wins) {
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.26)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  /** 광고 노출 측정 상태를 눈으로 확인하기 위한 개발용 패널. */
  private drawAdMetrics(billboards: BillboardManager): void {
    const ctx = this.ctx;
    const slots = billboards.getSlots();
    const panelWidth = 310;
    const rowHeight = 22;
    const panelHeight = 44 + slots.length * rowHeight;
    const x = 20;
    const y = VIEW_HEIGHT - panelHeight - 62;

    ctx.fillStyle = 'rgba(6, 9, 18, 0.88)';
    ctx.fillRect(x, y, panelWidth, panelHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, panelWidth, panelHeight);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = `700 12px ${FONT}`;
    ctx.fillText('광고판 노출 (유효 impression = 누적 10초)', x + 12, y + 20);

    ctx.font = `500 11px ${FONT}`;
    slots.forEach((slot, index) => {
      const rowY = y + 42 + index * rowHeight;
      const progress = billboards.getImpressionProgress(slot);
      const done = slot.hasReportedImpression();

      ctx.fillStyle = UI_COLORS.textDim;
      ctx.fillText(slot.id, x + 12, rowY);

      const barX = x + 156;
      const barWidth = 100;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(barX, rowY - 4, barWidth, 8);
      ctx.fillStyle = done ? UI_COLORS.good : UI_COLORS.charge;
      ctx.fillRect(barX, rowY - 4, barWidth * progress, 8);

      ctx.fillStyle = done ? UI_COLORS.good : UI_COLORS.textDim;
      ctx.fillText(
        done ? 'OK' : `${(slot.getVisibleMs() / 1000).toFixed(1)}s`,
        barX + barWidth + 10,
        rowY,
      );
    });
  }
}

/** 관중 점 배치를 스테이지마다 한 번만 계산해둔다. */
function buildCrowd(
  topY: number,
  bottomY: number,
  palette: readonly string[],
): readonly CrowdDot[] {
  const dots: CrowdDot[] = [];
  const rows = Math.max(2, Math.floor((bottomY - topY) / 30));
  for (let row = 0; row < rows; row += 1) {
    const y = topY + 22 + row * 30;
    if (y > bottomY - 10) break;
    const offset = row % 2 === 0 ? 0 : 13;
    for (let x = 16 + offset; x < VIEW_WIDTH - 10; x += 26) {
      dots.push({
        x,
        y,
        color: palette[Math.floor(Math.random() * palette.length)] ?? '#2f3a63',
        phase: Math.random() * Math.PI * 2,
      });
    }
  }
  return dots;
}

/** 주어진 폭에 들어가도록 폰트 크기를 줄인다. */
function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
): number {
  let size = startSize;
  while (size > 9) {
    ctx.font = `800 ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  return size;
}

/** #rrggbb를 밝게. 본체 그라디언트의 하이라이트용. */
function lighten(hex: string): string {
  const value = hex.replace('#', '');
  const r = Math.min(255, parseInt(value.slice(0, 2), 16) + 70);
  const g = Math.min(255, parseInt(value.slice(2, 4), 16) + 70);
  const b = Math.min(255, parseInt(value.slice(4, 6), 16) + 70);
  return `rgb(${r}, ${g}, ${b})`;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}
