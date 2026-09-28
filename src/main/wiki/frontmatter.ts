// 마크다운 frontmatter(--- … ---) 분리·파싱. yaml 패키지를 쓴다.
import { parse as parseYaml } from 'yaml';

export interface FrontmatterResult {
  /** frontmatter 를 객체로 읽은 것. 없거나 깨졌으면 null */
  data: Record<string, unknown> | null;
  /** frontmatter 가 있었는가(깨졌어도 true) */
  present: boolean;
  /** YAML 오류 문구(있으면) */
  error?: string;
  /** frontmatter 다음 줄부터의 줄 목록 */
  bodyLines: string[];
  /** bodyLines[0] 이 원문에서 몇 번째 줄(0부터)인가 */
  bodyStart: number;
}

/** lines 는 BOM 을 뗀 뒤 줄로 나눈 원문. 첫 줄이 '---' 일 때만 frontmatter 로 본다. */
export function splitFrontmatter(lines: string[]): FrontmatterResult {
  if (lines.length === 0 || lines[0].trimEnd() !== '---') {
    return { data: null, present: false, bodyLines: lines, bodyStart: 0 };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (t === '---' || t === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    // 닫는 줄이 없으면 frontmatter 가 아니다.
    return { data: null, present: false, bodyLines: lines, bodyStart: 0 };
  }
  const yamlText = lines.slice(1, end).join('\n');
  const bodyLines = lines.slice(end + 1);
  try {
    const parsed: unknown = parseYaml(yamlText);
    const data =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    return { data, present: true, bodyLines, bodyStart: end + 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, present: true, error: message, bodyLines, bodyStart: end + 1 };
  }
}

/** frontmatter 값 하나를 문자열로. 문자열·숫자·불리언·날짜만 받는다. */
export function scalarToString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return undefined;
}
