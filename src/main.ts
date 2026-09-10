import './style.css';
import { MockAdProvider } from './ads/MockAdProvider';
import { Game } from './game/Game';

const canvas = document.getElementById('stage');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#stage 캔버스를 찾을 수 없습니다.');
}

// 광고 구현체는 여기서만 결정된다.
// 배급 시점에 포털 SDK 구현체로 교체하면 게임 코드는 그대로 유지된다.
const ads = new MockAdProvider();
const game = new Game(canvas, ads);

void game.start();
