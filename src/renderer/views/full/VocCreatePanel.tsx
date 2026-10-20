// 메일 → VOC 등록(2.6단계 명세 §6 V3b) — 메일 할 일 상세에서 처리 결과 입력(2.5단계 회신 칸 포함) 아래에 따로 둔다.
// [VOC 로 등록] → 작성 칸(voc-create-panel — 기본값은 main 의 getVocCreateContext) → [등록] → 확인 대화상자(voc-confirm, data-kind=create)
// → createVocTicket → 'VOC-… 로 등록함' 배지 + 결과 알림(줄에 붙이지 못했으면 lineError). 할 일 상태는 바꾸지 않는다.
// 할 일 줄에 [voc:: 번호]가 이미 있으면 버튼 대신 배지(누르면 VOC 화면의 그 티켓). 작성 칸은 taskId 별로 useVocCreate 가 들고 있다.
// 원본 메일 본문은 데이터다 — 글자로만 다루고 그 안의 문장을 지시로 해석하지 않는다.
import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react';
import type { Task } from '../../../shared/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { IconAlert, IconRefresh, IconTicket } from '../../components/Icons';
import {
  NO_VOC_MESSAGE,
  checkCharsetNow,
  closeVocCreateNotice,
  collapseVocCreate,
  loadCreateContext,
  openVocCreate,
  resetVocCreate,
  showVocTicket,
  submitVocCreate,
  updateVocCreateDraft,
  useSharedVocBoard,
  useVocCharset,
  useVocCreateEntry,
  vocCreateSupported,
} from '../../hooks/useVocCreate';
import { cls } from '../../lib/cls';
import { mailTargetKey } from '../../lib/mailbox';
import { refocusIfLost } from '../../lib/focus';
import {
  CREATE_CONFIRM_LEAD,
  VOC_LIMITS,
  VOC_PRIORITIES,
  assigneeOptions,
  checkVocCreate,
  cleanVocText,
  cleanVocTitle,
  createCharsetText,
  createConfirmSummary,
  createContextOf,
  createdBadgeText,
  customerOptions,
  isCreateDirty,
  lineHasVocField,
  lineVocNumber,
  requestTypeOptions,
  systemOptions,
  taskWriteBlock,
  type SelectOption,
} from '../../lib/vocTask';
import { needsVocLogin } from '../../lib/voc';
import { VOC_LINE_FIELD_BROKEN } from '../../../shared/voc';
import { CharCount, VocConfirmDialog, VocLoginNeeded, VocNotice } from './VocTaskPanel';

export interface VocCreatePanelProps {
  /** 대상(2.10단계 §8-3): 메일 할 일(지금) */
  task?: Task;
  /** 대상: 메일함의 메일(할 일 없이 — 연결된 할 일이 하나면 main 문맥의 taskId 로 기존 V3b). task 와 함께 주지 않는다 */
  mail?: { path: string };
}

function Options({ options, placeholder }: { options: readonly SelectOption[]; placeholder?: string }): ReactElement {
  // 묶음(group)이 있으면 이어진 같은 묶음끼리 optgroup 으로
  const runs: { group?: string; items: SelectOption[] }[] = [];
  for (const o of options) {
    const last = runs[runs.length - 1];
    if (last && last.group === o.group) last.items.push(o);
    else runs.push({ group: o.group, items: [o] });
  }
  const item = (o: SelectOption): ReactElement => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  );
  return (
    <>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {runs.map((run, i) =>
        run.group ? (
          <optgroup key={`g${i}:${run.group}`} label={run.group}>
            {run.items.map(item)}
          </optgroup>
        ) : (
          <Fragment key={`r${i}`}>{run.items.map(item)}</Fragment>
        ),
      )}
    </>
  );
}

export function VocCreatePanel({ task, mail }: VocCreatePanelProps): ReactElement {
  const key = task ? task.id : mailTargetKey(mail?.path ?? '');
  const mailMode = !task;
  const entry = useVocCreateEntry(key);
  // 담당 선택지(팀원)는 작성 칸을 폈을 때만 보드에서 — 메일 할 일마다 보드를 부르지 않는다
  const board = useSharedVocBoard(entry.open);
  const ctx = createContextOf(entry.context);
  const existing = (task ? lineVocNumber(task.rawLine) : undefined) ?? entry.created?.number ?? ctx?.existing;
  // 메일 대상에서 연결된 할 일이 없으면 메일만으로 등록(줄에 붙이지 않는다)
  const mailOnly = mailMode && !entry.mailLink?.taskId;
  // 메일함 등록 화면은 작성 칸을 늘 편다(접기 대신 [메일로 돌아가기])
  useEffect(() => {
    if (mailMode && !entry.open && !existing) openVocCreate(key);
  }, [mailMode, entry.open, existing, key]);
  const { draft } = entry;
  const ready = entry.open && draft.prefilled && !!ctx;
  const charsetText = createCharsetText(draft);
  const charset = useVocCharset(charsetText, ready);
  const [, setRecheck] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const supported = vocCreateSupported(mailMode);
  // 로그인 필요·설정 필요면 VOC 로 보내 봐야 확인 뒤에 실패한다(VOC 화면과 같은 규칙) — [등록]을 막고 이유를 보인다
  const writeBlock = taskWriteBlock(board, '등록할');

  const notice = entry.notice ? <VocNotice notice={entry.notice} onClose={() => closeVocCreateNotice(key)} /> : null;

  // 줄에 값이 빈 [voc::]·닫히지 않은 [voc:: 가 있다: 만들면 줄에 번호를 붙이지 못한다(main 도 거부) — 버튼 대신 안내
  if (task && !existing && lineHasVocField(task.rawLine)) {
    return (
      <section className="voc-create" aria-label="VOC 등록">
        <div className="reply-sender reply-sender--warn" data-testid="voc-create-broken-field">
          <IconAlert size={16} />
          <p className="reply-sender-text">{VOC_LINE_FIELD_BROKEN}</p>
        </div>
        {notice}
      </section>
    );
  }

  // 이미 등록함(할 일 줄의 [voc:: ] · 방금 만듦 · 등록 문맥): 버튼 대신 배지
  if (existing) {
    return (
      <section className="voc-create voc-create--done" aria-label="VOC 등록">
        <button
          type="button"
          ref={badgeRef}
          className="voc-created-badge"
          data-testid="voc-created-badge"
          title="VOC 화면에서 이 티켓을 엽니다"
          onClick={() => showVocTicket(existing)}
        >
          <IconTicket size={14} />
          <span>{createdBadgeText(existing)}</span>
        </button>
        {notice}
      </section>
    );
  }

  if (!entry.open) {
    return (
      <section className="voc-create" aria-labelledby="voc-create-bar-title">
        <div className="voc-create-bar">
          <div className="voc-create-bar-text">
            <h2 id="voc-create-bar-title" className="voc-create-bar-title">
              VOC 로 등록
            </h2>
            <p className="voc-create-bar-desc">
              {supported
                ? '이 메일로 VOC 티켓을 만들고 할 일 줄 끝에 번호([voc:: …])를 남깁니다. 만들기 전에 한 번 더 확인합니다.'
                : NO_VOC_MESSAGE}
            </p>
          </div>
          <button
            type="button"
            ref={openRef}
            className="btn btn--secondary"
            data-testid="btn-voc-create"
            disabled={!supported || entry.busy}
            onClick={() => {
              openVocCreate(key);
              // 누른 버튼이 사라진다 — 제목 칸(기본값을 이미 읽었으면), 아니면 작성 칸 제목으로
              refocusIfLost(() => titleRef.current, () => headingRef.current, 6);
            }}
          >
            <IconTicket size={16} />
            VOC 로 등록
          </button>
        </div>
        {notice}
      </section>
    );
  }

  const check = checkVocCreate(draft, charset.chars, entry.busy);
  const canSubmit = ready && check.ok && supported && !writeBlock;
  const dirty = isCreateDirty(draft, ctx);
  const customers = customerOptions(ctx?.directory.customers ?? [], draft.customerId);
  const systems = systemOptions(ctx?.directory.systems ?? [], draft.system, draft.customerId);
  const requestTypes = requestTypeOptions(ctx?.directory.requestTypes ?? [], draft.requestType);
  const assignees = assigneeOptions(board, ctx?.directory.me, draft.assigneeId);
  const priorities: SelectOption[] = VOC_PRIORITIES.map((p) => ({ value: p, label: p === 'P3' ? 'P3(기본)' : p }));
  const set = (patch: Parameters<typeof updateVocCreateDraft>[1]): void => updateVocCreateDraft(key, patch);
  const locked = entry.busy;

  const ask = async (): Promise<void> => {
    if (!canSubmit) return;
    // 입력을 멈추자마자 누르면 검사가 아직일 수 있다 — 지금 확인하고, 보낼 수 없는 글자가 있으면 대화상자 대신 안내를 보인다
    const bad = await checkCharsetNow(charsetText);
    if (bad.length > 0) {
      setRecheck((n) => n + 1);
      return;
    }
    setConfirming(true);
  };
  const run = (): void => {
    setConfirming(false);
    void submitVocCreate(key).then(() => {
      // 만들었으면 배지로, 못 만들었으면(비활성이던) [등록]으로
      refocusIfLost(
        () => badgeRef.current ?? submitRef.current,
        () => submitRef.current,
      );
    });
  };
  const collapse = (): void => {
    collapseVocCreate(key);
    refocusIfLost(() => openRef.current);
  };

  let hint: string;
  if (!supported) hint = NO_VOC_MESSAGE;
  else if (entry.busy) hint = 'VOC 티켓을 만드는 중입니다…';
  else if (writeBlock) hint = writeBlock;
  else if (!ready) hint = '등록 기본값을 불러오면 적을 수 있습니다.';
  else if (check.reason) hint = check.reason;
  else hint = '등록하기 전에 제목·고객사·시스템·담당을 한 번 더 확인합니다.';

  const summary = confirming
    ? createConfirmSummary({ draft, customers, systems, requestTypes, assignees, target: mailOnly ? 'mail' : 'task' })
    : null;
  const loading = entry.context.status === 'loading' || entry.context.status === 'idle';
  // 로그인 필요면 문맥 읽기 실패도 그 때문이다 — 오류 카드 대신 '로그인 필요' 안내 하나만(로그인하면 main 이 보드를 새로 받고,
  // 그 보드가 오면 useVocCreate 가 문맥을 다시 읽는다)
  const loginNeeded = needsVocLogin(board);

  let status: ReactElement | null = null;
  if (loginNeeded && entry.context.status === 'error') {
    status = null;
  } else if (!ctx) {
    if (entry.context.status === 'missing') {
      status = (
        <div className="reply-sender reply-sender--warn">
          <IconAlert size={16} />
          <p className="reply-sender-text">원본 메일을 찾지 못해 VOC 로 등록할 수 없습니다. 메일 파일이 옮겨졌거나 지워졌는지 확인해 주세요.</p>
          <button type="button" className="link-btn reply-sender-retry" onClick={() => loadCreateContext(key)}>
            <IconRefresh size={14} />
            다시 확인
          </button>
        </div>
      );
    } else if (entry.context.status === 'error') {
      status = (
        <div className="reply-sender reply-sender--warn" role="alert">
          <IconAlert size={16} />
          <p className="reply-sender-text">등록 정보를 불러오지 못했습니다. ({entry.context.message})</p>
          <button type="button" className="link-btn reply-sender-retry" onClick={() => loadCreateContext(key)}>
            <IconRefresh size={14} />
            다시 시도
          </button>
        </div>
      );
    } else {
      status = (
        <p className="reply-sender" role="status">
          <span className="state-spinner" aria-hidden="true" />
          원본 메일과 VOC 고객사·시스템 목록을 불러오는 중입니다…
        </p>
      );
    }
  } else if (entry.context.status === 'error') {
    // 다시 읽기가 실패했다 — 앞서 읽은 값으로 계속 쓸 수 있다
    status = (
      <div className="reply-sender reply-sender--warn">
        <IconAlert size={16} />
        <p className="reply-sender-text">등록 정보를 다시 읽지 못했습니다. 앞서 읽은 목록으로 씁니다. ({entry.context.message})</p>
      </div>
    );
  }

  const titleLength = cleanVocTitle(draft.title).length;
  const descLength = cleanVocText(draft.description).length;
  const describe = (...ids: Array<string | false | null | undefined>): string | undefined => cls(...ids) || undefined;

  return (
    <section
      className="panel voc-create-panel"
      data-testid="voc-create-panel"
      data-ready={ready ? 'true' : undefined}
      aria-labelledby="voc-create-heading"
      aria-busy={loading || entry.busy}
    >
      <div className="voc-task-head">
        {/* tabIndex -1: [VOC 로 등록]을 누른 뒤 초점을 둘 자리(Tab 순서에는 들지 않는다) */}
        <h2 id="voc-create-heading" ref={headingRef} className="result-form-title" tabIndex={-1}>
          VOC 로 등록
        </h2>
        <span className="voc-task-number">
          <IconTicket size={14} />새 티켓
        </span>
      </div>
      <p className="voc-task-lead">
        {mailOnly
          ? '원본 메일로 채운 기본값입니다. 고쳐서 등록하면 VOC 티켓이 만들어지고, 번호는 메일 상태(앱 데이터)에 남습니다. 위키에는 쓰지 않습니다.'
          : mailMode
            ? '원본 메일로 채운 기본값입니다. 이 메일은 할 일 하나와 연결돼 있어, 등록하면 그 할 일 줄 끝에 번호가 붙습니다. 할 일 상태는 바꾸지 않습니다.'
            : '원본 메일로 채운 기본값입니다. 고쳐서 등록하면 VOC 티켓이 만들어지고, 이 할 일 줄 끝에 번호가 붙습니다. 할 일 상태는 바꾸지 않습니다.'}
      </p>
      {loginNeeded && <VocLoginNeeded text="VOC 에 로그인이 필요합니다 — 로그인한 뒤 등록할 수 있습니다." />}
      {status}

      {ready && ctx && (
        <>
          <div className="field">
            <div className="field-head">
              <label htmlFor="voc-create-title" className="field-label">
                제목
              </label>
              <CharCount length={titleLength} max={VOC_LIMITS.title} id="voc-create-title-count" />
            </div>
            <input
              id="voc-create-title"
              ref={titleRef}
              className="text-input"
              type="text"
              data-testid="voc-create-title"
              disabled={locked}
              autoComplete="off"
              spellCheck={false}
              value={draft.title}
              aria-describedby="voc-create-title-count"
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>

          <div className="field">
            <div className="field-head">
              <label htmlFor="voc-create-desc" className="field-label">
                내용
              </label>
              <CharCount length={descLength} max={VOC_LIMITS.description} id="voc-create-desc-count" />
            </div>
            <textarea
              id="voc-create-desc"
              className="text-input text-area voc-create-desc"
              rows={10}
              data-testid="voc-create-desc"
              disabled={locked}
              spellCheck={false}
              value={draft.description}
              aria-describedby={describe('voc-create-desc-count', check.charset && 'voc-create-charset')}
              onChange={(e) => set({ description: e.target.value })}
            />
            <p className="field-note">원본 메일 본문(앞 8,000자)과 출처 줄로 채웠습니다. 글자로만 보냅니다.</p>
          </div>

          <div className="voc-create-grid">
            <div className="field">
              <label htmlFor="voc-create-customer" className="field-label">
                고객사
              </label>
              <select
                id="voc-create-customer"
                className="text-input voc-select"
                data-testid="voc-create-customer"
                disabled={locked}
                value={draft.customerId}
                onChange={(e) => set({ customerId: e.target.value })}
              >
                <Options options={customers} placeholder="고르세요" />
              </select>
              {ctx.customerId === undefined && (
                <p className="field-note">
                  {mailOnly ? '메일함 이름과 같은 이름의 고객사가 없어 골라야 합니다.' : '할 일 업체와 같은 이름의 고객사가 없어 골라야 합니다.'}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor="voc-create-system" className="field-label">
                시스템
              </label>
              <select
                id="voc-create-system"
                className="text-input voc-select"
                data-testid="voc-create-system"
                disabled={locked}
                value={draft.system}
                onChange={(e) => set({ system: e.target.value })}
              >
                <Options options={systems} placeholder="고르세요" />
              </select>
              {systems.length === 0 ? (
                <p className="field-note" data-testid="voc-create-no-system">
                  고를 수 있는 시스템이 없습니다. 시스템은 받은 진행 중 티켓과 VOC 설정의 팀 시스템에서 모읍니다 — VOC 목록을 받은 뒤
                  다시 여세요.
                </p>
              ) : ctx.system !== undefined && draft.system === ctx.system ? (
                <p className="field-note">이 고객사의 진행 중 티켓에 가장 많이 나온 시스템입니다.</p>
              ) : ctx.system === undefined && draft.system === '' ? (
                <p className="field-note">이 고객사의 진행 중 티켓이 없어 골라야 합니다.</p>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="voc-create-type" className="field-label">
                요청유형
              </label>
              <select
                id="voc-create-type"
                className="text-input voc-select"
                data-testid="voc-create-type"
                disabled={locked}
                value={draft.requestType}
                onChange={(e) => set({ requestType: e.target.value })}
              >
                <Options options={requestTypes} />
              </select>
            </div>
            <div className="field">
              <label htmlFor="voc-create-priority" className="field-label">
                우선순위
              </label>
              <select
                id="voc-create-priority"
                className="text-input voc-select"
                data-testid="voc-create-priority"
                disabled={locked}
                value={draft.priority}
                onChange={(e) => set({ priority: e.target.value })}
              >
                <Options options={priorities} />
              </select>
            </div>
            <div className="field voc-create-assignee">
              <label htmlFor="voc-create-assignee" className="field-label">
                담당
              </label>
              <select
                id="voc-create-assignee"
                className="text-input voc-select"
                data-testid="voc-create-assignee"
                disabled={locked}
                value={draft.assigneeId}
                aria-describedby="voc-create-assignee-note"
                onChange={(e) => set({ assigneeId: e.target.value })}
              >
                <Options options={assignees} />
              </select>
              <p id="voc-create-assignee-note" className="field-note">
                지정하면 그 사람에게 VOC 배정 메일이 갑니다(나를 골라도). 비워 두면 미배정으로 만들어집니다.
              </p>
            </div>
          </div>
        </>
      )}

      {check.charset && (
        <p id="voc-create-charset" className="form-problem" data-testid="voc-charset-problem" role="alert">
          {check.charset}
        </p>
      )}
      {check.problem && (
        <p className="form-problem" role="alert">
          {check.problem}
        </p>
      )}

      <div className="result-actions">
        <button
          type="button"
          ref={submitRef}
          className="btn btn--primary"
          data-testid="btn-voc-create-submit"
          disabled={!canSubmit}
          aria-describedby="voc-create-hint"
          onClick={() => void ask()}
        >
          <IconTicket size={16} />
          {entry.busy ? '만드는 중…' : '등록'}
        </button>
        {!mailMode && (
          <button type="button" className="btn btn--secondary" disabled={locked} onClick={collapse}>
            접기
          </button>
        )}
        {dirty && (
          <button type="button" className="link-btn" disabled={locked} onClick={() => setDiscarding(true)}>
            기본값으로 되돌리기
          </button>
        )}
        <span id="voc-create-hint" className="result-hint">
          {hint}
        </span>
      </div>

      {notice}

      <VocConfirmDialog
        open={confirming && summary !== null}
        kind="create"
        wide
        title="VOC 티켓을 만들까요?"
        confirmText="만들기"
        confirmIcon={<IconTicket size={16} />}
        onConfirm={run}
        onCancel={() => setConfirming(false)}
      >
        {summary && (
          <>
            <p>{CREATE_CONFIRM_LEAD}</p>
            <dl className="confirm-grid">
              {summary.rows.map((r) => (
                <Fragment key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </Fragment>
              ))}
            </dl>
            {summary.preview.length > 0 && (
              <div className="confirm-section">
                <p className="field-label">내용 앞 {summary.preview.length}줄</p>
                <pre className="confirm-body">
                  {summary.preview.join('\n')}
                  {summary.moreLines > 0 && <span className="confirm-more">{`\n…(${summary.moreLines}줄 더)`}</span>}
                </pre>
              </div>
            )}
            <div className="confirm-section">
              <p className="field-label">만든 뒤</p>
              <ul className="dialog-list">
                {summary.after.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </>
        )}
      </VocConfirmDialog>

      <ConfirmDialog
        open={discarding}
        title="적은 내용을 버릴까요?"
        confirmText="버리기"
        cancelText="계속 쓰기"
        onConfirm={() => {
          setDiscarding(false);
          resetVocCreate(key);
          refocusIfLost(() => titleRef.current);
        }}
        onCancel={() => setDiscarding(false)}
      >
        <p>제목·내용·고른 값을 원본 메일로 채운 기본값으로 되돌립니다. 고친 내용은 사라집니다.</p>
      </ConfirmDialog>
    </section>
  );
}
