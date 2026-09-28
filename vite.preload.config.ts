import { defineConfig } from 'vite';

// Forge Vite 플러그인의 기본 preload 설정(cjs·한 파일) 위에 덮는다.
// 진입점이 src/preload/index.ts 라 기본 이름은 index.js 가 되어 main 과 겹친다.
// main 이 path.join(__dirname, 'preload.js') 로 찾으므로 preload.js 로 낸다.
// sandbox 프리로드라 electron 말고는 require 할 수 없다 — 공유 상수(src/shared)는 번들에 들어간다.
// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'preload.js',
      },
    },
  },
});
