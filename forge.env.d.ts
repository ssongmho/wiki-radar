/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

/** package.json 의 version. vite.renderer.config.ts 의 define 이 빌드 때 채운다(화면 코드에서만 쓴다) */
declare const __APP_VERSION__: string;
