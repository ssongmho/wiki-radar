import { defineConfig } from 'vite';

// Forge Vite 플러그인이 기본 설정(lib·cjs·external=Node 내장+electron)을 만들고 이 파일을 그 위에 덮는다.
// - 진입점이 src/main/index.ts 라 기본 이름은 index.js 가 되어 preload(index.js)와 겹친다.
//   package.json "main"(.vite/build/main.js)에 맞춰 main.js 로 낸다.
// - chokidar·yaml 을 external 로 빼지 않는다. Forge Vite 플러그인은 node_modules 를 패키지에 넣지 않으므로
//   번들 안에 들어가야 패키징한 앱이 뜬다.
// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
      },
    },
  },
});
