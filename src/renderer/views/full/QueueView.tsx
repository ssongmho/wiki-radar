// 풀스크린 "반영 대기" 화면(2단계 명세 §2·§3): 대기 항목 목록(빼기) · [위키에 반영](확인 대화) · 진행 표시와 로그 · 마지막 결과.
// Claude 는 사람이 [위키에 반영] → 확인 대화의 [반영 시작]을 눌렀을 때만 실행된다.
// 2.14: 메일함에서 넣은 메일(kind mail)은 「출처: 메일」 줄 · [메일 열기] · 이번 반영에서 빠지는 이유(blocked)를 보인다.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { QueueItem, ReflectRun } from '../../../shared/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { getRadar } from '../../api';
import { IconAlert, IconCheck, IconExternal, IconMail, IconUpload } from '../../components/Icons';
import { EmptyState, LoadingState } from '../../components/StateMessage';
import { useNow } from '../../hooks/useNow';
import type { QueueHook, ReflectHook } from '../../hooks/useQueue';
import { cls } from '../../lib/cls';
import { focusLost, refocusIfLost } from '../../lib/focus';
import {
  changedFiles,
  formatElapsed,
  queueMailCount,
  queueSendCounts,
  queueSourceText,
  queueStatusText,
  queueTimeText,
  runElapsed,
  runHeadline,
  runTimeText,
} from '../../lib/queue';

export interface QueueViewProps {
  queue: QueueHook;
  reflect: ReflectHook;
  today: string;
  onOpenFile: (path: string) => void;
  /** 짧은 안내(빼기 실패 등) */
  notify: (message: string) => void;
  /** 반영을 실행할 수 없는 이유(claude 가 없음 — 2.7단계). 있으면 [위키에 반영]을 끈다 */
  unavailable?: string | null;
  /**
   * 바깥(사이드바 '반영 N')에서 이 화면을 열 때마다 늘어난다. 그때(와 처음 그릴 때) 초점이 사라져 있으면 화면 제목으로 옮긴다
   * — 창이 바뀌어 초점이 body 에 있으면 키보드로 쓰는 사람이 자리를 잃는다.
   */
  focusRequest?: number;
  /** 2.14: 메일함에서 그 메일(스레드)을 연다 */
  onOpenMail?: (mailKey: string) => void;
}

const RUN_STATUS_TITLE = 'run-status-title';
const RUN_RESULT_TITLE = 'run-result-title';

function QueueRow({
  item,
  today,
  locked,
  removing,
  onRemove,
  onOpenMail,
}: {
  item: QueueItem;
  today: string;
  locked: boolean;
  removing: boolean;
  onRemove: () => void;
  onOpenMail?: (mailKey: string) => void;
}): ReactElement {
  const time = queueTimeText(item.createdAt, today);
  const headId = `queue-item-${item.id}`;
  const isMail = item.kind === 'mail';
  const source = queueSourceText(item, today);
  return (
    <li
      className={cls('queue-item', locked && 'is-locked')}
      data-testid="queue-item"
      data-queue-id={item.id}
      data-kind={item.kind}
      aria-labelledby={headId}
    >
      <div className="queue-item-body">
        <p id={headId} className="queue-item-title">
          {item.title}
        </p>
        <p className="queue-item-meta">
          <span className="queue-status">{queueStatusText(item)}</span>
          {item.company && <span>{item.company}</span>}
          {time && <span>{time} {isMail ? '넣음' : '저장'}</span>}
          {locked && <span className="queue-running">반영 중</span>}
        </p>
        {source && (
          <p className="queue-item-meta queue-item-source" data-testid="queue-item-source">
            <span>{source}</span>
            {item.mailKey && onOpenMail && (
              <button type="button" className="link-btn" data-testid="btn-queue-open-mail" onClick={() => onOpenMail(item.mailKey as string)}>
                <IconMail size={14} />
                메일 열기
              </button>
            )}
          </p>
        )}
        {item.note ? (
          <p className="queue-item-note">{item.note}</p>
        ) : (
          <p className="empty-note">{isMail ? '메모 없이 메일 내용에서 고릅니다.' : '처리 내용 없이 상태만 넘깁니다.'}</p>
        )}
        {item.blocked && (
          <p className="queue-item-blocked" data-testid="queue-item-blocked">
            <IconAlert size={14} />
            이번 반영에서 빠집니다 — {item.blocked}
          </p>
        )}
      </div>
      <button
        type="button"
        className="btn btn--secondary queue-remove"
        disabled={locked || removing}
        aria-label={`‘${item.title}’ 반영 대기에서 빼기`}
        title={locked ? '반영 중인 항목은 뺄 수 없습니다' : '대기열에서 뺍니다(위키에 이미 저장한 할 일 상태·메모는 그대로입니다)'}
        onClick={onRemove}
      >
        {removing ? '빼는 중…' : '빼기'}
      </button>
    </li>
  );
}

function RunStatus({ run, now, today }: { run: ReflectRun; now: number; today: string }): ReactElement {
  const elapsed = runElapsed(run, now);
  const started = runTimeText(run.startedAt, today);
  const logRef = useRef<HTMLOListElement>(null);
  const lines = run.log.slice(-50);
  // 새 줄이 오면 맨 아래로(사람이 위로 올려 읽는 중이면 두지 않는다)
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <section className="panel run-panel" data-testid="reflect-status" data-state={run.state} aria-labelledby={RUN_STATUS_TITLE}>
      <div className="run-status-head" role="status">
        <span className="state-spinner" aria-hidden="true" />
        <h2 id={RUN_STATUS_TITLE} className="run-title" tabIndex={-1}>
          {runHeadline(run)}
        </h2>
      </div>
      <p className="run-meta">
        {started && <span>{started} 시작</span>}
        {elapsed !== null && <span>시작한 지 {formatElapsed(elapsed)}</span>}
        <span>{run.itemIds.length}건</span>
        <span>최대 15분</span>
      </p>
      {lines.length > 0 ? (
        <ol className="run-log scroll" ref={logRef} aria-label="진행 기록" tabIndex={0}>
          {lines.map((line, i) => (
            <li key={`${i}:${line}`}>{line}</li>
          ))}
        </ol>
      ) : (
        <p className="empty-note">진행 기록을 기다리는 중입니다…</p>
      )}
    </section>
  );
}

function RunResult({ run, today, onOpenFile }: { run: ReflectRun; today: string; onOpenFile: (p: string) => void }): ReactElement {
  const failed = run.state === 'failed';
  const files = changedFiles(run.changed);
  const skipped = run.skipped ?? [];
  const finished = runTimeText(run.finishedAt, today);
  const elapsed = runElapsed(run, Date.now());
  const [logOpen, setLogOpen] = useState(false);
  return (
    <section
      className={cls('panel run-panel', failed && 'run-panel--failed')}
      data-testid="reflect-result"
      data-state={run.state}
      aria-labelledby={RUN_RESULT_TITLE}
    >
      <div className="run-status-head">
        {failed ? <IconAlert size={18} className="tone-coral" /> : <IconCheck size={18} className="tone-amber" />}
        <h2 id={RUN_RESULT_TITLE} className="run-title" tabIndex={-1}>
          마지막 반영: {runHeadline(run)}
        </h2>
      </div>
      <p className="run-meta">
        {finished && <span>{finished} 끝남</span>}
        {elapsed !== null && <span>{formatElapsed(elapsed)} 걸림</span>}
        <span>{run.itemIds.length}건 보냄</span>
      </p>

      {failed && (
        <div className="field">
          <h3 className="field-label">실패 이유</h3>
          <p className="run-error">{run.error ?? '이유가 기록되지 않았습니다. 진행 기록을 확인해 주세요.'}</p>
        </div>
      )}

      {run.summary && (
        <div className="field">
          <h3 className="field-label">요약</h3>
          <p className="field-body">{run.summary}</p>
        </div>
      )}

      {!failed && (
        <div className="field">
          <h3 className="field-label">바뀐 파일 {files.length}개</h3>
          {files.length === 0 ? (
            <p className="empty-note">Claude가 바꿨다고 보고한 파일이 없습니다.</p>
          ) : (
            <ul className="link-list">
              {files.map(({ path, openPath }) => (
                <li key={path}>
                  {openPath ? (
                    <button type="button" className="link-row" title={`${path} — Obsidian에서 열기`} onClick={() => onOpenFile(openPath)}>
                      <span className="link-row-text">
                        <span className="link-row-name">{path}</span>
                      </span>
                      <IconExternal size={14} className="link-row-icon" />
                    </button>
                  ) : (
                    <div className="link-row link-row--static">
                      <span className="link-row-text">
                        <span className="link-row-name">{path}</span>
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {skipped.length > 0 && (
        <div className="field">
          <h3 className="field-label">건너뛴 항목 {skipped.length}건</h3>
          <ul className="skip-list">
            {skipped.map((s, i) => (
              <li key={`${i}:${s.title}`}>
                <span className="skip-title">{s.title}</span>
                <span className="skip-reason">{s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.log.length > 0 && (
        <div className="run-log-wrap">
          <button
            type="button"
            className="link-btn"
            aria-expanded={logOpen}
            aria-controls={logOpen ? 'run-result-log' : undefined}
            onClick={() => setLogOpen((v) => !v)}
          >
            {logOpen ? '진행 기록 접기' : `진행 기록 보기 (${run.log.length}줄)`}
          </button>
          {logOpen && (
            <ol id="run-result-log" className="run-log scroll" aria-label="진행 기록" tabIndex={0}>
              {run.log.map((line, i) => (
                <li key={`${i}:${line}`}>{line}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

export function QueueView({ queue, reflect, today, onOpenFile, notify, unavailable, focusRequest = 0, onOpenMail }: QueueViewProps): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());
  const run = reflect.run;
  const running = run?.state === 'running';
  const now = useNow(running);
  const count = queue.items.length;
  const runningIds = new Set(running ? run.itemIds : []);
  const mailCount = queueMailCount(queue.items);
  const sendCounts = queueSendCounts(queue.items);

  // 2.14 §1-1: 이 버전이 모르는 kind 의 항목(새 버전이 넣은 것) — 그대로 둔다는 한 줄. 옛 preload 면 0
  const [unknownCount, setUnknownCount] = useState(0);
  useEffect(() => {
    const api = getRadar();
    if (!api || typeof api.getQueueUnknownCount !== 'function') return;
    let live = true;
    api.getQueueUnknownCount().then(
      (n) => {
        if (live && typeof n === 'number' && n >= 0) setUnknownCount(n);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [count]);

  // 실행이 끝나면(main 이 처리한 항목을 빼고 알린다) 대기열을 한 번 더 읽는다 — 알림을 놓쳤을 때를 위해.
  const lastState = useRef(run?.state);
  const { refresh } = queue;
  useEffect(() => {
    if (lastState.current === 'running' && run && run.state !== 'running') {
      refresh();
      // 진행 표시가 결과로 바뀌며 그 제목에 있던 초점이 사라졌으면 결과 제목으로
      refocusIfLost(() => document.getElementById(RUN_RESULT_TITLE));
    }
    lastState.current = run?.state;
  }, [run, refresh]);

  const canRun = queue.supported && reflect.supported && !unavailable && count > 0 && !running && !starting;

  const titleRef = useRef<HTMLHeadingElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const reflectBtnRef = useRef<HTMLButtonElement>(null);

  // 사이드바 '반영 N' 으로 열었을 때(창이 바뀌어 초점이 body 에 있다) 화면 제목으로. 내비로 열었으면 초점이 내비에 있어 그대로.
  // 그린 직후(이 효과 안)에 바로 본다 — 나중으로 미루면 그사이 다른 동작으로 떨어진 초점을 엉뚱하게 가져간다.
  useEffect(() => {
    if (focusLost()) titleRef.current?.focus();
  }, [focusRequest]);

  const start = async (): Promise<void> => {
    setConfirming(false);
    if (!canRun) return;
    setStarting(true);
    const problem = await reflect.start();
    setStarting(false);
    if (problem) notify(`위키 반영을 시작하지 못했습니다. (${problem})`);
    // 대화상자가 닫히며 초점을 돌려줄 [위키에 반영]이 실행 중에는 비활성이다 — 진행 표시(끝났으면 결과) 제목으로.
    // 시작하지 못했으면 다시 누를 수 있는 [위키에 반영]으로
    refocusIfLost(
      () =>
        problem
          ? reflectBtnRef.current
          : (document.getElementById(RUN_STATUS_TITLE) ?? document.getElementById(RUN_RESULT_TITLE)),
      () => titleRef.current,
    );
  };

  const remove = async (item: QueueItem): Promise<void> => {
    // 뺀 줄의 [빼기]가 사라지면 초점이 떨어진다 — 같은 자리(다음 줄, 마지막이면 앞 줄)의 [빼기]로, 비었으면 목록 제목으로
    const index = queue.items.findIndex((q) => q.id === item.id);
    setRemoving((prev) => new Set(prev).add(item.id));
    const problem = await queue.remove(item.id);
    setRemoving((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    notify(problem ? `‘${item.title}’을(를) 빼지 못했습니다. (${problem})` : `‘${item.title}’을(를) 반영 대기에서 뺐습니다.`);
    refocusIfLost(
      () => {
        const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-testid="queue-item"]') ?? [])].filter(
          (row) => row.dataset.queueId !== item.id,
        );
        if (rows.length === 0) return null;
        return rows[Math.min(Math.max(index, 0), rows.length - 1)].querySelector<HTMLButtonElement>('.queue-remove');
      },
      () => listTitleRef.current,
    );
  };

  let hint: string;
  if (!queue.supported || !reflect.supported) hint = '이 앱 연결에는 위키 반영 기능이 없습니다.';
  else if (running) hint = '반영이 끝날 때까지 새로 시작할 수 없습니다.';
  else if (unavailable) hint = unavailable;
  else if (count === 0) hint = '대기 중인 항목이 없습니다.';
  else hint = `대기 ${count}건을 한 번에 보냅니다. 한 번에 하나만 실행하고 최대 15분 걸립니다.`;

  return (
    <main className="qv scroll" aria-labelledby="qv-title">
      <div className="qv-inner">
        <header className="qv-head">
          <p className="crumb">
            <span>반영 대기</span>
          </p>
          <h1 id="qv-title" className="detail-title" tabIndex={-1} ref={titleRef}>
            반영 대기 <span className={cls('qv-count', count === 0 && 'is-zero')}>{count}건</span>
          </h1>
          <p className="qv-lead">
            할 일을 저장할 때 ‘위키 지식에도 반영’을 켠 항목과 메일함에서 [위키에 반영]으로 넣은 메일이 여기에 쌓입니다. [위키에 반영]을 누르면 Claude가 관련 업체·주제
            페이지와 log.md에 처리 결과를 반영합니다. 할 일 줄과 메모는 저장할 때 이미 기록했습니다.
          </p>
          <div className="qv-actions">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="btn-reflect"
              ref={reflectBtnRef}
              disabled={!canRun}
              onClick={() => setConfirming(true)}
            >
              <IconUpload size={16} />
              {running || starting ? '반영하는 중…' : '위키에 반영'}
            </button>
            <span className="result-hint">{hint}</span>
          </div>
        </header>

        {(queue.error || reflect.error) && (
          <p className="form-problem" role="alert">
            {queue.error ?? reflect.error}
          </p>
        )}

        {run && running && <RunStatus run={run} now={now} today={today} />}
        {run && !running && <RunResult run={run} today={today} onOpenFile={onOpenFile} />}

        <section className="qv-section" aria-labelledby="qv-list-title">
          <h2 id="qv-list-title" className="sub-title" tabIndex={-1} ref={listTitleRef}>
            <IconUpload size={16} />
            대기 중인 항목
          </h2>
          {!queue.loaded ? (
            <LoadingState text="반영 대기열을 불러오는 중입니다…" />
          ) : count === 0 ? (
            <div className="qv-empty" data-testid="queue-list" data-count={0}>
              <EmptyState title="반영 대기 중인 항목이 없습니다.">
                할 일의 처리 결과를 저장할 때 ‘위키 지식에도 반영’을 켜면 여기에 쌓입니다.
              </EmptyState>
            </div>
          ) : (
            <ul className="queue-list" data-testid="queue-list" data-count={count} aria-label="반영 대기 항목" ref={listRef}>
              {queue.items.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  today={today}
                  locked={runningIds.has(item.id)}
                  removing={removing.has(item.id)}
                  onRemove={() => void remove(item)}
                  onOpenMail={onOpenMail}
                />
              ))}
            </ul>
          )}
          {unknownCount > 0 && (
            <p className="empty-note" data-testid="queue-unknown" data-count={unknownCount}>
              이 버전이 모르는 항목 {unknownCount}건(새 버전에서 넣음) — 그대로 둡니다.
            </p>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirming}
        testId="reflect-confirm"
        title="위키에 반영할까요?"
        confirmText="반영 시작"
        confirmIcon={<IconUpload size={16} />}
        onConfirm={() => void start()}
        onCancel={() => setConfirming(false)}
      >
        <p>
          Claude가 위키 폴더에서 <strong>위키 문서를 직접 고칩니다</strong>. 대기 중인{' '}
          <strong data-testid="reflect-confirm-count" data-count={sendCounts.send}>
            {sendCounts.send}건
          </strong>
          을 한 번에 보내고, 관련 업체·주제 페이지와 log.md에 처리 결과를 반영합니다.
        </p>
        {sendCounts.blocked > 0 && (
          <p data-testid="reflect-confirm-blocked" data-count={sendCounts.blocked}>
            보낼 수 없는 메일 {sendCounts.blocked}건은 이번 반영에서 빠지고 대기열에 남습니다.
          </p>
        )}
        {mailCount > 0 && (
          <p className="dialog-outside" data-testid="reflect-confirm-mail" data-count={mailCount}>
            메일 {mailCount}건(본문·보낸이·첨부 이름)이 함께 Claude Code 로 보내집니다 — 회사 밖으로 나갑니다.
            분량이 크면 일부 메일은 다음 반영으로 미룹니다.
          </p>
        )}
        <ul className="dialog-list">
          <li>raw/ 와 할 일 줄·메모 파일은 고치지 않고, 확신이 없는 항목은 건너뛰고 이유를 남기게 합니다.</li>
          <li>실행은 최대 15분 걸리고, 끝나면 바뀐 파일 목록을 이 화면에 보여 줍니다.</li>
          <li>
            되돌리려면 OneDrive의 버전 기록(파일 오른쪽 클릭 → 버전 기록)에서 이전 판을 되살립니다. 할 일 줄·메모의 저장 전 사본은
            _todo-sync/backup/ 에 있습니다.
          </li>
        </ul>
      </ConfirmDialog>
    </main>
  );
}
