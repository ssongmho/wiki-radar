import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import fs from 'node:fs';
import path from 'node:path';

const config: ForgeConfig = {
  // out/ 의 앱을 띄워 둔 채로 빌드하면 폴더가 잠겨 실패한다 — 그때는 다른 폴더로 뺀다
  outDir: process.env.WIKI_RADAR_OUT_DIR || 'out',
  packagerConfig: {
    asar: true,
    name: 'wiki-radar',
    executableName: 'wiki-radar',
  },
  rebuildConfig: {},
  hooks: {
    // koffi(미리 빌드된 바이너리 — 알림 보류 감지, 명세 2.12 §4-3)를 resources/koffi 로 복사한다.
    // Vite 플러그인은 node_modules 를 넣지 않고 .node 는 번들할 수 없다. win32_x64 바이너리와 진입 파일만 넣는다.
    // 없으면 경고만 — 앱은 koffi 없이도 뜬다(감지만 꺼짐).
    packageAfterCopy: async (_cfg, buildPath) => {
      const src = path.join(__dirname, 'node_modules', 'koffi');
      const dest = path.join(path.dirname(buildPath), 'koffi');
      const parts = ['package.json', 'index.js', path.join('build', 'koffi', 'win32_x64', 'koffi.node')];
      if (!parts.every((p) => fs.existsSync(path.join(src, p)))) {
        console.warn('[forge] koffi 가 없어 resources/koffi 를 만들지 않습니다(알림 보류 감지 꺼짐)');
        return;
      }
      for (const p of parts) {
        fs.mkdirSync(path.dirname(path.join(dest, p)), { recursive: true });
        fs.copyFileSync(path.join(src, p), path.join(dest, p));
      }
    },
  },
  makers: [
    new MakerZIP({}, ['win32']),
    // 팀 배포용 설치 파일(사용자별 설치, 관리자 권한 없음). 결과물 RELEASES·*.nupkg·Setup.exe 를
    // 배포 서버(deploy/dist-server)에 올리면 앱의 자동 업데이트(src/main/updater.ts)가 받아 간다.
    new MakerSquirrel({
      name: 'wiki-radar',
      authors: 'ssongmho',
      description: '개인 위키의 할 일·지식을 옆에 띄워두고 보는 데스크톱 앱',
      setupExe: 'wiki-radar-Setup.exe',
      noMsi: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    // 패키징된 실행 파일에만 적용된다. 테스트(Playwright)는 패키징 전 빌드(.vite/)를 `electron .`로 띄운다.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
