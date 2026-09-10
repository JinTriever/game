/** 키보드 입력. 눌림 상태와 "이번 프레임에 새로 눌림"을 함께 제공한다. */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (event) => {
      // 스페이스/화살표로 페이지가 스크롤되는 것을 막는다.
      if (SWALLOWED_KEYS.has(event.code)) {
        event.preventDefault();
      }
      if (event.repeat) return;
      this.down.add(event.code);
      this.pressed.add(event.code);
    });

    target.addEventListener('keyup', (event) => {
      this.down.delete(event.code);
    });

    // 탭을 벗어나면 키가 눌린 채로 남는 문제를 막는다.
    target.addEventListener('blur', () => {
      this.down.clear();
    });
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** 프레임 끝에서 호출. edge 상태를 비운다. */
  endFrame(): void {
    this.pressed.clear();
  }
}

const SWALLOWED_KEYS = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
