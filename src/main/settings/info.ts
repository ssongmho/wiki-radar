// 정보 칸(2.13단계 명세 §C-6): 진단 정보 글·가져오기 미리보기 토큰. electron 을 import 하지 않는 순수 모듈이다.
//
// 진단 정보: 버전·OS·데이터 폴더·위키 출처(경로)·팀 기본값 출처·칸마다 필드 출처(값은 서버·포트·주소만 — 아이디는 h***@도메인 으로 가림)·
// 비밀은 "저장됨/없음"만·점검 줄 상태·최근 경고 20줄. 메일 본문·할 일 제목은 넣지 않는다. 마지막에 알려진 비밀을 한 번 더 가린다.
import { randomBytes } from 'node:crypto';
import type { AppInfo, FieldView, SettingsSectionView, SetupLine } from '../../shared/types';
import { redactSecrets } from '../mail/account';
import { sourceLabel } from './resolve';
import type { ParsedImport } from './export';

/** 'hong@example.com' → 'h***@example.com', 'hong' → 'h***' */
export function maskId(id: string): string {
  if (typeof id !== 'string' || id === '') return '';
  const at = id.indexOf('@');
  const head = at > 0 ? id.slice(0, at) : id;
  return `${head.slice(0, 1)}***${at > 0 ? id.slice(at) : ''}`;
}

/** 진단에 값을 그대로 보여도 되는 필드(서버·포트·주소·보안 같은 것) */
const VALUE_FIELDS: ReadonlySet<string> = new Set([
  'host',
  'port',
  'ssl',
  'security',
  'sameAccount',
  'intervalMinutes',
  'enabled',
  'llmUrl',
  'apiFormat',
  'model',
  'draftEngine',
  'updateUrl',
  'wikiMode',
  'teamEnabled',
]);

function fieldLine(name: string, f: FieldView): string {
  let value: string;
  if (f.value === null || f.value === undefined) value = '(없음)';
  else if (name === 'user') value = maskId(String(f.value));
  else if (VALUE_FIELDS.has(name)) value = String(f.value);
  else value = '(값 생략)';
  return `  ${name}: ${value} [${sourceLabel(f.source)}${f.envName ? ` ${f.envName}` : ''}]${f.problem ? ` 문제: ${f.problem}` : ''}`;
}

export interface DiagnosticsInput {
  info: AppInfo;
  wiki: { path: string; source: string };
  sections: SettingsSectionView[];
  setup: Record<string, SetupLine | { ok: boolean; problem?: string } | undefined>;
  recentWarnings: string[];
  secrets: readonly string[];
}

export function buildDiagnostics(d: DiagnosticsInput): string {
  const lines: string[] = [];
  lines.push('Radar 진단 정보');
  lines.push(`버전: ${d.info.version} (${d.info.install}) · Electron ${d.info.electron} · Chrome ${d.info.chrome} · Node ${d.info.node}`);
  lines.push(`OS: ${d.info.os}`);
  lines.push(`데이터 폴더: ${d.info.dataDir}`);
  lines.push(`로그 폴더: ${d.info.logsDir}`);
  lines.push(`개인 위키: ${d.wiki.source === 'none' ? '(없음)' : d.wiki.path} [${d.wiki.source}]`);
  const t = d.info.teamDefaults;
  lines.push(`팀 기본값: ${t.source}${t.path ? ` · ${t.path}` : ''}${t.readAt ? ` · ${t.readAt}` : ''}${t.problems.length ? ` · 문제 ${t.problems.join(' / ')}` : ''}`);
  lines.push(`업데이트 서버: ${d.info.update.value ?? '(없음)'} [${sourceLabel(d.info.update.source)}]`);
  for (const s of d.sections) {
    lines.push('');
    lines.push(`[${s.section}]`);
    for (const [name, f] of Object.entries(s.fields)) {
      if (name === 'fromName' || name === 'signature' || name === 'bccSelf' || name === 'wikiRoot' || name === 'teamRemote' || name === 'teamLocal') {
        lines.push(`  ${name}: (값 생략) [${sourceLabel(f.source)}]`);
        continue;
      }
      lines.push(fieldLine(name, f));
    }
    for (const [key, v] of Object.entries(s.secrets)) {
      if (!v) continue;
      lines.push(`  ${key}: ${v.saved ? '저장됨' : '없음'} · 쓰는 것 ${v.source}${v.storage ? ` · ${v.storage === 'file' ? '암호화 파일' : '메모리'}` : ''}`);
    }
  }
  lines.push('');
  lines.push('[점검]');
  for (const [key, line] of Object.entries(d.setup)) {
    if (!line) continue;
    if ('state' in line) lines.push(`  ${key}: ${line.state} — ${line.text}`);
    else lines.push(`  ${key}: ${line.ok ? 'ok' : 'off'}${line.problem ? ` — ${line.problem}` : ''}`);
  }
  lines.push('');
  lines.push('[최근 경고]');
  const warnings = d.recentWarnings.slice(-20);
  if (warnings.length === 0) lines.push('  (없음)');
  for (const w of warnings) lines.push(`  ${w}`);
  return redactSecrets(lines.join('\n'), d.secrets);
}

/** 가져오기 미리보기 토큰(main 메모리 10분) */
export class ImportTokens {
  private readonly tokens = new Map<string, { expires: number; data: ParsedImport }>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  put(data: ParsedImport): string {
    this.sweep();
    const token = `imp_${randomBytes(12).toString('hex')}`;
    this.tokens.set(token, { expires: this.clock() + this.ttlMs, data });
    return token;
  }

  /** 토큰 모양·만료 검사 후 꺼낸다(한 번만) */
  take(token: unknown): ParsedImport {
    if (typeof token !== 'string' || !/^imp_[0-9a-f]{24}$/.test(token)) throw new Error('잘못된 요청입니다: 가져오기 토큰');
    this.sweep();
    const e = this.tokens.get(token);
    if (!e) throw new Error('가져오기 미리보기가 만료되었습니다 — 파일을 다시 고르세요');
    this.tokens.delete(token);
    return e.data;
  }

  private sweep(): void {
    const now = this.clock();
    for (const [k, v] of this.tokens) if (v.expires < now) this.tokens.delete(k);
  }
}
