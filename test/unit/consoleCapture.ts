// 단위 시험 공용: console 출력을 가로채 글자로 모은다(시험 파일이 아니다 — vitest 는 *.test.ts 만 돈다).
// 문자열이 아닌 인자(객체·배열·Map·오류)는 util.inspect 로 속성 값까지 편다. String() 으로 바꾸면 객체는 '[object Object]' 가 되어
// `console.warn('실패', { loginId, password })` 처럼 객체로 찍은 비밀번호를 '로그에 없다' 검사가 보지 못한다.
import { inspect } from 'node:util';
import { vi } from 'vitest';

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

/** console 인자 한 벌 → 한 줄(문자열은 그대로, 그 밖은 inspect 로 끝까지 편 것) */
export function formatConsoleArgs(args: readonly unknown[]): string {
  return args
    .map((a) =>
      typeof a === 'string' ? a : inspect(a, { depth: 8, breakLength: Infinity, maxArrayLength: null, maxStringLength: null }),
    )
    .join(' ');
}

export interface ConsoleCapture {
  /** 찍힌 줄(찍힌 차례) */
  lines: string[];
  /** 모은 줄 전부(줄바꿈으로 이음) */
  text(): string;
  /** 가로채기를 푼다 */
  restore(): void;
}

/** console.log·info·warn·error·debug·trace 를 가로챈다(화면에는 찍지 않는다). 끝나면 restore 를 부른다 */
export function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  const spies = METHODS.map((k) =>
    vi.spyOn(console, k).mockImplementation((...args: unknown[]) => {
      lines.push(formatConsoleArgs(args));
    }),
  );
  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}
