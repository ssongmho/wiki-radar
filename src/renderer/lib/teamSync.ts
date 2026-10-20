// 팀 위키 동기화(2.8단계 명세 docs/stage2.8-contract.md): main 이 준 상태를 검사하고 화면 문장으로 바꾼다. 순수 함수만.
import type { TeamSyncChange, TeamSyncStatus } from '../../shared/types';

const PHASES = new Set(['off', 'idle', 'running', 'paused', 'error']);
const DIRS = new Set(['in', 'out', 'conflict', 'deletedIn', 'deletedOut']);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const str = (v: unknown): v is string => typeof v === 'string';
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : []);

/** main 응답 검사. 모양이 틀리면 null */
export function normalizeTeamSync(raw: unknown): TeamSyncStatus | null {
  if (!isObject(raw)) return null;
  if (typeof raw.enabled !== 'boolean' || !str(raw.remote) || !str(raw.local) || !PHASES.has(raw.phase as string)) return null;
  const out: TeamSyncStatus = {
    enabled: raw.enabled,
    remote: raw.remote,
    local: raw.local,
    phase: raw.phase as TeamSyncStatus['phase'],
    recent: [],
  };
  if (str(raw.lastRunAt)) out.lastRunAt = raw.lastRunAt;
  if (str(raw.lastOkAt)) out.lastOkAt = raw.lastOkAt;
  if (str(raw.message) && raw.message) out.message = raw.message;
  if (isObject(raw.last)) {
    const l = raw.last;
    out.last = {
      pulled: typeof l.pulled === 'number' ? l.pulled : 0,
      pushed: typeof l.pushed === 'number' ? l.pushed : 0,
      deleted: typeof l.deleted === 'number' ? l.deleted : 0,
      conflicts: strList(l.conflicts),
      skipped: Array.isArray(l.skipped)
        ? l.skipped.filter((s): s is { rel: string; reason: string } => isObject(s) && str(s.rel) && str(s.reason))
        : [],
    };
  }
  if (isObject(raw.pending)) {
    const p = raw.pending;
    out.pending = {
      deletes: typeof p.deletes === 'number' ? p.deletes : 0,
      overwrites: typeof p.overwrites === 'number' ? p.overwrites : 0,
      sample: strList(p.sample),
    };
  }
  if (Array.isArray(raw.recent)) {
    out.recent = raw.recent.filter(
      (c): c is TeamSyncChange => isObject(c) && str(c.rel) && str(c.at) && DIRS.has(c.dir as string),
    );
  }
  return out;
}

/** "방금" · "3분 전" · "2시간 전" · "10-12 15:30" */
export function agoText(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor((now.getTime() - t) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 전`;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type TeamSyncTone = 'ok' | 'off' | 'warn' | 'wait';

export interface TeamSyncSummary {
  tone: TeamSyncTone;
  /** 짧은 상태 글자 */
  state: string;
  /** 무엇을 봤는지·어떻게 하는지 */
  detail: string;
}

/** 설정 › 점검 줄의 상태 */
export function teamSyncSummary(s: TeamSyncStatus, now: Date): TeamSyncSummary {
  const when = agoText(s.lastOkAt, now);
  switch (s.phase) {
    case 'off':
      return {
        tone: 'off',
        state: '꺼짐',
        detail: '켜면 NAS 팀 위키를 내 PC 폴더로 받아 오고, 내가 고친 것은 NAS 로 올립니다. 그 폴더를 Obsidian 으로 엽니다.',
      };
    case 'running':
      return { tone: 'wait', state: '동기화 중', detail: when ? `마지막 동기화 ${when}` : '처음 동기화 중입니다 — 문서가 많으면 잠시 걸립니다.' };
    case 'paused':
      return {
        tone: 'warn',
        state: '확인 필요',
        detail: s.message ?? '한 번에 많이 지우거나 덮어쓰게 되어 멈췄습니다.',
      };
    case 'error':
      return {
        tone: 'warn',
        state: '오류',
        detail: `${s.message ?? '동기화하지 못했습니다.'}${when ? ` · 마지막 성공 ${when}` : ''}`,
      };
    default: {
      const conflicts = s.last?.conflicts.length ?? 0;
      if (conflicts > 0) {
        return { tone: 'warn', state: `충돌 ${conflicts}건`, detail: '같은 문서를 동시에 고쳐 충돌 사본을 남겼습니다 — 열어서 합친 뒤 사본을 지우세요.' };
      }
      return { tone: 'ok', state: '켜짐', detail: when ? `마지막 동기화 ${when} · 저장하면 몇 초 뒤, 그 밖에는 5분마다 맞춥니다.` : '곧 동기화합니다.' };
    }
  }
}

const DIR_TEXT: Record<TeamSyncChange['dir'], string> = {
  in: '받음',
  out: '올림',
  conflict: '충돌 사본',
  deletedIn: '휴지통(내 PC)',
  deletedOut: '휴지통(NAS)',
};

export function changeText(dir: TeamSyncChange['dir']): string {
  return DIR_TEXT[dir];
}

/** 사이드바 칸: 꺼져 있으면 없음. attention 이면 눈에 띄게 */
export function teamSyncBadge(s: TeamSyncStatus | null): { label: string; attention: boolean } | null {
  if (!s || !s.enabled) return null;
  if (s.phase === 'paused') return { label: '확인', attention: true };
  if (s.phase === 'error') return { label: '오류', attention: true };
  const conflicts = s.last?.conflicts.length ?? 0;
  if (conflicts > 0) return { label: `충돌 ${conflicts}`, attention: true };
  if (s.phase === 'running') return { label: '맞추는 중', attention: false };
  return { label: '켜짐', attention: false };
}
