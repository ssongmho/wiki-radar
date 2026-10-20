// 위키 문서 미리보기(3a단계 명세 §8-4) — 검색·변경 화면이 같이 쓴다(나중에 할 일·메일에서도).
// 본문은 wikiMarkdown(§7)이 만든 HTML 을 넣는다 — 이 앱에서 dangerouslySetInnerHTML 을 쓰는 유일한 곳이다.
// 그 HTML 에는 원문 주소가 href/src 로 들어가지 않는다: 링크는 data-wiki-link / data-ext-link, 그림은 data-img-ref 자리표시자이고
// 클릭·그림 채우기는 여기서 이벤트 위임과 IntersectionObserver 로 한다. 외부 링크는 확인 뒤에만 main 이 기본 브라우저로 연다.
// 위키링크를 누르면 같은 칸에서 그 문서를 열고(이동 기록 최대 30), 문서가 바뀌면 저절로 바꾸지 않고 [다시 읽기]를 보인다.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { WikiChangeItem, WikiDocInput, WikiPage } from '../../../../shared/types';
import { WIKI_SOURCE_LABEL } from '../../../../shared/wikiDocs';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { IconBack, IconCheck, IconExternal, IconLock, IconRefresh } from '../../../components/Icons';
import { EmptyState, LoadingState } from '../../../components/StateMessage';
import { acceptWikiSummary, fetchWikiImage, fetchWikiPage, markWikiSeen, openExternalLink } from '../../../hooks/useWikiDocs';
import { cls } from '../../../lib/cls';
import { errorText } from '../../../lib/snapshot';
import { CHANGE_LABEL, WIKI_HISTORY_MAX, WIKI_IMAGE_BATCH, WIKI_READ_DELAY_MS, docKey, kindChip, linesText, mtimeText } from '../../../lib/wiki';
import { renderWikiMarkdown } from '../../../lib/wikiMarkdown';

export interface WikiPreviewProps {
  /** 목록에서 고른 문서(없으면 빈 칸) */
  doc: WikiDocInput | null;
  /** 고른 문서가 지운 문서(변경 항목 deleted)면 그 항목 — 본문 대신 안내 */
  deleted?: WikiChangeItem | null;
  /** 요약 revision — 바뀌면 문서를 다시 확인한다 */
  revision: number;
  /** 바깥에서 「미리보기에 초점」 요청(목록에서 Enter) */
  focusRequest?: number;
  /** 빈 칸 안내 */
  emptyText?: string;
  onOpenFile: (path: string) => void;
  onOpenTeamDoc: (path: string) => void;
  /** 이 미리보기가 문서를 읽음으로 바꿨다(변경 목록이 그 줄을 흐리게) */
  onSeen?: (ref: WikiDocInput) => void;
  notify: (message: string) => void;
}

interface Current extends WikiDocInput {
  heading?: string;
}

type PageState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; page: WikiPage; pending: WikiPage | null }
  | { status: 'missing'; key: string }
  | { status: 'error'; key: string; message: string };

function headingMatch(a: string, b: string): boolean {
  const n = (s: string): string => s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  return n(a) === n(b);
}

export function WikiPreview(props: WikiPreviewProps): ReactElement {
  const { doc, deleted, revision, onSeen, notify } = props;
  const deletedKey = deleted ? docKey(deleted) : '';
  const [current, setCurrent] = useState<Current | null>(doc);
  const [stack, setStack] = useState<Current[]>([]);
  const docId = doc ? docKey(doc) : '';
  // 목록에서 다른 문서를 고르면 이동 기록을 새로 시작한다
  useEffect(() => {
    setCurrent(doc);
    setStack([]);
    // 고른 문서가 바뀔 때만
  }, [docId]);

  const curKey = current ? docKey(current) : '';
  const [state, setState] = useState<PageState>({ status: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;

  // 문서 읽기(고른 문서가 바뀌면 처음부터, revision 이 바뀌면 다시 확인 — 해시가 다르면 [다시 읽기])
  useEffect(() => {
    if (!current || deletedKey === curKey) {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    const prev = stateRef.current;
    const same = prev.status !== 'idle' && prev.key === curKey;
    if (!same) setState({ status: 'loading', key: curKey });
    fetchWikiPage(current).then(
      (page) => {
        if (!live) return;
        setState((s) => {
          if (!page) return s.status === 'ready' && s.key === curKey ? s : { status: 'missing', key: curKey };
          if (s.status === 'ready' && s.key === curKey) {
            // 같은 내용이면 머리 정보(변경 항목 등)만 새로, 내용이 바뀌었으면 기다린다
            if (s.page.hash === page.hash) return { ...s, page: { ...page }, pending: null };
            return { ...s, pending: page };
          }
          return { status: 'ready', key: curKey, page, pending: null };
        });
      },
      (err: unknown) => {
        if (!live) return;
        setState((s) => (s.status === 'ready' && s.key === curKey ? s : { status: 'error', key: curKey, message: errorText(err) }));
      },
    );
    return () => {
      live = false;
    };
  }, [curKey, revision, deletedKey]);

  const page = state.status === 'ready' ? state.page : null;
  const pending = state.status === 'ready' ? state.pending : null;
  const rendered = useMemo(() => (page ? renderWikiMarkdown(page) : null), [page?.source, page?.path, page?.hash, page?.links, page?.images, page?.body]);

  // ── 1초 규칙으로 읽음(§5-7) — 창이 보일 때만. 바뀐 내용을 아직 안 읽었으면(pending) 하지 않는다 ──
  const seenTarget: WikiDocInput | null =
    deleted && current && docKey(deleted) === curKey ? deleted : page?.change && !pending ? { source: page.source, path: page.path } : null;
  const seenKey = seenTarget ? `${docKey(seenTarget)}@${page?.hash ?? 'deleted'}` : '';
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  useEffect(() => {
    if (!seenTarget) return;
    const target = { source: seenTarget.source, path: seenTarget.path };
    const t = window.setTimeout(() => {
      if (document.visibilityState === 'hidden') return;
      markWikiSeen({ items: [target] }).then(
        () => onSeenRef.current?.(target),
        () => undefined,
      );
    }, WIKI_READ_DELAY_MS);
    return () => window.clearTimeout(t);
    // 보이는 문서·내용이 바뀔 때만
  }, [seenKey]);

  const markSeenNow = async (): Promise<void> => {
    if (!seenTarget && !page?.change) return;
    const target = seenTarget ?? (page ? { source: page.source, path: page.path } : null);
    if (!target) return;
    try {
      await markWikiSeen({ items: [target] });
      onSeen?.(target);
    } catch (err) {
      notify(`읽음으로 바꾸지 못했습니다. (${errorText(err)})`);
    }
  };

  // ── 이동 ──
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const navigate = useCallback(
    (to: Current) => {
      if (current && docKey(current) === docKey(to)) {
        if (to.heading) setCurrent({ ...current, heading: to.heading });
        return;
      }
      if (current) setStack((s) => [...s, current].slice(-WIKI_HISTORY_MAX));
      setCurrent(to);
    },
    [current],
  );
  const back = (): void => {
    if (stack.length === 0) return;
    setCurrent(stack[stack.length - 1]);
    setStack(stack.slice(0, -1));
  };

  // 새 문서가 보이면 맨 위로(절이 있으면 그 제목으로)
  useEffect(() => {
    if (!rendered || !page) return;
    const heading = current?.heading;
    if (heading) {
      const h = rendered.headings.find((x) => headingMatch(x.text, heading));
      const el = h ? bodyRef.current?.querySelector<HTMLElement>(`#${h.id}`) : null;
      if (el) {
        el.scrollIntoView({ block: 'start' });
        return;
      }
    }
    scrollRef.current?.scrollTo({ top: 0 });
  }, [page?.path, page?.source, current?.heading, rendered]);

  useEffect(() => {
    if (props.focusRequest) headRef.current?.focus();
  }, [props.focusRequest]);

  // ── 외부 링크(확인 뒤) ──
  const [extUrl, setExtUrl] = useState<string | null>(null);
  const openExt = async (): Promise<void> => {
    const url = extUrl;
    setExtUrl(null);
    if (!url) return;
    try {
      await openExternalLink(url);
    } catch (err) {
      notify(`주소를 열지 못했습니다. (${errorText(err)})`);
    }
  };

  // 본문 클릭(이벤트 위임): 위키링크 · 외부 링크 · 목차. 그 밖의 a 는 아무것도 하지 않는다
  const onBodyClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const el = e.target instanceof Element ? e.target.closest('a') : null;
    if (!el || !page) return;
    e.preventDefault();
    const wl = el.getAttribute('data-wiki-link');
    if (wl !== null) {
      const target = Object.prototype.hasOwnProperty.call(page.links, wl) ? page.links[wl] : null;
      if (!target) return;
      navigate({ source: target.source, path: target.path, ...(target.heading ? { heading: target.heading } : {}) });
      return;
    }
    const ext = el.getAttribute('data-ext-link');
    if (ext) setExtUrl(ext);
  };

  // ── 그림 채우기(보일 때, 한 번에 20장) ──
  const [imageLimit, setImageLimit] = useState(WIKI_IMAGE_BATCH);
  useEffect(() => setImageLimit(WIKI_IMAGE_BATCH), [page?.path, page?.source]);
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !page || !rendered) return;
    const holders = [...root.querySelectorAll<HTMLElement>('[data-img-ref]')];
    const source = page.source;
    const pagePath = page.path;
    let live = true;
    const fill = (el: HTMLElement): void => {
      if (el.dataset.imgState !== 'wait') return;
      el.dataset.imgState = 'loading';
      const ref = el.getAttribute('data-img-ref') ?? '';
      fetchWikiImage(source, pagePath, ref).then(
        (out) => {
          if (!live) return;
          const note = el.querySelector('.wiki-img-note');
          if (out.dataUrl && out.dataUrl.startsWith('data:image/')) {
            const img = document.createElement('img');
            img.alt = el.getAttribute('data-alt') ?? '';
            img.src = out.dataUrl;
            img.className = 'wiki-img-el';
            note?.remove();
            el.appendChild(img);
            el.dataset.imgState = 'done';
          } else {
            el.classList.add('is-blocked');
            el.dataset.imgState = 'failed';
            if (note) note.textContent = `그림을 보일 수 없음: ${out.problem ?? '알 수 없음'}`;
          }
        },
        () => {
          if (!live) return;
          el.dataset.imgState = 'failed';
          const note = el.querySelector('.wiki-img-note');
          if (note) note.textContent = '그림을 보일 수 없음: 읽지 못함';
        },
      );
    };
    const waiting = holders.filter((el) => el.dataset.imgState === 'wait' || el.dataset.imgState === 'more');
    waiting.forEach((el, i) => {
      if (i >= imageLimit && el.dataset.imgState === 'wait') {
        el.dataset.imgState = 'more';
        const note = el.querySelector('.wiki-img-note');
        if (note) note.textContent = '그림 — [그림 더 보기]로 불러옵니다';
      } else if (i < imageLimit && el.dataset.imgState === 'more') {
        el.dataset.imgState = 'wait';
      }
    });
    const targets = holders.filter((el) => el.dataset.imgState === 'wait');
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (en.isIntersecting) {
              observer?.unobserve(en.target);
              fill(en.target as HTMLElement);
            }
          }
        },
        { root: scrollRef.current, rootMargin: '200px' },
      );
      for (const el of targets) observer.observe(el);
    } else {
      targets.forEach(fill);
    }
    return () => {
      live = false;
      observer?.disconnect();
      // 불러오던 것은 다음 번에 다시
      for (const el of holders) if (el.dataset.imgState === 'loading') el.dataset.imgState = 'wait';
    };
  }, [rendered, imageLimit, page?.source, page?.path]);

  // ── 그리기 ──
  if (!current) {
    return (
      <section className="wk-preview wk-preview--empty" aria-label="미리보기">
        <EmptyState title={props.emptyText ?? '왼쪽에서 문서를 고르면 여기에 보입니다.'} />
      </section>
    );
  }

  const openObsidian = (): void => {
    if (!current) return;
    if (current.source === 'team') props.onOpenTeamDoc(current.path);
    else props.onOpenFile(current.path);
  };
  const backBtn = (
    <button
      type="button"
      className="icon-btn wk-back"
      data-testid="btn-wiki-back"
      aria-label="뒤로"
      title={stack.length > 0 ? '이전 문서로' : '이전 문서 없음'}
      disabled={stack.length === 0}
      onClick={back}
    >
      <IconBack size={18} />
    </button>
  );

  if (deleted && docKey(deleted) === curKey) {
    return (
      <section
        className="wk-preview"
        data-testid="wiki-preview"
        data-source={deleted.source}
        data-path={deleted.path}
        data-private={deleted.private ? 'true' : 'false'}
        aria-label="미리보기"
      >
        <header className="wk-pv-head">
          <div className="wk-pv-actions">{backBtn}</div>
          <h2 className="wk-pv-title" tabIndex={-1} ref={headRef}>
            {deleted.title}
          </h2>
          <p className="wk-pv-path">{deleted.path}</p>
        </header>
        <div className="wk-pv-deleted" data-testid="wiki-deleted-note">
          <p className="wk-pv-deleted-title">지운 문서</p>
          <p>
            {deleted.source === 'team'
              ? '팀 위키에서 지워진 문서입니다. 팀 위키 .휴지통 에 있을 수 있습니다.'
              : '개인 위키에서 지워졌거나 옮겨진 문서입니다. 이 앱은 아무것도 지우지 않습니다.'}
          </p>
        </div>
      </section>
    );
  }

  if (state.status !== 'ready' || !page || !rendered) {
    return (
      <section className="wk-preview" data-testid="wiki-preview" data-source={current.source} data-path={current.path} aria-label="미리보기">
        <header className="wk-pv-head">
          <div className="wk-pv-actions">{backBtn}</div>
        </header>
        <div className="wk-pv-state">
          {state.status === 'missing' ? (
            <EmptyState title="문서를 찾지 못했습니다.">옮겨졌거나 지워졌을 수 있습니다. 또는 색인에서 빠지는 폴더의 문서입니다.</EmptyState>
          ) : state.status === 'error' ? (
            <EmptyState title="문서를 읽지 못했습니다.">{state.message}</EmptyState>
          ) : (
            <LoadingState text="문서를 읽는 중입니다…" />
          )}
        </div>
      </section>
    );
  }

  const change = page.change;
  const kind = kindChip(page.kind);
  const fm = page.fm ?? {};
  const toc = rendered.headings.filter((h) => h.level <= 3);
  const reloadPending = (): void => {
    setState((s) => (s.status === 'ready' && s.pending ? { ...s, page: s.pending, pending: null } : s));
  };

  return (
    <section
      className="wk-preview"
      data-testid="wiki-preview"
      data-source={page.source}
      data-path={page.path}
      data-private={page.private ? 'true' : 'false'}
      aria-label="미리보기"
    >
      <header className="wk-pv-head">
        <div className="wk-pv-actions">
          {backBtn}
          <span className="wk-pv-spacer" />
          {change && (
            <button type="button" className="btn btn--secondary wk-pv-btn" data-testid="btn-wiki-preview-seen" onClick={() => void markSeenNow()}>
              <IconCheck size={16} />
              읽음
            </button>
          )}
          <button type="button" className="btn btn--secondary wk-pv-btn" data-testid="btn-wiki-obsidian" onClick={openObsidian}>
            <IconExternal size={16} />
            Obsidian에서 열기
          </button>
        </div>
        <h2 className="wk-pv-title" tabIndex={-1} ref={headRef}>
          {page.title}
        </h2>
        <div className="wk-chips">
          <span className={cls('wk-chip', page.source === 'team' ? 'wk-chip--team' : 'wk-chip--personal')}>{WIKI_SOURCE_LABEL[page.source]}</span>
          {kind && (
            <span className={cls('wk-chip', page.private && 'wk-chip--private')}>
              {page.private && <IconLock size={12} />}
              {kind}
            </span>
          )}
          {change && <span className={cls('wk-chip', `wk-chip--${change.change}`)}>{CHANGE_LABEL[change.change]}</span>}
          {fm.type && <span className="wk-chip wk-chip--fm">type · {fm.type}</span>}
          {fm.domain && <span className="wk-chip wk-chip--fm">{fm.domain}</span>}
          {(fm.tags ?? []).slice(0, 5).map((t) => (
            <span key={`tag:${t}`} className="wk-chip wk-chip--fm">
              #{t}
            </span>
          ))}
          {fm.scope && <span className="wk-chip wk-chip--fm">공개범위 · {fm.scope}</span>}
        </div>
        <p className="wk-pv-meta">
          <span className="wk-pv-path">{page.path}</span>
          {mtimeText(page.mtimeMs) && <span className="wk-pv-time">수정 {mtimeText(page.mtimeMs)}</span>}
        </p>
        {pending && (
          <p className="wk-pv-stale" data-testid="wiki-page-stale" role="status">
            문서가 바뀌었습니다
            <button type="button" className="link-btn" onClick={reloadPending}>
              <IconRefresh size={14} />
              다시 읽기
            </button>
          </p>
        )}
        {change && <ChangeBand item={change} />}
      </header>
      <div className="wk-pv-scroll scroll" ref={scrollRef}>
        {toc.length >= 4 && (
          <details className="wk-toc">
            <summary>목차</summary>
            <ul>
              {toc.map((h) => (
                <li key={h.id} className={`wk-toc-l${h.level}`}>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => bodyRef.current?.querySelector<HTMLElement>(`#${h.id}`)?.scrollIntoView({ block: 'start' })}
                  >
                    {h.text || '(제목 없음)'}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div
          className="wk-md"
          data-testid="wiki-preview-body"
          ref={bodyRef}
          onClick={onBodyClick}
          // 안전 근거: wikiMarkdown 은 html:false 이고 링크·그림을 자리표시자로 다시 그린다(§7-1). 이 앱에서 이것을 쓰는 유일한 곳
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
        {rendered.images > imageLimit && (
          <button type="button" className="btn btn--secondary wk-more-img" onClick={() => setImageLimit((n) => n + WIKI_IMAGE_BATCH)}>
            그림 더 보기 ({rendered.images - imageLimit}장)
          </button>
        )}
        {page.truncated && <p className="wk-pv-truncated">문서가 길어 앞 300,000자만 보입니다 — Obsidian 에서 여세요.</p>}
      </div>
      <ConfirmDialog
        open={extUrl !== null}
        title="기본 브라우저로 엽니다"
        confirmText="열기"
        confirmIcon={<IconExternal size={16} />}
        onConfirm={() => void openExt()}
        onCancel={() => setExtUrl(null)}
        testId="wiki-ext-confirm"
        confirmTestId="btn-wiki-ext-open"
        cancelTestId="btn-wiki-ext-cancel"
      >
        <span className="wk-ext-note">문서에 적힌 주소입니다. 주소를 확인한 뒤 여세요.</span>
        <span className="wk-ext-url" data-testid="wiki-ext-url">
          {extUrl}
        </span>
      </ConfirmDialog>
    </section>
  );
}

/** 변경 띠(§8-4): 개인 — log 이유 · 줄 수 / 팀 — 줄 수 · 더해진 줄 */
function ChangeBand({ item }: { item: WikiChangeItem }): ReactElement {
  const lines = linesText(item.lines, item.source === 'team' ? ' 줄' : '');
  return (
    <div className="wk-band" data-testid="wiki-change-band">
      {item.source === 'personal' &&
        (item.reasons && item.reasons.length > 0 ? (
          item.reasons.slice(0, 2).map((r, i) => (
            <p key={`${r.date}:${i}`} className="wk-band-reason">
              <span className="wk-band-date">[{r.date}]</span> {r.kind ? `${r.kind} · ` : ''}
              {r.title}
            </p>
          ))
        ) : (
          <p className="wk-band-none">log.md 에 기록 없음</p>
        ))}
      {item.change === 'new' && item.firstLine && <p className="wk-band-sample">{item.firstLine}</p>}
      {lines && <p className="wk-band-lines">{lines}</p>}
      {item.source === 'team' &&
        item.lines?.sample.slice(0, 3).map((s, i) => (
          <p key={`s:${i}`} className="wk-band-sample">
            + {s}
          </p>
        ))}
    </div>
  );
}
