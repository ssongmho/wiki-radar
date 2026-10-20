// 설정 › 나(2.9단계 명세 §4-4): 내 이름·다른 표기 입력 칸의 상태와 미리보기. 순수 함수만.
// 이름 비교 규칙(normName)은 main 과 같은 src/shared/team.ts 를 쓴다.
import { ME_ALIASES_MAX, countMine, meNameProblem, myNames, splitAliases } from '../../shared/team';
import type { MeInfo, MeSettings, MeSource } from '../../shared/types';

/** 입력 칸 글자 그대로(다른 표기는 `,` 로 이은 한 줄) */
export interface MeDraft {
  name: string;
  aliases: string;
}

const SOURCES = new Set<MeSource>(['settings', 'voc', 'none']);

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** main 응답 검사. 모양이 틀리면 null */
export function normalizeMe(raw: unknown): MeInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const settings = r.settings as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== 'object' || !isStringArray(settings.aliases)) return null;
  if (settings.name !== undefined && typeof settings.name !== 'string') return null;
  if (!isStringArray(r.effective) || !SOURCES.has(r.source as MeSource)) return null;
  const out: MeInfo = { settings: { aliases: [...settings.aliases] }, effective: [...r.effective], source: r.source as MeSource };
  if (typeof settings.name === 'string' && settings.name !== '') out.settings.name = settings.name;
  if (typeof r.vocName === 'string' && r.vocName.trim() !== '') out.vocName = r.vocName.trim();
  return out;
}

/** 저장된 설정 → 입력 칸 */
export function meDraftOf(settings: MeSettings): MeDraft {
  return { name: settings.name ?? '', aliases: settings.aliases.join(', ') };
}

/** 입력 칸 → 저장할 설정(검사는 meDraftProblem) */
export function meSettingsOf(draft: MeDraft): MeSettings {
  const name = draft.name.trim();
  const out: MeSettings = { aliases: splitAliases(draft.aliases) };
  if (name !== '') out.name = name;
  return out;
}

/** 저장된 것과 다른가(앞뒤 공백·`,` 사이 공백은 보지 않는다) */
export function meDraftChanged(settings: MeSettings, draft: MeDraft): boolean {
  const next = meSettingsOf(draft);
  return (next.name ?? '') !== (settings.name ?? '') || next.aliases.join('\n') !== settings.aliases.join('\n');
}

/** 입력 문제(없으면 null) — main 의 checkMeSettings 와 같은 규칙 */
export function meDraftProblem(draft: MeDraft): string | null {
  const name = draft.name.trim();
  if (name !== '') {
    const problem = meNameProblem(name);
    if (problem && problem !== '빈 이름입니다') return `이름: ${problem}`;
  }
  const aliases = splitAliases(draft.aliases);
  for (const a of aliases) {
    const problem = meNameProblem(a);
    if (problem) return `다른 표기 「${a.slice(0, 20)}」: ${problem}`;
  }
  if (aliases.length > ME_ALIASES_MAX) return `다른 표기는 ${ME_ALIASES_MAX}개까지입니다`;
  return null;
}

/** 이름 칸 아래 VOC 로그인 이름 안내 */
export function vocNameNote(vocName: string | undefined): string {
  return vocName ? `VOC 로그인 이름: ${vocName}(비워 두면 이것)` : 'VOC 에 로그인하지 않아 기본 이름이 없습니다';
}

export interface MePreview {
  /** 팀 위키 동기화가 꺼져 있거나 팀 할 일을 아직 모르면 수 대신 이 문장 */
  note?: string;
  mine: number;
  total: number;
  /** 지금 입력으로 잡히는 나의 이름들 */
  names: string[];
}

/**
 * 미리보기: 입력하는 동안 팀 위키 할 일의 담당 목록으로 내 것을 센다.
 * teamOwners 는 열린 팀 할 일마다의 담당 목록(모르면 null), teamSyncOn 은 팀 동기화가 켜졌는가(모르면 null).
 */
export function mePreview(
  draft: MeDraft,
  vocName: string | undefined,
  teamOwners: readonly (readonly string[])[] | null,
  teamSyncOn: boolean | null,
): MePreview {
  const { names } = myNames(meSettingsOf(draft), vocName);
  if (teamSyncOn === false) return { note: '팀 위키 동기화가 꺼져 있습니다', mine: 0, total: 0, names };
  if (!teamOwners) return { note: '팀 위키 할 일을 아직 읽지 않았습니다', mine: 0, total: 0, names };
  return { mine: countMine(teamOwners, names), total: teamOwners.length, names };
}
