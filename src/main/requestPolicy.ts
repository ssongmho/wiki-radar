// 아웃바운드 0 정책: 화면·브라우저 프로세스가 내는 요청 중 허용할 것을 가른다.
// electron 을 import 하지 않는 순수 모듈이다(vitest 로 시험). 실제 걸기는 security.ts 가 한다.
// 계약: DESIGN.md §5 "CSP로 외부 스크립트와 원격 리소스를 막는다", "외부로 보내는 것은 claude -p 프롬프트뿐".
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RequestPolicyOptions {
  /** 앱 파일이 있는 폴더(app.getAppPath()). file: 요청은 이 안의 파일만 허용한다 */
  appPath: string;
  /** 개발 서버 주소(npm start). 배포 빌드에서는 null — http/ws 는 전부 막힌다 */
  devServerUrl: string | null;
}

/** 네트워크를 타지 않는 브라우저 내부 스킴. 화면이 쓰는 data:(작은 자산)·blob: 과 개발자 도구를 포함한다 */
const INTERNAL_SCHEMES = new Set(['data:', 'blob:', 'about:', 'devtools:', 'chrome-extension:']);

function normalizeDir(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export interface RequestPolicy {
  /** 이 URL 로 나가는 요청을 허용하는가 */
  isAllowed(url: string): boolean;
}

export function createRequestPolicy(opts: RequestPolicyOptions): RequestPolicy {
  const appDir = normalizeDir(opts.appPath);
  let devHost: string | null = null;
  if (opts.devServerUrl) {
    try {
      devHost = new URL(opts.devServerUrl).host.toLowerCase();
    } catch {
      devHost = null;
    }
  }

  function isInsideApp(fileUrl: URL): boolean {
    let abs: string;
    try {
      abs = fileURLToPath(fileUrl);
    } catch {
      return false;
    }
    const key = path.resolve(abs).replace(/\\/g, '/').toLowerCase();
    return key.startsWith(appDir + '/');
  }

  return {
    isAllowed(url: string): boolean {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return false;
      }
      if (INTERNAL_SCHEMES.has(u.protocol)) return true;
      if (u.protocol === 'file:') return isInsideApp(u);
      // 개발 서버(HMR 웹소켓 포함)만 예외. 배포 빌드에는 devHost 가 없어 여기서 전부 막힌다.
      if (devHost && (u.protocol === 'http:' || u.protocol === 'ws:' || u.protocol === 'https:' || u.protocol === 'wss:')) {
        return u.host.toLowerCase() === devHost;
      }
      return false;
    },
  };
}
