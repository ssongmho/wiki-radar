import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// 배포 빌드에만 엄격한 CSP를 심는다. 개발 서버는 React Refresh가 인라인 스크립트를 쓰므로
// 같은 정책을 걸면 화면이 뜨지 않는다(개발용 정책은 index.html에 있다).
// 화면은 네트워크·iframe·worker 를 쓰지 않는다(파일은 IPC 로만 받는다). file: 문서에서 'self' 는 모든 file: URL 에
// 맞으므로 connect-src 'self' 는 디스크의 아무 파일이나 fetch 하게 둔다 — 'none' 으로 닫는다.
// (main 의 webRequest 가드가 앱 폴더 밖 file: 요청을 한 번 더 막는다: src/main/security.ts)
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // frame-ancestors 는 <meta> CSP 에서 무시되고 콘솔 오류만 남긴다(응답 헤더로만 유효). 넣지 않는다.
].join('; ');

function prodCsp(): Plugin {
  return {
    name: 'wiki-radar-prod-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        `<meta http-equiv="Content-Security-Policy" content="${PROD_CSP}">`,
      );
    },
  };
}

// @fontsource CSS 는 `src: url(….woff2) format('woff2'), url(….woff) format('woff')` 로 두 형식을 적는다.
// Electron(Chromium)은 늘 woff2 를 쓰므로 woff 대체 파일(약 4MB)은 번들에 넣지 않는다.
// vite:css 가 url() 을 풀기 전에 떼야 하므로 enforce: 'pre'.
const WOFF_FALLBACK_RE = /,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g;

function woff2Only(): Plugin {
  return {
    name: 'wiki-radar-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@fontsource[\\/][^?]+\.css(\?|$)/.test(id)) return null;
      return { code: code.replace(WOFF_FALLBACK_RE, ''), map: null };
    },
  };
}

// 개발 서버 포트. Vite 기본값(5173)은 이 PC 의 다른 Vite 프로젝트도 쓴다. Windows 에서는 그쪽이 0.0.0.0/[::] 로
// 듣고 있어도 우리 서버가 localhost 에 겹쳐 떠 버려(포트 충돌로 잡히지 않는다) 어느 앱이 응답할지 알 수 없다.
// 개발 창에는 window.radar 가 붙으므로 남의 페이지가 뜨면 안 된다 — 전용 포트를 쓰고, 이미 쓰이면 다른 포트로 옮기지 않고 멈춘다.
const DEV_PORT = 5873;

export default defineConfig({
  plugins: [woff2Only(), react(), prodCsp()],
  // 화면에 보이는 앱 버전(제목 막대·사이드바). 자동 업데이트로 바뀐 버전을 눈으로 확인하는 데 쓴다.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: DEV_PORT, strictPort: true },
});
