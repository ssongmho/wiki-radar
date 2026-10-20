// 메일함 왼쪽 칸(2.10단계 명세 §8-2): 머리 줄 '메일 N통 · 최근 HH:MM' · 전체/미확인/회신 필요/처리함(각 수) · 검색 칸 ·
// 「노이즈 추정 포함」 · 메일함(폴더) 목록(누르면 그 폴더만, 다시 누르면 해제). 질의는 main 이 한다(검색은 300ms 뒤).
import type { ReactElement, Ref } from 'react';
import type { MailFilter, MailFolderCount } from '../../../../shared/types';
import { IconFolder, IconSearch } from '../../../components/Icons';
import { cls } from '../../../lib/cls';
import { MAIL_FILTERS } from '../../../lib/mailbox';

export interface MailFiltersProps {
  filter: MailFilter;
  counts: Record<MailFilter, number>;
  query: string;
  includeMuted: boolean;
  folder: string | null;
  folders: readonly MailFolderCount[];
  /** 메일 수(요약) */
  total: number;
  /** '최근 HH:MM' 글자(가장 최근 메일 시각 — 수집 시각은 모른다) */
  latest: string;
  onFilter: (filter: MailFilter) => void;
  onQuery: (query: string) => void;
  onIncludeMuted: (on: boolean) => void;
  onFolder: (folder: string | null) => void;
  searchRef?: Ref<HTMLInputElement>;
}

export function MailFilters(props: MailFiltersProps): ReactElement {
  const { filter, counts, query, includeMuted, folder, folders, total, latest, onFilter, onQuery, onIncludeMuted, onFolder, searchRef } =
    props;
  return (
    <nav className="mb-filters scroll" data-testid="mail-filters" aria-label="메일 거르기">
      <p className="mb-filters-head">
        <span>메일 {total.toLocaleString('ko-KR')}통</span>
        {latest && <span className="mb-filters-latest">최근 {latest}</span>}
      </p>
      <ul className="mb-filter-list">
        {MAIL_FILTERS.map((f) => {
          const on = f.key === filter;
          const n = counts[f.key];
          return (
            <li key={f.key}>
              <button
                type="button"
                className={cls('mb-filter', on && 'is-selected', f.key === 'replyNeeded' && n > 0 && 'is-amber')}
                data-testid={`mail-filter-${f.key}`}
                data-count={n}
                aria-pressed={on}
                onClick={() => onFilter(f.key)}
              >
                <span className="mb-filter-label">{f.label}</span>
                <span className={cls('mb-filter-count', n === 0 && 'is-zero')}>{n}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <label className="mb-search">
        <IconSearch size={16} />
        <input
          ref={searchRef}
          type="search"
          className="mb-search-input"
          data-testid="mail-search"
          aria-label="메일 검색 — 제목·보낸이·메일함"
          aria-keyshortcuts="/"
          placeholder="제목·보낸이·메일함"
          title="제목·보낸이·메일함 이름으로 찾습니다 (/)"
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query !== '') {
              e.preventDefault();
              e.stopPropagation();
              onQuery('');
            }
          }}
        />
      </label>
      <label className="mb-check">
        <input type="checkbox" data-testid="mail-include-muted" checked={includeMuted} onChange={(e) => onIncludeMuted(e.target.checked)} />
        <span>노이즈 추정 포함</span>
      </label>
      <h2 className="mb-folders-title" id="mb-folders-title">
        메일함
      </h2>
      <ul className="mb-folder-list" aria-labelledby="mb-folders-title">
        {folders.map((f) => {
          const on = f.name === folder;
          return (
            <li key={f.name}>
              <button
                type="button"
                className={cls('mb-folder', on && 'is-selected')}
                data-testid="mail-folder"
                data-folder={f.name}
                aria-pressed={on}
                title={on ? `${f.name} — 다시 누르면 모든 메일함` : `${f.name}만 보기`}
                onClick={() => onFolder(on ? null : f.name)}
              >
                <IconFolder size={14} />
                <span className="mb-folder-name">{f.name}</span>
                {f.unread > 0 && <span className="mb-folder-unread">{f.unread}</span>}
                <span className="mb-folder-count">{f.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
