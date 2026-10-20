// 팀 위키 담당·"나" 이름(2.9단계 명세 §3·§4-4·§9) — main 과 renderer 가 같이 쓰는 규칙. 순수 상수·함수만 둔다.
import type { MeInfo, MeSettings, MeSource } from './types';

/** 이름·다른 표기 하나의 최대 길이(앞뒤 공백을 뗀 뒤) */
export const ME_NAME_MAX = 50;
/** 다른 표기 최대 개수 */
export const ME_ALIASES_MAX = 10;

/** 이름 비교용: NFC → 소문자 → 모든 공백 제거 */
export function normName(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/gu, '');
}

/**
 * `owner` 필드 값 → 담당 목록. `,` 로 나눈 뒤 각각 앞뒤 공백을 떼고 `[[문서|별칭]]`→별칭, `[[문서]]`→문서, 앞의 `@` 를 뗀다.
 * 빈 조각은 버린다(없으면 미배정).
 */
export function ownersOf(value: string | undefined | null): string[] {
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  for (const piece of value.split(',')) {
    let s = piece.trim();
    const link = /^\[\[([^\]|]*)(?:\|([^\]]*))?\]\]$/.exec(s);
    if (link) s = (link[2] ?? link[1]).trim();
    s = s.replace(/^@+/, '').trim();
    if (s !== '') out.push(s);
  }
  return out;
}

/** 이름·표기 하나의 문제(없으면 null). 앞뒤 공백은 뗀 값으로 본다 */
export function meNameProblem(value: string): string | null {
  const s = value.trim();
  if (s === '') return '빈 이름입니다';
  if (s.length > ME_NAME_MAX) return `이름은 ${ME_NAME_MAX}자까지입니다`;
  // eslint-disable-next-line no-control-regex
  if (/[[\],\u0000-\u001f\u007f]/.test(s)) return '이름에 [ ] , 나 줄바꿈을 쓸 수 없습니다';
  return null;
}

/** 다른 표기 입력 글자 → 목록(`,` 로 나누고 앞뒤 공백을 뗌, 빈 조각은 버림). 검사는 하지 않는다 */
export function splitAliases(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * 나의 이름들: 설정 이름(없으면 VOC 로그인 이름) + 다른 표기. 같은 normName 은 하나로.
 * source 는 첫 이름이 어디서 왔는지(설정 · VOC · 없음).
 */
export function myNames(settings: MeSettings | undefined, vocName?: string): { names: string[]; source: MeSource } {
  const own = settings?.name?.trim() ?? '';
  const voc = vocName?.trim() ?? '';
  const first = own || voc;
  const source: MeSource = own ? 'settings' : voc ? 'voc' : 'none';
  const names: string[] = [];
  const seen = new Set<string>();
  for (const n of [first, ...(settings?.aliases ?? [])]) {
    const t = n.trim();
    const key = normName(t);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    names.push(t);
  }
  return { names, source };
}

/** 설정 + VOC 이름 → getMe 결과 */
export function meInfoOf(settings: MeSettings | undefined, vocName?: string): MeInfo {
  const { names, source } = myNames(settings, vocName);
  const out: MeInfo = {
    settings: { aliases: [...(settings?.aliases ?? [])] },
    effective: names,
    source,
  };
  if (settings?.name) out.settings.name = settings.name;
  const voc = vocName?.trim();
  if (voc) out.vocName = voc;
  return out;
}

/** 담당 중 하나라도 나의 이름들에 걸리는가 */
export function isMine(owners: readonly string[], names: readonly string[]): boolean {
  if (owners.length === 0 || names.length === 0) return false;
  const mine = new Set(names.map(normName).filter((n) => n !== ''));
  return owners.some((o) => mine.has(normName(o)));
}

/** 담당 목록들 중 내 것의 수(설정 › 나 미리보기) */
export function countMine(ownerLists: readonly (readonly string[])[], names: readonly string[]): number {
  return ownerLists.filter((owners) => isMine(owners, names)).length;
}
