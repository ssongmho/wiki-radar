// 위키 검색 화면(3a단계 명세 §8-2): 내비 오른쪽 전체 = 왼쪽 목록 420px(검색 칸 · 출처 칩 · 결과) | 오른쪽 미리보기.
// 질의·출처·고른 문서는 FullView 가 들고 있어 다른 화면에 다녀와도 그대로다. 처음 열면 아무것도 고르지 않는다(열기만으로 읽음이 되지 않게).
// 강조는 텍스트 노드로 나눠 <mark> 로 만든다(innerHTML 아님). 문서 본문은 데이터다.
import { useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type SetStateAction } from 'react';
import type { WikiDocInput, WikiDocKind, WikiDocRef, WikiDocSource, WikiDocsSummary, WikiSearchHit, WikiSearchSource } from '../../../../shared/types';
import { FEATURES } from '../../../../shared/edition';
import { WIKI_SOURCE_LABEL } from '../../../../shared/wikiDocs';
import { IconLock, IconSearch } from '../../../components/Icons';
import { EmptyState, LoadingState } from '../../../components/StateMessage';
import { useDebounced } from '../../../hooks/useMailbox';
import { useRecentDocs, useRecheckOnOpen, useWikiSearch } from '../../../hooks/useWikiDocs';
import { cls } from '../../../lib/cls';
import {
  SEARCH_SOURCES,
  WIKI_MAX_RESULTS,
  WIKI_PAGE_SIZE,
  WIKI_SEARCH_DELAY_MS,
  docKey,
  folderOf,
  indexedText,
  kindChip,
  mtimeText,
  needsRecheck,
  sameDoc,
  sourceReason,
  splitHighlights,
  titleHits,
  type HighlightPart,
} from '../../../lib/wiki';
import { WikiPreview } from './WikiPreview';

export interface WikiSearchSelection {
  query: string;
  source: WikiSearchSource;
  selected: WikiDocInput | null;
  /** 보이는 결과 수(50씩 더 보기, 최대 200) */
  limit: number;
}

export const INITIAL_WIKI_SEARCH: WikiSearchSelection = { query: '', source: 'all', selected: null, limit: WIKI_PAGE_SIZE };

export interface SearchViewProps {
  summary: WikiDocsSummary | null;
  selection: WikiSearchSelection;
  onSelectionChange: Dispatch<SetStateAction<WikiSearchSelection>>;
  /** Ctrl+K·view:search 로 열 때마다 늘어난다 — 검색 칸에 초점·글자 전체 선택 */
  focusRequest: number;
  onOpenFile: (path: string) => void;
  onOpenTeamDoc: (path: string) => void;
  notify: (message: string) => void;
}

function Marked({ parts }: { parts: HighlightPart[] }): ReactElement {
  return (
    <>
      {parts.map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

export function DocChips({ source, kind, priv }: { source: WikiDocSource; kind: WikiDocKind; priv: boolean }): ReactElement {
  const k = kindChip(kind);
  return (
    <>
      <span className={cls('wk-chip', source === 'team' ? 'wk-chip--team' : 'wk-chip--personal')}>{WIKI_SOURCE_LABEL[source]}</span>
      {k && (
        <span className={cls('wk-chip', priv && 'wk-chip--private')}>
          {priv && <IconLock size={12} />}
          {k}
        </span>
      )}
    </>
  );
}

export function SearchView(props: SearchViewProps): ReactElement {
  const { summary, selection, onSelectionChange } = props;
  const revision = summary?.revision ?? 0;
  const query = useDebounced(selection.query, WIKI_SEARCH_DELAY_MS);
  const q = query.trim();
  const search = useWikiSearch(q, selection.source, selection.limit, revision, true);
  const recent = useRecentDocs(revision, !selection.query.trim());
  useRecheckOnOpen(() => needsRecheck(summary, Date.now()));

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [previewFocus, setPreviewFocus] = useState(0);

  // Ctrl+K·바깥에서 연 검색 → 검색 칸 초점·전체 선택
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [props.focusRequest]);

  const page = search.page;
  const fresh = !!page && search.query === q;
  const hits: WikiSearchHit[] = q && page ? page.hits : [];
  const rows: WikiDocRef[] | WikiSearchHit[] = q ? hits : recent;

  const select = useCallback(
    (ref: WikiDocInput) => onSelectionChange((s) => ({ ...s, selected: { source: ref.source, path: ref.path } })),
    [onSelectionChange],
  );

  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const focusRow = (i: number): void => {
    const r = rows[i];
    if (!r) return;
    select(r);
    rowEls.current.get(docKey(r))?.focus();
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' && rows.length > 0) {
      e.preventDefault();
      focusRow(0);
    }
  };
  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>): void => {
    const idx = rows.findIndex((r) => sameDoc(r, selection.selected));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.key === 'ArrowUp' && idx <= 0) {
        inputRef.current?.focus();
        return;
      }
      focusRow(Math.min(rows.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && idx >= 0) {
      e.preventDefault();
      setPreviewFocus((n) => n + 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  const personalReason = sourceReason(summary?.sources.personal, 'personal');
  const teamReason = sourceReason(summary?.sources.team, 'team');
  const reasonOf = (k: WikiSearchSource): string | null => (k === 'personal' ? personalReason : k === 'team' ? teamReason : null);
  const countOf = (k: WikiSearchSource): number | null => {
    if (!q || !page) return null;
    if (k === 'personal') return page.counts.personal;
    if (k === 'team') return page.counts.team;
    return page.counts.personal + page.counts.team;
  };
  const indexed = indexedText(summary);
  const indexing = !!summary && [summary.sources.personal, summary.sources.team].some((s) => s.state === 'indexing');

  let listBody: ReactElement;
  if (!q) {
    listBody = (
      <>
        <p className="wk-list-sub">최근 바뀐 문서</p>
        <ul className="wk-hits" data-testid="wiki-recent" ref={listRef} onKeyDown={onListKey}>
          {recent.map((r) => (
            <li key={docKey(r)}>
              <button
                type="button"
                className={cls('wk-hit', sameDoc(r, selection.selected) && 'is-selected')}
                data-testid="wiki-recent-doc"
                data-source={r.source}
                data-path={r.path}
                data-kind={r.kind}
                aria-current={sameDoc(r, selection.selected) ? 'true' : undefined}
                ref={(el) => {
                  if (el) rowEls.current.set(docKey(r), el);
                  else rowEls.current.delete(docKey(r));
                }}
                onClick={() => select(r)}
              >
                <span className="wk-hit-top">
                  <span className="wk-hit-title">{r.title}</span>
                  <DocChips source={r.source} kind={r.kind} priv={r.private} />
                </span>
                <span className="wk-hit-path">
                  {r.path}
                  {mtimeText(r.mtimeMs) && <span className="wk-hit-time"> · {mtimeText(r.mtimeMs)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="wk-help">Ctrl+K 로 어디서나 검색</p>
      </>
    );
  } else if (search.status === 'error') {
    listBody = (
      <div className="wk-empty">
        <EmptyState title="검색하지 못했습니다.">{search.message}</EmptyState>
      </div>
    );
  } else if (!page) {
    listBody = <LoadingState text="찾는 중입니다…" />;
  } else if (fresh && hits.length === 0) {
    listBody = (
      <div className="wk-empty" data-testid="wiki-search-empty">
        <EmptyState title={`‘${q}’ 와 맞는 문서가 없습니다.`}>
          {indexing ? '아직 문서를 읽는 중입니다 — 잠시 뒤 다시 찾아보세요.' : '낱말을 줄이거나 다른 말로 찾아보세요.'}
        </EmptyState>
        {selection.source !== 'all' && (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-wiki-search-all"
            onClick={() => onSelectionChange((s) => ({ ...s, source: 'all', limit: WIKI_PAGE_SIZE }))}
          >
            전체에서 찾기
          </button>
        )}
      </div>
    );
  } else {
    listBody = (
      <>
        <ul className={cls('wk-hits', !fresh && 'is-stale')} data-testid="wiki-hits" ref={listRef} onKeyDown={onListKey}>
          {hits.map((h) => {
            const picked = sameDoc(h, selection.selected);
            return (
              <li key={docKey(h)}>
                <button
                  type="button"
                  className={cls('wk-hit', picked && 'is-selected')}
                  data-testid="wiki-hit"
                  data-source={h.source}
                  data-path={h.path}
                  data-kind={h.kind}
                  aria-current={picked ? 'true' : undefined}
                  ref={(el) => {
                    if (el) rowEls.current.set(docKey(h), el);
                    else rowEls.current.delete(docKey(h));
                  }}
                  onClick={() => select(h)}
                >
                  <span className="wk-hit-top">
                    <span className="wk-hit-title">
                      <Marked parts={splitHighlights(h.title, titleHits(h.title, search.query))} />
                    </span>
                    <DocChips source={h.source} kind={h.kind} priv={h.private} />
                  </span>
                  <span className="wk-hit-path">{folderOf(h.path) || h.path}</span>
                  {h.snippet && (
                    <span className="wk-hit-snippet" data-testid="wiki-hit-snippet">
                      <Marked parts={splitHighlights(h.snippet, h.hits)} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {page.total > hits.length && selection.limit < WIKI_MAX_RESULTS && (
          <button
            type="button"
            className="btn btn--secondary wk-more"
            data-testid="btn-wiki-more"
            onClick={() => onSelectionChange((s) => ({ ...s, limit: Math.min(WIKI_MAX_RESULTS, s.limit + WIKI_PAGE_SIZE) }))}
          >
            더 보기 ({Math.min(WIKI_PAGE_SIZE, page.total - hits.length)}건)
          </button>
        )}
      </>
    );
  }

  return (
    <section className="wk" data-testid="search-view" aria-label="위키 검색">
      <div className="wk-list">
        <div className="wk-list-head">
          <label className="wk-search">
            <IconSearch size={16} />
            <span className="sr-only">위키 검색</span>
            <input
              ref={inputRef}
              type="search"
              className="wk-search-input"
              data-testid="wiki-search-input"
              placeholder="제목·본문 검색"
              value={selection.query}
              maxLength={200}
              aria-keyshortcuts="Control+K"
              onChange={(e) => onSelectionChange((s) => ({ ...s, query: e.target.value, limit: WIKI_PAGE_SIZE }))}
              onKeyDown={onInputKey}
            />
          </label>
          {/* 공개판은 팀 위키가 없어 출처가 개인 위키 하나다 — 칩을 그리지 않는다(src/shared/edition.ts) */}
          {FEATURES.teamWiki && (
            <div className="wk-sources" role="group" aria-label="출처">
              {SEARCH_SOURCES.map((s) => {
                const reason = reasonOf(s.key);
                const count = countOf(s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    className={cls('wk-source', selection.source === s.key && 'is-selected', reason && 'is-unavailable')}
                    data-testid={`wiki-source-${s.key}`}
                    data-count={count ?? undefined}
                    data-unavailable={reason ? 'true' : undefined}
                    aria-pressed={selection.source === s.key}
                    title={reason ?? undefined}
                    onClick={() => onSelectionChange((x) => ({ ...x, source: s.key, limit: WIKI_PAGE_SIZE }))}
                  >
                    {s.label}
                    {count !== null && <span className="wk-source-count">{count}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <p className="wk-list-meta">
            {q && page ? (
              <span>
                {page.total.toLocaleString('ko-KR')}건{page.total > hits.length ? `(상위 ${hits.length})` : ''}
              </span>
            ) : (
              <span>문서 {((summary?.sources.personal.docs ?? 0) + (summary?.sources.team.docs ?? 0)).toLocaleString('ko-KR')}개</span>
            )}
            {indexing ? <span>읽는 중…</span> : indexed && <span>{indexed}</span>}
          </p>
        </div>
        <div className="wk-list-body scroll">{listBody}</div>
      </div>
      <WikiPreview
        doc={selection.selected}
        revision={revision}
        focusRequest={previewFocus}
        emptyText={rows.length > 0 ? '왼쪽에서 문서를 고르면 여기에 보입니다.' : '찾을 말을 넣어 보세요.'}
        onOpenFile={props.onOpenFile}
        onOpenTeamDoc={props.onOpenTeamDoc}
        notify={props.notify}
      />
    </section>
  );
}
