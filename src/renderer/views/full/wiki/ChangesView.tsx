// 위키 변경 화면(3a단계 명세 §8-3): 내비 오른쪽 전체 = 왼쪽 목록(탭 개인 N · 팀 N · [모두 읽음]) | 오른쪽 미리보기.
// 줄마다 [읽음] — 누르면 줄이 흐려지고 바로 빠지지 않는다(화면을 떠나면 빠진다). [모두 읽음]은 확인 없이 하고 12초 [되돌리기].
// 개인 탭 아래에는 log.md 최근 14일을 접어 둔다. 탭·고른 문서는 FullView 가 든다. 문서 본문은 데이터다.
import { useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type SetStateAction } from 'react';
import type { WikiChangeItem, WikiDocInput, WikiDocSource, WikiDocsSummary } from '../../../../shared/types';
import { FEATURES } from '../../../../shared/edition';
import { WIKI_SOURCE_LABEL } from '../../../../shared/wikiDocs';
import { IconCheck, IconChevronDown, IconSettings, IconUndo } from '../../../components/Icons';
import { EmptyState, LoadingState } from '../../../components/StateMessage';
import { markWikiSeen, undoWikiSeen, useRecheckOnOpen, useWikiChanges, useWikiLogRecent } from '../../../hooks/useWikiDocs';
import { cls } from '../../../lib/cls';
import { errorText } from '../../../lib/snapshot';
import {
  CHANGE_LABEL,
  WIKI_UNDO_MS,
  changeTimeText,
  docKey,
  groupChanges,
  linesText,
  mergeRetained,
  needsRecheck,
  sameDoc,
  sourceReason,
} from '../../../lib/wiki';
import { DocChips } from './SearchView';
import { WikiPreview } from './WikiPreview';

export interface WikiChangesSelection {
  /** 고른 탭(null 이면 기본 — 안 읽은 것이 있는 쪽, 둘 다 있으면 개인) */
  tab: WikiDocSource | null;
  selected: WikiDocInput | null;
}

export const INITIAL_WIKI_CHANGES: WikiChangesSelection = { tab: null, selected: null };

export interface ChangesViewProps {
  summary: WikiDocsSummary | null;
  selection: WikiChangesSelection;
  onSelectionChange: Dispatch<SetStateAction<WikiChangesSelection>>;
  today: string;
  onOpenSetup: () => void;
  onOpenFile: (path: string) => void;
  onOpenTeamDoc: (path: string) => void;
  notify: (message: string) => void;
}

/** 기본 탭(§8-3) */
export function defaultChangesTab(summary: WikiDocsSummary | null): WikiDocSource {
  if (!summary) return 'personal';
  if (summary.changes.personal > 0) return 'personal';
  if (summary.changes.team > 0) return 'team';
  return sourceReason(summary.sources.personal, 'personal') && !sourceReason(summary.sources.team, 'team') ? 'team' : 'personal';
}

interface UndoState {
  id: number;
  token: string;
  text: string;
}

export function ChangesView(props: ChangesViewProps): ReactElement {
  const { summary, selection, onSelectionChange, today, notify } = props;
  const revision = summary?.revision ?? 0;
  const tab = selection.tab ?? defaultChangesTab(summary);
  const changes = useWikiChanges(tab, revision, true);
  const logRecent = useWikiLogRecent(revision, tab === 'personal');
  useRecheckOnOpen(() => needsRecheck(summary, Date.now()));

  // 이 화면에서 읽음으로 바꾼 줄(흐리게 남긴다 — 화면을 떠나면 빠진다)
  const [retained, setRetained] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState<WikiChangeItem[]>([]);
  const shownSource = useRef<WikiDocSource | null>(null);
  useEffect(() => {
    if (!changes.page || changes.source !== tab) return;
    const fresh = changes.page.items;
    setShown((prev) => mergeRetained(fresh, shownSource.current === tab ? prev : [], retained));
    shownSource.current = tab;
  }, [changes.page, changes.source, tab, retained]);
  const freshKeys = new Set((changes.source === tab ? (changes.page?.items ?? []) : []).map(docKey));
  const items = shownSource.current === tab ? shown : [];

  const keep = useCallback((ref: WikiDocInput) => {
    setRetained((s) => new Set(s).add(docKey(ref)));
  }, []);

  const select = (ref: WikiDocInput): void => onSelectionChange((s) => ({ ...s, selected: { source: ref.source, path: ref.path } }));
  const setTab = (t: WikiDocSource): void => onSelectionChange((s) => ({ ...s, tab: t }));

  const markOne = async (item: WikiChangeItem): Promise<void> => {
    keep(item);
    try {
      await markWikiSeen({ items: [{ source: item.source, path: item.path }] });
    } catch (err) {
      notify(`읽음으로 바꾸지 못했습니다. (${errorText(err)})`);
    }
  };

  // ── [모두 읽음] · 되돌리기 ──
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  const markAll = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const n = summary?.changes[tab] ?? items.length;
    try {
      const token = await markWikiSeen({ all: true, source: tab });
      setRetained(new Set());
      setShown([]);
      if (token) setUndo({ id: ++undoSeq.current, token, text: `${WIKI_SOURCE_LABEL[tab]} 변경 ${n}건을 읽음으로 했습니다.` });
    } catch (err) {
      notify(`모두 읽음으로 바꾸지 못했습니다. (${errorText(err)})`);
    } finally {
      setBusy(false);
    }
  };
  const doUndo = async (): Promise<void> => {
    if (!undo) return;
    const u = undo;
    setUndo(null);
    try {
      await undoWikiSeen(u.token);
    } catch (err) {
      notify(`되돌리지 못했습니다. (${errorText(err)})`);
    }
  };
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo((u) => (u && u.id === undo.id ? null : u)), WIKI_UNDO_MS);
    return () => window.clearTimeout(t);
  }, [undo]);

  // ── 키보드: 목록에서 ↑/↓ ──
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const idx = items.findIndex((it) => sameDoc(it, selection.selected));
    const next = Math.min(items.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)));
    const it = items[next];
    if (!it) return;
    e.preventDefault();
    select(it);
    rowEls.current.get(docKey(it))?.focus();
  };

  const personalReason = sourceReason(summary?.sources.personal, 'personal');
  const teamReason = sourceReason(summary?.sources.team, 'team');
  const page = changes.source === tab ? changes.page : null;
  const deleted = items.find((it) => it.change === 'deleted' && sameDoc(it, selection.selected)) ?? null;
  const unread = summary?.changes[tab] ?? 0;

  const tabs: { key: WikiDocSource; count: number; reason: string | null }[] = [
    { key: 'personal', count: summary?.changes.personal ?? 0, reason: personalReason },
    // 공개판은 팀 위키 탭을 그리지 않는다(src/shared/edition.ts)
    ...(FEATURES.teamWiki ? [{ key: 'team' as const, count: summary?.changes.team ?? 0, reason: teamReason }] : []),
  ];

  let body: ReactElement;
  if (changes.status === 'error' && !page) {
    body = (
      <div className="wk-empty" data-testid="wiki-changes-state" data-state="error">
        <EmptyState title="변경을 불러오지 못했습니다.">{changes.message}</EmptyState>
      </div>
    );
  } else if (!page) {
    body = <LoadingState text="변경을 계산하는 중입니다…" />;
  } else if (page.state === 'off' || page.state === 'noWiki' || page.state === 'problem' || page.state === 'missing' || page.state === 'waiting') {
    const text =
      page.state === 'waiting'
        ? '첫 동기화를 기다리는 중입니다.'
        : (page.problem ?? (tab === 'team' ? teamReason : personalReason) ?? '쓸 수 없습니다.');
    body = (
      <div className="wk-empty" data-testid="wiki-changes-state" data-state={page.state}>
        <EmptyState title={text}>
          {page.state === 'waiting'
            ? '팀 위키 첫 동기화가 끝나면 그때 있는 문서를 기준으로 삼고, 그 뒤 팀원이 고친 것을 여기에 보입니다.'
            : tab === 'team'
              ? '팀 위키 동기화는 설정 › 점검에서 켭니다.'
              : '개인 위키 폴더는 설정 › 점검에서 고릅니다.'}
        </EmptyState>
        {page.state !== 'waiting' && (
          <button type="button" className="btn btn--secondary" onClick={props.onOpenSetup}>
            <IconSettings size={16} />
            설정 › 점검
          </button>
        )}
      </div>
    );
  } else {
    const groups = groupChanges(items, today);
    body = (
      <>
        {page.syncNote && <p className="wk-note wk-note--warn">{page.syncNote}</p>}
        {page.bulk !== undefined && page.bulk > 0 && (
          <p className="wk-note wk-note--warn" data-testid="wiki-bulk">
            한 번에 {page.bulk.toLocaleString('ko-KR')}건이 바뀌었습니다 — 폴더를 옮겼거나 위키를 바꿨다면 [모두 읽음]
          </p>
        )}
        {items.length === 0 ? (
          <div className="wk-empty" data-testid="wiki-changes-state" data-state="empty">
            <EmptyState title="마지막으로 본 뒤 바뀐 문서가 없습니다." />
          </div>
        ) : (
          <div className="wk-changes" onKeyDown={onListKey}>
            {groups.map((g) => (
              <section key={g.label} className="wk-day" aria-label={g.label}>
                <h3 className="wk-day-title">{g.label}</h3>
                <ul className="wk-rows">
                  {g.items.map((it) => (
                    <ChangeRow
                      key={docKey(it)}
                      item={it}
                      selected={sameDoc(it, selection.selected)}
                      dim={!freshKeys.has(docKey(it))}
                      onSelect={() => select(it)}
                      onSeen={() => void markOne(it)}
                      register={(el) => {
                        if (el) rowEls.current.set(docKey(it), el);
                        else rowEls.current.delete(docKey(it));
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {page.more > 0 && (
          <p className="wk-note">
            그 밖 {page.more.toLocaleString('ko-KR')}건 —
            <button type="button" className="link-btn" onClick={() => void markAll()}>
              모두 읽음
            </button>
          </p>
        )}
      </>
    );
  }

  return (
    <section className="wk" data-testid="changes-view" data-tab={tab} aria-label="위키 변경">
      <div className="wk-list">
        <div className="wk-list-head wk-list-head--changes">
          <div className="sv-tabs wk-tabs" role="tablist" aria-label="출처">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                className={cls('sv-tab', tab === t.key && 'is-selected', t.reason && 'is-unavailable')}
                data-testid={`wiki-changes-tab-${t.key}`}
                data-count={t.count}
                data-unavailable={t.reason ? 'true' : undefined}
                aria-selected={tab === t.key}
                title={t.reason ?? undefined}
                onClick={() => setTab(t.key)}
              >
                {WIKI_SOURCE_LABEL[t.key]}
                <span className={cls('wk-tab-count', t.count === 0 && 'is-zero')}>{t.count}</span>
              </button>
            ))}
            <span className="wk-tabs-spacer" />
            <button
              type="button"
              className="btn btn--secondary wk-seen-all"
              data-testid="btn-wiki-seen-all"
              disabled={busy || unread === 0}
              onClick={() => void markAll()}
            >
              <IconCheck size={16} />
              모두 읽음
            </button>
          </div>
          {undo && (
            <div className="wk-undo" role="status" data-testid="wiki-undo">
              <span>{undo.text}</span>
              <button type="button" className="link-btn" data-testid="btn-wiki-undo" onClick={() => void doUndo()}>
                <IconUndo size={14} />
                되돌리기
              </button>
            </div>
          )}
        </div>
        <div className="wk-list-body scroll">
          {body}
          {tab === 'personal' && !personalReason && <LogRecent entries={logRecent} selected={selection.selected} onOpen={select} />}
        </div>
      </div>
      <WikiPreview
        doc={selection.selected}
        deleted={deleted}
        revision={revision}
        emptyText="왼쪽에서 바뀐 문서를 고르면 여기에 보입니다."
        onOpenFile={props.onOpenFile}
        onOpenTeamDoc={props.onOpenTeamDoc}
        onSeen={keep}
        notify={notify}
      />
    </section>
  );
}

function ChangeRow({
  item,
  selected,
  dim,
  onSelect,
  onSeen,
  register,
}: {
  item: WikiChangeItem;
  selected: boolean;
  dim: boolean;
  onSelect: () => void;
  onSeen: () => void;
  register: (el: HTMLButtonElement | null) => void;
}): ReactElement {
  const lines = linesText(item.lines, item.source === 'team' ? ' 줄' : '');
  return (
    <li
      className={cls('wk-row', selected && 'is-selected', dim && 'is-seen')}
      data-testid="wiki-change-row"
      data-source={item.source}
      data-path={item.path}
      data-change={item.change}
      data-added={item.lines ? item.lines.added : undefined}
      data-removed={item.lines ? item.lines.removed : undefined}
      data-seen={dim ? 'true' : undefined}
    >
      <button type="button" className="wk-row-main" aria-current={selected ? 'true' : undefined} ref={register} onClick={onSelect}>
        <span className="wk-row-top">
          <span className={cls('wk-chip', `wk-chip--${item.change}`)}>{CHANGE_LABEL[item.change]}</span>
          <span className="wk-row-title">{item.title}</span>
          <span className="wk-row-time">{changeTimeText(item.detectedAt)}</span>
        </span>
        <span className="wk-row-sub">
          <DocChips source={item.source} kind={item.kind} priv={item.private} />
          <span className="wk-row-path">{item.path}</span>
        </span>
        {item.source === 'personal' ? (
          <span className="wk-row-why">
            {item.reasons && item.reasons.length > 0 ? (
              item.reasons.slice(0, 2).map((r, i) => (
                <span key={`${r.date}:${i}`} className="wk-row-reason" data-testid="wiki-change-reason">
                  [{r.date}] {r.kind ? `${r.kind} · ` : ''}
                  {r.title}
                </span>
              ))
            ) : item.change !== 'deleted' ? (
              <span className="wk-row-reason is-none">log.md 에 기록 없음</span>
            ) : null}
            {lines && <span className="wk-row-lines">{lines}</span>}
          </span>
        ) : (
          <span className="wk-row-why">
            {lines && <span className="wk-row-lines">{lines}</span>}
            {item.change === 'new'
              ? item.firstLine && <span className="wk-row-sample">{item.firstLine}</span>
              : item.lines?.sample[0] && <span className="wk-row-sample">+ {item.lines.sample[0]}</span>}
          </span>
        )}
      </button>
      <button type="button" className="link-btn wk-row-seen" data-testid="btn-wiki-seen" disabled={dim} onClick={onSeen}>
        {dim ? '읽음 처리됨' : '읽음'}
      </button>
    </li>
  );
}

function LogRecent({
  entries,
  selected,
  onOpen,
}: {
  entries: ReturnType<typeof useWikiLogRecent>;
  selected: WikiDocInput | null;
  onOpen: (ref: WikiDocInput) => void;
}): ReactElement {
  return (
    <details className="wk-log" data-testid="wiki-log-recent">
      <summary className="wk-log-head">
        <IconChevronDown size={14} className="wk-log-chevron" />
        최근 기록(log.md 14일) <span className="wk-log-count">{entries.length}</span>
      </summary>
      {entries.length === 0 ? (
        <p className="wk-log-none">최근 14일 log.md 기록이 없습니다.</p>
      ) : (
        <ul className="wk-log-list">
          {entries.map((e, i) => (
            <li key={`${e.date}:${i}`} className="wk-log-entry">
              <p className="wk-log-title">
                <span className="wk-log-date">[{e.date}]</span> {e.kind ? `${e.kind} · ` : ''}
                {e.title}
              </p>
              {e.docs.length > 0 && (
                <p className="wk-log-docs">
                  {e.docs.map((d) => (
                    <button
                      key={docKey(d)}
                      type="button"
                      className={cls('link-btn', 'wk-log-doc', sameDoc(d, selected) && 'is-selected')}
                      data-testid="wiki-log-doc"
                      onClick={() => onOpen(d)}
                    >
                      {d.title}
                    </button>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
