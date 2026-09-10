/**
 * 모바일 화면 조작.
 *
 * 캔버스에 직접 그려서 좌표로 히트 테스트하는 방법도 있지만, 실제 DOM 버튼을
 * 쓰면 레터박스로 스케일된 캔버스와 좌표를 맞출 필요가 없고 접근성 속성을
 * 그대로 쓸 수 있다. 그래서 오버레이 DOM으로 만든다.
 *
 * 조작 규칙은 키보드와 동일하게 맞춘다.
 *  - 대시 버튼을 누르고 있으면 차지, 떼면 발사
 *  - 차지 중에 점프 버튼을 함께 누르면 위쪽 대각 조준 (키보드에서 W와 같은 역할)
 */
export class TouchControls {
  private readonly root: HTMLElement;
  private readonly hint: HTMLElement | null;
  private readonly continueButton: HTMLElement | null;
  private readonly motionButton: HTMLElement | null;
  private readonly rotateHint: HTMLElement | null;

  private left = false;
  private right = false;
  private jumpHeld = false;
  private charge = false;

  /** edge 입력. 물리 스텝이 소비할 때까지 유지된다. */
  private jumpQueued = false;
  private startQueued = false;
  private continueQueued = false;
  private motionToggleQueued = false;

  private enabled = false;

  constructor() {
    const root = document.getElementById('touch-controls');
    if (!root) {
      throw new Error('#touch-controls 요소를 찾을 수 없습니다.');
    }
    this.root = root;
    this.hint = document.getElementById('touch-hint');
    this.continueButton = document.getElementById('touch-continue');
    this.motionButton = document.getElementById('touch-motion');
    this.rotateHint = document.getElementById('rotate-hint');
    this.prepareRotateHint();

    this.bindHoldButton('touch-left', (down) => {
      this.left = down;
    });
    this.bindHoldButton('touch-right', (down) => {
      this.right = down;
    });
    this.bindHoldButton('touch-jump', (down) => {
      this.jumpHeld = down;
      // 차지 중이 아닐 때 누른 것만 점프로 큐에 넣는다.
      // 차지 중이라면 위쪽 조준 역할이므로 점프가 나가면 안 된다.
      if (down && !this.charge) {
        this.jumpQueued = true;
      }
    });
    this.bindHoldButton('touch-dash', (down) => {
      this.charge = down;
      if (down) {
        // 대시를 시작하는 순간 대기 중인 점프는 버린다.
        this.jumpQueued = false;
      }
    });

    this.bindTapButton('touch-start', () => {
      this.startQueued = true;
    });
    this.bindTapButton('touch-continue', () => {
      this.continueQueued = true;
    });
    this.bindTapButton('touch-motion', () => {
      this.motionToggleQueued = true;
    });

    // 앱 전환이나 탭 이동으로 pointerup을 못 받으면 버튼이 눌린 채로 남는다.
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }

  /** 터치 기기에서만 노출한다. 데스크톱에서는 화면을 가리지 않아야 한다. */
  autoEnable(): void {
    const coarsePointer =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.setEnabled(coarsePointer || hasTouch);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.hidden = !enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 매치 종료 화면에서만 '광고 보고 이어하기' 버튼을 띄운다. */
  setContinueVisible(visible: boolean): void {
    if (!this.continueButton) return;
    this.continueButton.hidden = !visible;
  }

  /** 화면 하단 안내 문구. 상황에 따라 바뀐다. */
  setHint(text: string): void {
    if (!this.hint) return;
    if (this.hint.textContent !== text) {
      this.hint.textContent = text;
    }
  }

  getMoveX(): number {
    return (this.left ? -1 : 0) + (this.right ? 1 : 0);
  }

  isCharging(): boolean {
    return this.charge;
  }

  /** 차지 중 점프 버튼을 함께 누르고 있으면 위쪽 조준. */
  isAimingUp(): boolean {
    return this.charge && this.jumpHeld;
  }

  consumeJump(): boolean {
    if (!this.jumpQueued) return false;
    this.jumpQueued = false;
    return true;
  }

  consumeStart(): boolean {
    if (!this.startQueued) return false;
    this.startQueued = false;
    return true;
  }

  consumeContinue(): boolean {
    if (!this.continueQueued) return false;
    this.continueQueued = false;
    return true;
  }

  consumeMotionToggle(): boolean {
    if (!this.motionToggleQueued) return false;
    this.motionToggleQueued = false;
    return true;
  }

  /**
   * 세로 화면 안내를 영구히 감춘다.
   * 게임을 시작했다면 안내는 이미 읽힌 것이므로 계속 띄울 이유가 없다.
   * CSS 미디어 쿼리가 display를 켜기 때문에 클래스로 눌러야 한다.
   */
  dismissRotateHint(): void {
    this.rotateHint?.classList.add('is-dismissed');
  }

  /**
   * 가로 고정 버튼 준비.
   *
   * 회전 잠금은 전체화면 상태에서만 동작하고, iOS Safari는 전체화면 API와
   * 회전 잠금을 아예 지원하지 않는다. 그래서 지원 여부를 먼저 확인해서
   * 안 되는 기기에서는 버튼을 숨긴다. 눌러도 아무 일 없는 버튼이
   * 남아있는 것보다 없는 게 낫다.
   */
  private prepareRotateHint(): void {
    const button = document.getElementById('rotate-lock');
    if (!button || !this.rotateHint) return;

    if (!supportsOrientationLock()) {
      this.rotateHint.classList.add('no-lock');
      return;
    }

    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      void this.lockLandscape();
    });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  private async lockLandscape(): Promise<void> {
    const root = document.documentElement;
    try {
      if (!document.fullscreenElement) {
        await root.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch {
      // 전체화면이 거부되면 회전 잠금도 실패한다. 안내만 남기고 넘어간다.
      return;
    }

    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (mode: string) => Promise<void>;
      };
      await orientation.lock?.('landscape');
      this.dismissRotateHint();
    } catch {
      // 잠금 실패. 전체화면은 됐으니 그대로 둔다.
    }
  }

  /** 연출 줄이기 버튼의 현재 상태를 문구로 반영한다. */
  setMotionReduced(reduced: boolean): void {
    if (!this.motionButton) return;
    const label = reduced ? '연출 최소' : '연출 기본';
    if (this.motionButton.textContent !== label) {
      this.motionButton.textContent = label;
    }
  }

  /** 버튼에서 손이 떠난 상태로 남는 것을 막는다(앱 전환 등). */
  releaseAll(): void {
    this.left = false;
    this.right = false;
    this.jumpHeld = false;
    this.charge = false;
    for (const id of ['touch-left', 'touch-right', 'touch-jump', 'touch-dash']) {
      document.getElementById(id)?.classList.remove('is-active');
    }
  }

  private bindHoldButton(id: string, onChange: (down: boolean) => void): void {
    const element = document.getElementById(id);
    if (!element) return;

    const press = (event: Event) => {
      event.preventDefault();
      element.classList.add('is-active');
      onChange(true);
    };
    const release = (event: Event) => {
      event.preventDefault();
      element.classList.remove('is-active');
      onChange(false);
    };

    // pointer 이벤트로 통일하면 터치/펜/마우스를 한 번에 처리할 수 있다.
    element.addEventListener('pointerdown', press);
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    // 버튼 밖으로 손가락이 미끄러져 나가도 눌린 상태로 남지 않게 한다.
    element.addEventListener('pointerleave', release);
    element.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  private bindTapButton(id: string, onTap: () => void): void {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      onTap();
    });
    element.addEventListener('contextmenu', (event) => event.preventDefault());
  }
}

/**
 * 회전 잠금 지원 여부.
 * 전체화면 API와 ScreenOrientation.lock이 모두 있어야 의미가 있다.
 * iOS Safari는 둘 다 없어서 여기서 false가 된다.
 */
function supportsOrientationLock(): boolean {
  try {
    const hasFullscreen = typeof document.documentElement.requestFullscreen === 'function';
    const orientation = screen.orientation as (ScreenOrientation & { lock?: unknown }) | undefined;
    const hasLock = typeof orientation?.lock === 'function';
    return hasFullscreen && hasLock;
  } catch {
    return false;
  }
}
