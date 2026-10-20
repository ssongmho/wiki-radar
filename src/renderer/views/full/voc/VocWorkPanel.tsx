// VOC 상세의 V4(2.6단계 명세 §14): 첨부(이미지 [보기] — 썸네일·크게 보기, 그 밖 [내려받기] → [열기]·[폴더에서 보기]) ·
// 작업시간(목록·합계·[작업시간 입력]·내가 넣은 것 [삭제]) · [해결 처리]·[완료(closed)]·[고객 메일 보내기].
// VOC 운영 데이터는 확인 대화상자의 [실행]으로만 바뀐다 — 작업시간 넣기만 대화상자 없이 바로(결과 알림 + main 의 기록).
// 첨부 이름·답변·메일 제목은 서버 값(데이터)이다 — 글자로만 보인다. 이미지는 main 이 파일 머리를 확인해 data URL 로 준 것만 그린다.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { VocAttachment, VocBoard, VocTicket, VocWorkInput, VocWorkLog } from '../../../../shared/types';
import { VOC_WORK_HOURS } from '../../../../shared/voc';
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconClose,
  IconDownload,
  IconExternal,
  IconFile,
  IconFolder,
  IconImage,
  IconMail,
  IconRefresh,
} from '../../../components/Icons';
import type { VocWorkHook } from '../../../hooks/useVocWork';
import { cls } from '../../../lib/cls';
import { dateText, kstDateTimeText, makeActionId, objectParticle, vocStatusLabel } from '../../../lib/voc';
import {
  attachmentKind,
  attachmentSource,
  emailDraftCheck,
  emailTypeLabel,
  fileSizeText,
  vocHoursText,
  workTotal,
  worklogDraftProblem,
  worklogOf,
  type VocWorkNotice,
  type WorklogDraft,
} from '../../../lib/vocWork';
import { VocConfirmDialog } from '../VocTaskPanel';

/** main 이 확인해 준 이미지 data URL 만(그 밖은 그리지 않는다) */
const IMAGE_DATA_RE = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/]+=*$/;

/** 서버 시각(Z 없는 UTC 포함) → KST 표시 */
function utcText(iso: string | undefined, today: string): string {
  if (!iso) return '';
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  return kstDateTimeText(withZone, today);
}

// ── 이미지 크게 보기 ──

function ImageZoom({ image, onClose }: { image: { src: string; name: string } | null; onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (image && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
      closeRef.current?.focus();
    } else if (!image && d.open) d.close();
  }, [image]);
  return (
    <dialog
      ref={ref}
      className="dialog dialog--wide vv-zoom"
      data-testid={image ? 'voc-file-zoom' : undefined}
      aria-label={image ? `${image.name} 크게 보기` : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {image && (
        <div className="dialog-inner">
          <div className="vv-zoom-head">
            <h2 className="dialog-title vv-zoom-title">{image.name}</h2>
            <button type="button" className="icon-btn" ref={closeRef} aria-label="크게 보기 닫기" onClick={onClose}>
              <IconClose size={16} />
            </button>
          </div>
          <img className="vv-zoom-img" src={image.src} alt={image.name} />
        </div>
      )}
    </dialog>
  );
}

// ── 첨부 ──

function AttachmentRow({
  ticketId,
  a,
  work,
  onZoom,
}: {
  ticketId: number;
  a: VocAttachment;
  work: VocWorkHook;
  onZoom: (img: { src: string; name: string }) => void;
}): ReactElement {
  const kind = attachmentKind(a);
  const state = work.fileOf(ticketId, a.id);
  const loading = state?.status === 'loading';
  const ready = state?.status === 'ready' ? state.result : undefined;
  const src = ready?.dataUrl && IMAGE_DATA_RE.test(ready.dataUrl) ? ready.dataUrl : undefined;
  const [openError, setOpenError] = useState<string | null>(null);
  const open = async (how: 'open' | 'reveal'): Promise<void> => {
    setOpenError(await work.openFile(ticketId, a.id, how));
  };
  return (
    <li className="vv-file" data-testid="voc-attachment" data-file-id={a.id} data-kind={kind}>
      <div className="vv-file-main">
        {kind === 'image' ? <IconImage size={16} /> : <IconFile size={16} />}
        <span className="vv-file-name">{a.fileName}</span>
        <span className="vv-file-meta">
          {fileSizeText(a.fileSize)} · {attachmentSource(a)}
        </span>
      </div>
      <div className="vv-file-actions">
        {kind === 'image' ? (
          !src && (
            <button
              type="button"
              className="btn btn--secondary vv-small-btn"
              data-testid="btn-voc-file-view"
              disabled={loading || !work.supported}
              onClick={() => work.getFile(ticketId, a.id, 'preview')}
            >
              <IconImage size={14} />
              {loading ? '받는 중…' : '보기'}
            </button>
          )
        ) : !ready ? (
          <button
            type="button"
            className="btn btn--secondary vv-small-btn"
            data-testid="btn-voc-file-download"
            disabled={loading || !work.supported}
            onClick={() => work.getFile(ticketId, a.id, 'download')}
          >
            <IconDownload size={14} />
            {loading ? '받는 중…' : '내려받기'}
          </button>
        ) : (
          <>
            {ready.canOpen && (
              <button type="button" className="btn btn--secondary vv-small-btn" data-testid="btn-voc-file-open" onClick={() => void open('open')}>
                <IconExternal size={14} />
                열기
              </button>
            )}
            <button type="button" className="btn btn--secondary vv-small-btn" data-testid="btn-voc-file-reveal" onClick={() => void open('reveal')}>
              <IconFolder size={14} />
              폴더에서 보기
            </button>
          </>
        )}
      </div>
      {src && (
        <button type="button" className="vv-thumb" aria-label={`${a.fileName} 크게 보기`} onClick={() => onZoom({ src, name: a.fileName })}>
          <img data-testid="voc-file-preview" src={src} alt={a.fileName} />
        </button>
      )}
      {ready && !ready.canOpen && kind !== 'image' && (
        <p className="vv-file-note">이 형식은 앱에서 열지 않습니다 — 폴더에서 보고 확인한 뒤 여세요.</p>
      )}
      {state?.status === 'error' && (
        <p className="form-problem" role="alert">
          {state.message}
        </p>
      )}
      {openError && (
        <p className="form-problem" role="alert">
          {openError}
        </p>
      )}
    </li>
  );
}

function Attachments({ ticket, work }: { ticket: VocTicket; work: VocWorkHook }): ReactElement {
  const entry = work.detailOf(ticket.id);
  const loading = entry?.status === 'loading';
  const list = entry?.value?.attachments;
  const [zoom, setZoom] = useState<{ src: string; name: string } | null>(null);
  return (
    <section className="vv-section" aria-labelledby="voc-files-title">
      <div className="vv-section-head">
        <h2 id="voc-files-title" className="sub-title">
          <IconFile size={16} />
          첨부
        </h2>
        <span className="vv-section-note">{list ? `${list.length}개` : ''}</span>
        <button
          type="button"
          className="btn btn--secondary vv-small-btn"
          data-testid="btn-voc-attachments"
          disabled={loading || !work.supported}
          onClick={() => void work.loadDetail(ticket.id)}
        >
          <IconRefresh size={14} />
          {loading ? '받는 중…' : list ? '다시 받기' : '첨부 보기'}
        </button>
      </div>
      {entry?.status === 'error' && (
        <p className="form-problem" role="alert">
          첨부 목록을 받지 못했습니다. ({entry.message})
        </p>
      )}
      {list ? (
        list.length === 0 ? (
          <p className="empty-note" data-testid="voc-attachments" data-count={0}>
            요청·답변에 첨부가 없습니다.
          </p>
        ) : (
          <ul className="vv-file-list" data-testid="voc-attachments" data-count={list.length}>
            {list.map((a) => (
              <AttachmentRow key={a.id} ticketId={ticket.id} a={a} work={work} onZoom={setZoom} />
            ))}
          </ul>
        )
      ) : (
        !loading &&
        entry?.status !== 'error' && (
          <p className="empty-note">[첨부 보기]를 누르면 요청·답변의 첨부 목록을 받습니다. 이미지는 앱 안에서 보고, 그 밖은 앱 데이터 폴더에 내려받습니다.</p>
        )
      )}
      <ImageZoom image={zoom} onClose={() => setZoom(null)} />
    </section>
  );
}

// ── 작업시간 ──

function HoursSelect({ id, testId, value, disabled, onChange }: { id: string; testId: string; value: string; disabled?: boolean; onChange: (v: string) => void }): ReactElement {
  return (
    <select id={id} className="text-input vv-select vv-hours" data-testid={testId} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">시간</option>
      {VOC_WORK_HOURS.map((h) => (
        <option key={h} value={String(h)}>
          {vocHoursText(h)}
        </option>
      ))}
    </select>
  );
}

/** 해결·완료 대화상자 안의 작업시간 칸(작업시간이 0건일 때 필수) */
function WorklogFields({ prefix, draft, today, onChange }: { prefix: string; draft: WorklogDraft; today: string; onChange: (d: WorklogDraft) => void }): ReactElement {
  return (
    <div className="vv-worklog-form">
      <HoursSelect id={`${prefix}-hours`} testId={`${prefix}-hours`} value={draft.hours} onChange={(hours) => onChange({ ...draft, hours })} />
      <input
        id={`${prefix}-date`}
        className="text-input vv-date"
        type="date"
        data-testid={`${prefix}-date`}
        aria-label="작업일"
        max={today}
        value={draft.date}
        onChange={(e) => onChange({ ...draft, date: e.target.value })}
      />
      <input
        id={`${prefix}-note`}
        className="text-input vv-worklog-note"
        data-testid={`${prefix}-note`}
        aria-label="작업 메모"
        placeholder="메모(선택)"
        maxLength={500}
        value={draft.note}
        onChange={(e) => onChange({ ...draft, note: e.target.value })}
      />
    </div>
  );
}

function WorkLogs({
  ticket,
  today,
  meId,
  work,
  locked,
  onDelete,
}: {
  ticket: VocTicket;
  today: string;
  meId?: number;
  work: VocWorkHook;
  locked: boolean;
  onDelete: (log: VocWorkLog) => void;
}): ReactElement {
  const entry = work.workLogsOf(ticket.id);
  const loading = entry?.status === 'loading';
  const logs = entry?.value;
  const [draft, setDraft] = useState<WorklogDraft>({ hours: '', date: today, note: '' });
  const [tried, setTried] = useState(false);
  const busyKind = work.busy.get(ticket.id);
  const problem = worklogDraftProblem(draft, today);

  const add = async (): Promise<void> => {
    setTried(true);
    if (problem || locked) return;
    const r = await work.run({ actionId: makeActionId(), kind: 'worklogAdd', ticketId: ticket.id, worklog: worklogOf(draft) }, ticket);
    if (r?.ok) {
      setDraft({ hours: '', date: today, note: '' });
      setTried(false);
    }
  };

  return (
    <section className="vv-section" aria-labelledby="voc-worklogs-title">
      <div className="vv-section-head">
        <h2 id="voc-worklogs-title" className="sub-title">
          <IconClock size={16} />
          작업시간
        </h2>
        <span className="vv-section-note">{logs ? `${logs.length}건 · 합계 ${vocHoursText(workTotal(logs))}` : ''}</span>
        <button
          type="button"
          className="btn btn--secondary vv-small-btn"
          data-testid="btn-voc-worklogs"
          disabled={loading || !work.supported}
          onClick={() => void work.loadWorkLogs(ticket.id)}
        >
          <IconRefresh size={14} />
          {loading ? '받는 중…' : logs ? '다시 받기' : '작업시간 보기'}
        </button>
      </div>
      {entry?.status === 'error' && (
        <p className="form-problem" role="alert">
          작업시간을 받지 못했습니다. ({entry.message})
        </p>
      )}
      {logs &&
        (logs.length === 0 ? (
          <p className="empty-note" data-testid="voc-worklogs" data-count={0} data-total={0}>
            작업시간이 없습니다. 해결·완료하려면 1건 이상 있어야 합니다.
          </p>
        ) : (
          <ul className="vv-worklog-list" data-testid="voc-worklogs" data-count={logs.length} data-total={workTotal(logs)}>
            {logs.map((w) => (
              <li key={w.id} className="vv-worklog" data-testid="voc-worklog" data-worklog-id={w.id}>
                <span className="vv-worklog-date">{dateText(w.workDate, today)}</span>
                <span className="vv-worklog-who">{w.userName ?? '—'}</span>
                <span className="vv-worklog-hours">{vocHoursText(w.hours)}</span>
                <span className="vv-worklog-note">{w.note ?? ''}</span>
                {meId !== undefined && w.userId === meId ? (
                  <button
                    type="button"
                    className="link-btn vv-worklog-delete"
                    data-testid="btn-voc-worklog-delete"
                    disabled={locked || !!busyKind}
                    aria-label={`${dateText(w.workDate, today)} ${vocHoursText(w.hours)} 작업시간 삭제`}
                    onClick={() => onDelete(w)}
                  >
                    삭제
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        ))}
      <div className="vv-worklog-add">
        <label htmlFor="voc-worklog-hours" className="field-label">
          작업시간 입력
        </label>
        <div className="vv-worklog-form">
          <HoursSelect
            id="voc-worklog-hours"
            testId="voc-worklog-hours"
            value={draft.hours}
            disabled={busyKind === 'worklogAdd'}
            onChange={(hours) => setDraft({ ...draft, hours })}
          />
          <input
            className="text-input vv-date"
            type="date"
            data-testid="voc-worklog-date"
            aria-label="작업일"
            max={today}
            disabled={busyKind === 'worklogAdd'}
            value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          />
          <input
            className="text-input vv-worklog-note"
            data-testid="voc-worklog-note"
            aria-label="작업 메모"
            placeholder="메모(선택)"
            maxLength={500}
            disabled={busyKind === 'worklogAdd'}
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          />
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-worklog-add"
            disabled={locked || !!busyKind || !work.supported || (tried && !!problem)}
            onClick={() => void add()}
          >
            <IconCheck size={14} />
            {busyKind === 'worklogAdd' ? '넣는 중…' : '작업시간 입력'}
          </button>
        </div>
        {tried && problem ? (
          <p className="form-problem" role="alert">
            {problem}
          </p>
        ) : (
          <p className="result-hint">누르면 바로 VOC 에 넣습니다(공수 통계에 잡힙니다). 내가 넣은 것은 [삭제]로 지울 수 있습니다.</p>
        )}
      </div>
    </section>
  );
}

// ── 해결·완료·고객 메일 ──

type Dialog =
  | { kind: 'resolve' | 'close'; actionId: string; status: string }
  | { kind: 'email'; actionId: string; status: string; step: 'edit' | 'confirm' }
  | { kind: 'worklogDelete'; actionId: string; log: VocWorkLog };

export interface VocWorkPanelProps {
  ticket: VocTicket;
  today: string;
  board: VocBoard | null;
  /** 쓰기를 막는 이유(로그인 필요 등). 없으면 null */
  writeBlock: string | null;
  /** 담당·일정 바꾸기가 이 티켓에서 실행 중 */
  otherBusy: boolean;
  work: VocWorkHook;
}

export function VocWorkPanel({ ticket, today, board, writeBlock, otherBusy, work }: VocWorkPanelProps): ReactElement {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [hours, setHours] = useState<WorklogDraft>({ hours: '', date: today, note: '' });
  const [emailOn, setEmailOn] = useState(false);
  /** null = 손대지 않음(고객 메일 주소 기본값을 보인다) */
  const [toText, setToText] = useState<string | null>(null);
  const [ccText, setCcText] = useState('');
  /** null = 손대지 않음(답변 전부) */
  const [chosen, setChosen] = useState<ReadonlySet<number> | null>(null);
  const [mailResolve, setMailResolve] = useState(false);

  const busyKind = work.busy.get(ticket.id);
  const locked = !!writeBlock || otherBusy || !!busyKind || !work.supported;
  const noOwner = ticket.assigneeId === undefined;
  const meId = board?.me?.id;
  const number = ticket.number;

  const detailEntry = work.detailOf(ticket.id);
  const detail = detailEntry?.value;
  const replies = detail ? [...detail.replies].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id)) : [];
  const logsEntry = work.workLogsOf(ticket.id);
  const logsKnown = logsEntry?.status === 'ready' || (logsEntry?.status === 'error' && logsEntry.value !== undefined) ? logsEntry.value : undefined;
  const logsLoading = logsEntry?.status === 'loading';

  const defaultTo = (detail?.customerEmails ?? []).join(', ');
  const to = toText ?? defaultTo;
  const chosenIds = chosen ?? new Set(replies.map((r) => r.id));

  const open = (d: Dialog): void => {
    setHours({ hours: '', date: today, note: '' });
    setEmailOn(false);
    setToText(null);
    setCcText('');
    setChosen(null);
    setMailResolve(false);
    setDialog(d);
    if (d.kind === 'resolve' || d.kind === 'close') void work.loadWorkLogs(ticket.id);
    if (d.kind === 'email') {
      void work.loadDetail(ticket.id);
      void work.loadEmailLogs(ticket.id);
    }
  };

  // 해결 대화상자에서 메일을 켜거나, 메일 대화상자에서 해결을 켜면 필요한 것을 받는다
  const toggleResolveEmail = (on: boolean): void => {
    setEmailOn(on);
    if (on && !detail && detailEntry?.status !== 'loading') void work.loadDetail(ticket.id);
  };
  const toggleMailResolve = (on: boolean): void => {
    setMailResolve(on);
    if (on && !logsKnown && !logsLoading) void work.loadWorkLogs(ticket.id);
  };

  const run = (input: VocWorkInput): void => {
    setDialog(null);
    void work.run(input, ticket);
  };

  // ---- 대화상자 내용 ----
  let title = '';
  let confirmText = '실행';
  let confirmDisabled = false;
  let body: ReactElement | null = null;
  let onConfirm = (): void => {};
  let kindAttr = 'resolve';
  let wide = false;

  if (dialog?.kind === 'resolve' || dialog?.kind === 'close') {
    const resolve = dialog.kind === 'resolve';
    const label = resolve ? '해결(resolved)' : '완료(closed)';
    kindAttr = dialog.kind;
    wide = true;
    title = resolve ? 'VOC 를 해결 처리할까요?' : 'VOC 를 완료(closed) 처리할까요?';
    confirmText = resolve ? (emailOn ? '해결하고 메일 보내기' : '해결 처리') : '완료 처리';
    const needHours = logsKnown !== undefined && logsKnown.length === 0;
    const hoursProblem = needHours ? worklogDraftProblem(hours, today) : null;
    const emailCheck = resolve && emailOn ? emailDraftCheck(to, ccText, replies.length, replies.length) : null;
    const detailReady = !emailOn || detailEntry?.status === 'ready';
    confirmDisabled = logsKnown === undefined || !!hoursProblem || (emailOn && (!detailReady || !!emailCheck?.problem)) || locked;
    onConfirm = () => {
      if (confirmDisabled) return;
      const input: VocWorkInput = { actionId: dialog.actionId, kind: dialog.kind, ticketId: ticket.id, expectedStatus: dialog.status };
      if (needHours) input.worklog = worklogOf(hours);
      if (resolve && emailOn && emailCheck) input.email = { to: emailCheck.to, cc: emailCheck.cc, replyIds: replies.map((r) => r.id) };
      run(input);
    };
    body = (
      <>
        <p className="voc-confirm-subject">
          {number} · {ticket.title}
        </p>
        <p>
          <strong>
            {number}
            {objectParticle(number)} {label} 처리합니다.
          </strong>{' '}
          VOC 상태가 {vocStatusLabel(dialog.status)}에서 {resolve ? '해결' : '완료'}로 바뀌고 보드에서 빠집니다.
        </p>
        <div className="confirm-section" data-testid="voc-resolve-worklogs" data-count={logsKnown?.length ?? ''}>
          <p className="field-label">작업시간</p>
          {logsLoading && logsKnown === undefined ? (
            <p className="empty-note">작업시간을 받는 중입니다…</p>
          ) : logsEntry?.status === 'error' && logsKnown === undefined ? (
            <p className="form-problem" role="alert">
              작업시간을 받지 못했습니다. ({logsEntry.message})
            </p>
          ) : logsKnown && logsKnown.length > 0 ? (
            <p>
              지금 {logsKnown.length}건 · 합계 {vocHoursText(workTotal(logsKnown))} — 선행조건(담당·작업시간)을 갖췄습니다.
            </p>
          ) : (
            <>
              <p className="tone-amber">작업시간이 없습니다. {resolve ? '해결' : '완료'}하려면 시간을 먼저 넣어야 합니다 — 아래 시간을 넣은 뒤 처리합니다.</p>
              <WorklogFields prefix="voc-resolve" draft={hours} today={today} onChange={setHours} />
              {hoursProblem && hours.hours !== '' && <p className="form-problem">{hoursProblem}</p>}
            </>
          )}
        </div>
        {resolve && (
          <div className="confirm-section">
            <label className="vv-check">
              <input type="checkbox" data-testid="voc-resolve-email" checked={emailOn} onChange={(e) => toggleResolveEmail(e.target.checked)} />
              <span className="vv-check-text">고객에게 해결 안내 메일도 보내기</span>
            </label>
            {emailOn && (
              <>
                {detailEntry?.status === 'loading' && <p className="empty-note">고객 주소·답변을 받는 중입니다…</p>}
                <label className="field-label" htmlFor="voc-resolve-to">
                  받는 사람
                </label>
                <input id="voc-resolve-to" className="text-input" data-testid="voc-resolve-to" value={to} onChange={(e) => setToText(e.target.value)} />
                <label className="field-label" htmlFor="voc-resolve-cc">
                  참조
                </label>
                <input id="voc-resolve-cc" className="text-input" data-testid="voc-resolve-cc" value={ccText} onChange={(e) => setCcText(e.target.value)} />
                <p className="tone-amber">
                  <strong>고객에게 메일이 나갑니다</strong> — 종결 안내 메일에 답변 {replies.length}건을 모두 담습니다(제목·본문은 VOC 서버가 만듭니다).
                </p>
                {emailCheck?.problem && <p className="form-problem">{emailCheck.problem}</p>}
              </>
            )}
            {!emailOn && <p className="vv-file-note">고객에게는 메일이 가지 않습니다.</p>}
          </div>
        )}
      </>
    );
  } else if (dialog?.kind === 'email') {
    kindAttr = 'email';
    wide = true;
    const check = emailDraftCheck(to, ccText, replies.length, chosenIds.size);
    const needHours = mailResolve && logsKnown !== undefined && logsKnown.length === 0;
    const hoursProblem = needHours ? worklogDraftProblem(hours, today) : null;
    const ready = detailEntry?.status === 'ready';
    const resolveBlocked = mailResolve && (noOwner || logsKnown === undefined);
    const emailLogs = work.emailLogsOf(ticket.id);
    const picked = replies.filter((r) => chosenIds.has(r.id));
    if (dialog.step === 'edit') {
      title = '고객에게 메일을 보낼까요?';
      confirmText = '다음';
      confirmDisabled = !ready || !!check.problem || !!hoursProblem || resolveBlocked || locked;
      onConfirm = () => {
        if (!confirmDisabled) setDialog({ ...dialog, step: 'confirm' });
      };
      body = (
        <>
          <p className="voc-confirm-subject">
            {number} · {ticket.title}
          </p>
          {detailEntry?.status === 'loading' && <p className="empty-note">고객 주소·답변을 받는 중입니다…</p>}
          {detailEntry?.status === 'error' && (
            <p className="form-problem" role="alert">
              티켓을 받지 못했습니다. ({detailEntry.message})
            </p>
          )}
          <label className="field-label" htmlFor="voc-email-to">
            받는 사람
          </label>
          <input id="voc-email-to" className="text-input" data-testid="voc-email-to" value={to} onChange={(e) => setToText(e.target.value)} />
          <label className="field-label" htmlFor="voc-email-cc">
            참조
          </label>
          <input id="voc-email-cc" className="text-input" data-testid="voc-email-cc" value={ccText} onChange={(e) => setCcText(e.target.value)} />
          <fieldset className="vv-settings-group">
            <legend className="field-label">메일에 담을 답변</legend>
            {replies.length === 0 ? (
              <p className="empty-note">답변이 없습니다(티켓 내용만 담깁니다).</p>
            ) : (
              <ul className="vv-mail-replies">
                {replies.map((r) => (
                  <li key={r.id}>
                    <label className="vv-check">
                      <input
                        type="checkbox"
                        data-testid="voc-email-reply"
                        data-reply-id={r.id}
                        checked={chosenIds.has(r.id)}
                        onChange={(e) => {
                          const next = new Set(chosenIds);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setChosen(next);
                        }}
                      />
                      <span className="vv-check-text">
                        <span className="vv-mail-reply-head">
                          {r.authorName ?? '작성자 없음'} · {kstDateTimeText(r.createdAt, today)}
                        </span>
                        <span className="vv-mail-reply-text">{r.text.trim().slice(0, 120) || '(내용 없음)'}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <label className="vv-check">
            <input type="checkbox" data-testid="voc-email-resolve" checked={mailResolve} onChange={(e) => toggleMailResolve(e.target.checked)} />
            <span className="vv-check-text">해결 처리하며 보내기(상태를 해결로 바꾸고 종결 안내 메일)</span>
          </label>
          {mailResolve && noOwner && <p className="form-problem">담당자가 없어 해결할 수 없습니다 — 먼저 담당을 지정하세요.</p>}
          {needHours && (
            <>
              <p className="tone-amber">작업시간이 없습니다. 해결하려면 시간을 먼저 넣어야 합니다.</p>
              <WorklogFields prefix="voc-email-worklog" draft={hours} today={today} onChange={setHours} />
              {hoursProblem && hours.hours !== '' && <p className="form-problem">{hoursProblem}</p>}
            </>
          )}
          {ready && check.problem && <p className="form-problem">{check.problem}</p>}
          <div className="confirm-section" data-testid="voc-email-logs" data-count={emailLogs?.value?.length ?? ''}>
            <p className="field-label">발송 기록</p>
            {emailLogs?.status === 'loading' && !emailLogs.value && <p className="empty-note">받는 중…</p>}
            {emailLogs?.status === 'error' && <p className="form-problem">발송 기록을 받지 못했습니다. ({emailLogs.message})</p>}
            {emailLogs?.value &&
              (emailLogs.value.length === 0 ? (
                <p className="empty-note">보낸 메일이 없습니다.</p>
              ) : (
                <ul className="vv-mail-logs">
                  {emailLogs.value.slice(0, 10).map((l) => (
                    <li key={l.id} data-testid="voc-email-log" className={cls(l.status === 'failed' && 'tone-coral')}>
                      {utcText(l.sentAt, today)} · {emailTypeLabel(l.emailType)} · {l.to.join(', ')}
                      {l.status === 'failed' ? ' · 실패' : ''}
                      {l.sentByName ? ` · ${l.sentByName}` : ''}
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        </>
      );
    } else {
      title = '고객에게 메일이 나갑니다';
      confirmText = mailResolve ? '해결하고 메일 보내기' : '메일 보내기';
      confirmDisabled = locked;
      onConfirm = () => {
        if (confirmDisabled) return;
        const input: VocWorkInput = {
          actionId: dialog.actionId,
          kind: mailResolve ? 'resolve' : 'email',
          ticketId: ticket.id,
          expectedStatus: dialog.status,
          email: { to: check.to, cc: check.cc, replyIds: picked.map((r) => r.id) },
        };
        if (needHours) input.worklog = worklogOf(hours);
        run(input);
      };
      body = (
        <div data-testid="voc-email-summary">
          <p className="voc-confirm-subject">
            {number} · {ticket.title}
          </p>
          <p>
            <strong>고객에게 메일이 나갑니다.</strong> 되돌릴 수 없습니다. 제목·본문은 VOC 서버가 티켓 내용과 고른 답변으로 만듭니다.
          </p>
          <ul className="dialog-list">
            <li>받는 사람: {check.to.join(', ')}</li>
            {check.cc.length > 0 && <li>참조: {check.cc.join(', ')}</li>}
            <li>
              포함 답변 {picked.length}건{replies.length > 0 ? ` (전체 ${replies.length}건 중)` : ''}
            </li>
            <li>{mailResolve ? '상태를 해결(resolved)로 바꾸고 종결 안내 메일로 보냅니다.' : '진행 안내 메일로 보냅니다(상태는 그대로).'}</li>
            {needHours && <li>보내기 전에 작업시간 {vocHoursText(Number(hours.hours))}을 넣습니다.</li>}
          </ul>
        </div>
      );
    }
  } else if (dialog?.kind === 'worklogDelete') {
    kindAttr = 'worklogDelete';
    title = '작업시간을 지울까요?';
    confirmText = '삭제';
    confirmDisabled = locked;
    const log = dialog.log;
    onConfirm = () => {
      if (!confirmDisabled) run({ actionId: dialog.actionId, kind: 'worklogDelete', ticketId: ticket.id, workLogId: log.id });
    };
    body = (
      <>
        <p className="voc-confirm-subject">
          {number} · {ticket.title}
        </p>
        <p>
          <strong>
            {dateText(log.workDate, today)} {vocHoursText(log.hours)}
            {log.note ? ` · ${log.note}` : ''}
          </strong>{' '}
          작업시간을 VOC 에서 지웁니다. 되돌릴 수 없습니다(내가 넣은 것만 지울 수 있습니다).
        </p>
      </>
    );
  }

  let hint: string;
  if (writeBlock) hint = writeBlock;
  else if (busyKind || otherBusy) hint = 'VOC 에 보내는 중입니다. 끝날 때까지 이 티켓의 다른 동작은 막아 둡니다.';
  else if (noOwner) hint = '담당자가 없어 해결·완료할 수 없습니다 — 먼저 담당을 지정하세요.';
  else hint = '해결·완료·메일은 확인 대화상자에서 한 번 더 확인합니다. 해결·완료는 담당자와 작업시간 1건 이상이 있어야 합니다.';

  return (
    <>
      <Attachments ticket={ticket} work={work} />
      <WorkLogs
        ticket={ticket}
        today={today}
        meId={meId}
        work={work}
        locked={locked}
        onDelete={(log) => open({ kind: 'worklogDelete', actionId: makeActionId(), log })}
      />
      <section className="panel vv-actions" aria-labelledby="voc-finish-title" aria-busy={!!busyKind}>
        <h2 id="voc-finish-title" className="result-form-title">
          해결·고객 메일
        </h2>
        <div className="vv-finish-buttons">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="btn-voc-resolve"
            disabled={locked || noOwner}
            onClick={() => open({ kind: 'resolve', actionId: makeActionId(), status: ticket.status })}
          >
            <IconCheck size={16} />
            {busyKind === 'resolve' ? '처리하는 중…' : '해결 처리'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-close"
            disabled={locked || noOwner}
            onClick={() => open({ kind: 'close', actionId: makeActionId(), status: ticket.status })}
          >
            {busyKind === 'close' ? '처리하는 중…' : '완료(closed)'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-email"
            disabled={locked}
            onClick={() => open({ kind: 'email', actionId: makeActionId(), status: ticket.status, step: 'edit' })}
          >
            <IconMail size={16} />
            {busyKind === 'email' ? '보내는 중…' : '고객 메일 보내기'}
          </button>
        </div>
        <p className={cls('result-hint vv-actions-hint', (writeBlock || noOwner) && 'tone-amber')} data-testid="voc-finish-hint">
          {hint}
        </p>
      </section>

      <VocConfirmDialog
        open={dialog !== null}
        kind={kindAttr}
        wide={wide}
        title={title}
        confirmText={confirmText}
        confirmDisabled={confirmDisabled}
        onConfirm={onConfirm}
        onCancel={() => setDialog(null)}
      >
        {body}
      </VocConfirmDialog>
    </>
  );
}

// ── 결과 알림(해결·완료 뒤 [재오픈]) ──

const AUTO_HIDE_MS = 12_000;

export function VocWorkNoticeView({
  notice,
  onClose,
  onReopen,
}: {
  notice: VocWorkNotice;
  onClose: () => void;
  onReopen: (r: NonNullable<VocWorkNotice['reopen']>) => void;
}): ReactElement {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // [재오픈]이 있는 알림은 사람이 닫을 때까지 둔다
    if (notice.tone !== 'ok' || notice.reopen) return;
    const timer = window.setTimeout(() => closeRef.current(), AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.tone, notice.reopen]);
  const isError = notice.tone === 'error';
  return (
    <div
      className={cls('save-notice', isError ? 'save-notice--error' : 'save-notice--ok')}
      data-testid="voc-action-notice"
      data-tone={notice.tone}
      data-kind={notice.kind}
      role={isError ? 'alert' : 'status'}
    >
      <div className="save-notice-head">
        {isError ? <IconAlert size={16} /> : <IconCheck size={16} />}
        <p className="save-notice-title">{notice.title}</p>
        <button type="button" className="icon-btn save-notice-close" aria-label="VOC 결과 알림 닫기" onClick={onClose}>
          <IconClose size={16} />
        </button>
      </div>
      {notice.lines.length > 0 && (
        <ul className="save-notice-lines">
          {notice.lines.map((line, i) => (
            <li key={`${i}:${line}`} className={cls(isError && 'is-warn')}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {notice.reopen && (
        <div className="vv-notice-actions">
          <button type="button" className="btn btn--secondary vv-small-btn" data-testid="btn-voc-reopen" onClick={() => notice.reopen && onReopen(notice.reopen)}>
            <IconRefresh size={14} />
            재오픈
          </button>
        </div>
      )}
    </div>
  );
}
