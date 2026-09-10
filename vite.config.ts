import { defineConfig } from 'vite';

export default defineConfig({
  // 게임 포털(Poki/CrazyGames)은 상대 경로 기준으로 iframe 안에서 서빙하므로
  // base를 './'로 두어야 빌드 산출물이 어느 경로에 올라가도 동작한다.
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
});
