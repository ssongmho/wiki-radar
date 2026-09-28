// 아웃바운드 0 정책(src/main/requestPolicy.ts) — main 의 webRequest 가드가 쓰는 판정
import { describe, expect, it } from 'vitest';
import { createRequestPolicy } from '../../src/main/requestPolicy';

const APP = 'C:\\Work\\wiki-radar';

describe('배포 빌드(개발 서버 없음)', () => {
  const p = createRequestPolicy({ appPath: APP, devServerUrl: null });

  it('앱 폴더 안의 file: 만 허용한다', () => {
    expect(p.isAllowed('file:///C:/Work/wiki-radar/.vite/renderer/main_window/index.html?mode=sidebar')).toBe(true);
    expect(p.isAllowed('file:///C:/Work/wiki-radar/.vite/renderer/main_window/assets/a.woff2')).toBe(true);
    expect(p.isAllowed('file:///c:/work/WIKI-RADAR/.vite/x.js')).toBe(true); // Windows 는 대소문자를 가리지 않는다
    expect(p.isAllowed('file:///C:/Work/wiki-radar-2/x.js')).toBe(false); // 이름만 비슷한 이웃 폴더
    expect(p.isAllowed('file:///C:/Work/wiki-radar')).toBe(false); // 폴더 자신
    expect(p.isAllowed('file:///C:/Windows/win.ini')).toBe(false);
    expect(p.isAllowed('file:///C:/Windows/System32/drivers/etc/hosts')).toBe(false);
    expect(p.isAllowed('file:///C:/Users/someone/OneDrive/Obsidian/WIKI/_private/mgmt/%EB%82%B4%20%ED%95%A0%20%EC%9D%BC.md')).toBe(false);
    expect(p.isAllowed('file:///C:/Work/wiki-radar/../secret.txt')).toBe(false);
  });

  it('패키징된 앱(app.asar)도 앱 폴더 안으로 본다', () => {
    const q = createRequestPolicy({ appPath: 'C:\\Program Files\\wiki-radar\\resources\\app.asar', devServerUrl: null });
    expect(q.isAllowed('file:///C:/Program%20Files/wiki-radar/resources/app.asar/.vite/renderer/main_window/index.html')).toBe(true);
    expect(q.isAllowed('file:///C:/Program%20Files/wiki-radar/resources/other.txt')).toBe(false);
  });

  it('네트워크는 전부 막는다(사전 CDN 포함)', () => {
    for (const url of [
      'https://redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic',
      'http://localhost:5873/',
      'ws://localhost:5873/',
      'https://example.com/',
      'ftp://x/y',
    ]) {
      expect(p.isAllowed(url), url).toBe(false);
    }
  });

  it('브라우저 내부 스킴은 허용한다', () => {
    expect(p.isAllowed('data:image/png;base64,AAAA')).toBe(true);
    expect(p.isAllowed('blob:file:///abc-def')).toBe(true);
    expect(p.isAllowed('about:blank')).toBe(true);
    expect(p.isAllowed('devtools://devtools/bundled/devtools_app.html')).toBe(true);
  });

  it('URL 이 아니면 막는다', () => {
    expect(p.isAllowed('')).toBe(false);
    expect(p.isAllowed('not a url')).toBe(false);
  });
});

describe('개발 실행(개발 서버 있음)', () => {
  const p = createRequestPolicy({ appPath: APP, devServerUrl: 'http://localhost:5873' });

  it('개발 서버(HMR 웹소켓 포함)만 예외', () => {
    expect(p.isAllowed('http://localhost:5873/src/renderer/main.tsx')).toBe(true);
    expect(p.isAllowed('ws://localhost:5873/?token=x')).toBe(true);
    expect(p.isAllowed('http://localhost:5173/')).toBe(false); // 다른 Vite 프로젝트 포트
    expect(p.isAllowed('http://localhost:5873.evil.com/')).toBe(false);
    expect(p.isAllowed('https://example.com/')).toBe(false);
    expect(p.isAllowed('file:///C:/Windows/win.ini')).toBe(false);
  });
});
