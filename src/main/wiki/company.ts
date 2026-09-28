// 할 일의 업체·조직 이름 결정 (명세 §1-5).
import type { LinkMappings } from './mappings';

const ENTITY_FILE_RE = /^wiki\/entities\/([^/]+)\.md$/;
const MAIL_FOLDER_RE = /^raw\/mail\/([^/]+)\//;
const SRC_MAIL_FOLDER_RE = /raw\/mail\/([^/]+)\//;

/** `wiki/entities/<X>.md` → X, 아니면 null */
export function entityNameOf(relPath: string): string | null {
  const m = ENTITY_FILE_RE.exec(relPath);
  return m ? m[1] : null;
}

export interface CompanyInput {
  /** 연결된 체크박스 줄의 파일(볼트 기준 상대경로) */
  file?: string;
  /** [mail::] 경로 */
  mail?: string;
  /** 큐레이션 src (mail 이 없을 때만 본다) */
  src?: string;
}

/**
 * 1. 연결된 줄의 파일이 `wiki/entities/<X>.md` → X
 * 2. 메일함 폴더 → FOLDER_SKIP 이면 없음, 아니면 FOLDER_PAGE[폴더] ?? 폴더 가 엔티티면 그 이름, 아니면 폴더
 * 3. 그 외 없음
 */
export function resolveCompany(
  input: CompanyInput,
  maps: LinkMappings,
  entityNames: ReadonlySet<string>,
): string | undefined {
  if (input.file) {
    const entity = entityNameOf(input.file);
    if (entity) return entity;
  }
  let folder: string | undefined;
  if (input.mail) folder = MAIL_FOLDER_RE.exec(input.mail)?.[1];
  if (folder === undefined && input.src) folder = SRC_MAIL_FOLDER_RE.exec(input.src.replace(/\\/g, '/'))?.[1];
  if (folder === undefined || folder === '') return undefined;
  if (maps.folderSkip.has(folder)) return undefined;
  const name = maps.folderPage.get(folder) ?? folder;
  return entityNames.has(name) ? name : folder;
}
