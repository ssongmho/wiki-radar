// 메일 회신 작성 칸(2.5단계 명세 §7) — 처리 결과 입력 폼 안, 메일 할 일일 때만.
// '회신 메일 보내기'를 켜면: 보내는 쪽 줄 · 받는사람/[전체 회신]/참조/제목 · 본문 + [초안 만들기] · 원문 인용 · 보내는 사람·서명 · 검사 문제.
// 입력값은 FullView 가 taskId 별로 들고 있다(다른 할 일을 보고 와도 남는다). 발송은 폼의 [보내고 저장] → 확인 대화상자로만 일어난다.
// 원본 메일·초안 글은 데이터다 — 글자로만 보이고 HTML·링크로 해석하지 않는다.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import type { MailSettings, SentMailRecord } from '../../../shared/types';
import { REPLY_LIMITS, settingsProblem } from '../../../shared/reply';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { IconAlert, IconChevronDown, IconExternal, IconMail, IconPen, IconRefresh, IconReply, IconSend, IconStop } from '../../components/Icons';
import { useNow } from '../../hooks/useNow';
import { cls } from '../../lib/cls';
import { refocusIfLost } from '../../lib/focus';
import {
  DEFAULT_MAIL_SETTINGS,
  HINT_MAX,
  acceptPendingDraft,
  asSentence,
  bccSelfOn,
  ccAllToAdd,
  checkReply,
  codeParts,
  contextOf,
  draftStatus,
  lastSentDetail,
  lastSentText,
  panelReadyAttr,
  previewLines,
  rejectPendingDraft,
  senderText,
  settingsSummary,
  toggleCcAll,
  type ContextEntry,
  type ReplyConfirmSummary,
  type ReplyState,
  type SettingsEntry,
} from '../../lib/reply';
import { fileLabel } from '../../lib/tasks';

/** 부모(FullView → TaskDetail → ResultForm)가 이어 주는 회신 상태와 동작 */
export interface ReplyBinding {
  /** 앱 연결에 회신 기능이 있는가 */
  supported: boolean;
  state: ReplyState;
  context: ContextEntry;
  settings: SettingsEntry;
  /** 날짜 표기 기준(지난 발송 배지) */
  today: string;
  /** 어느 할 일이든 초안을 만드는 중(main 은 한 번에 하나만 만든다) */
  draftBusy: boolean;
  /** main 이 이 할 일의 초안을 아직 만들고 있다(멈추는 중 포함) */
  draftingHere: boolean;
  onChange: (fn: (s: ReplyState) => ReplyState) => void;
  onToggle: (on: boolean) => void;
  /** 처음 상태로(폼의 [취소]) */
  onReset: () => void;
  onLoadContext: () => void;
  onLoadSettings: () => void;
  /** 설정 저장. 문제가 있으면 그 문장, 성공이면 null */
  onSaveSettings: (value: MailSettings) => Promise<string | null>;
  /** 초안을 만들 수 없는 이유(claude 가 없음 — 2.7단계). 있으면 [초안 만들기]를 끈다 */
  draftUnavailable?: string | null;
  /** [초안 만들기] — 처리 내용은 부모가 폼 초안에서 넣는다 */
  onDraft: () => void;
  onCancelDraft: () => void;
  onOpenFile: (path: string) => void;
  /** 「보내는 사람·서명」 상자의 [설정에서 보기] — 설정 › 메일 보내기(2.13단계 §C-3). 없으면 링크 없음 */
  onOpenSettings?: () => void;
}

export interface ReplyComposerProps {
  reply: ReplyBinding;
  /** 보내고 저장하는 중(입력을 잠근다) */
  saving: boolean;
  /** 처리 내용이 비었는가(초안이 전할 핵심이 없다는 안내) */
  noteEmpty: boolean;
  /**
   * 폼의 다른 확인 대화상자('입력을 되돌릴까요?' 등)가 열려 있다 — 그동안 초안이 와도 본문 교체 확인을 겹쳐 띄우지 않는다
   * (닫힌 뒤에 띄운다). 두 대화상자가 겹치면 가려진 옛 '되돌리기'가 방금 받은 초안까지 지운다.
   */
  holdDialogs?: boolean;
  /**
   * 대상(2.10단계 §8-3): 'task'(지금 — 처리 결과 폼 안의 켜기 칸) | 'mail'(메일함 회신 화면 — 켜기 칸 없이 늘 펼친다,
   * 처리 결과 폼 대신 noteField(「이번에 전할 핵심」)를 본문 위에 둔다)
   */
  mode?: 'task' | 'mail';
  /** mail 대상의 「이번에 전할 핵심」 칸(본문 위) */
  noteField?: ReactNode;
}

/** 안내 글의 파일 경로·변수 이름을 코드 글꼴로(`_mail-ingest/.env`·MAILHOST_MAIL_PASS 등 — 줄바꿈이 낱말 중간에서 나지 않는다) */
function withCode(text: string): ReactNode[] {
  return codeParts(text).map((part, i) => (part.code ? <code key={i}>{part.text}</code> : part.text));
}

/** 지난 발송 배지(폼 머리) — '회신함 9/28 14:02 · 받는사람 …' */
export function LastSentBadge({ record, today }: { record: SentMailRecord; today: string }): ReactElement {
  return (
    <p className="reply-last-sent" data-testid="reply-last-sent" title={lastSentDetail(record)}>
      <IconSend size={14} />
      <span>{lastSentText(record, today)}</span>
    </p>
  );
}

/** 확인 대화상자(reply-confirm) 본문: 보내는 사람·받는사람·참조·숨은참조·제목·본문 앞 6줄·보낸 뒤 · 피싱 의심 경고 */
export function ReplyConfirmBody({ summary }: { summary: ReplyConfirmSummary }): ReactElement {
  const { from, to, cc, bcc, subject, preview, moreLines, appended, after, suspicious } = summary;
  return (
    <>
      {suspicious.length > 0 && (
        <p className="dialog-warn">
          <IconAlert size={16} />
          <span>
            <strong>피싱 의심 메일에 회신합니다.</strong> {suspicious.join(' · ')}
          </span>
        </p>
      )}
      <dl className="confirm-grid">
        <dt>보내는 사람</dt>
        <dd>{from}</dd>
        <dt>받는사람</dt>
        <dd>{to.join(', ')}</dd>
        <dt>참조</dt>
        <dd>{cc.length > 0 ? cc.join(', ') : '없음'}</dd>
        <dt>숨은참조</dt>
        <dd>{bcc.length > 0 ? `나(${bcc.join(', ')})` : '없음'}</dd>
        <dt>제목</dt>
        <dd>{subject}</dd>
      </dl>
      <div className="confirm-section">
        <p className="field-label">본문 앞 {preview.length}줄</p>
        <pre className="confirm-body">
          {preview.join('\n')}
          {moreLines > 0 && <span className="confirm-more">{`\n…(${moreLines}줄 더)`}</span>}
        </pre>
        {appended.length > 0 && <p className="confirm-note">본문 뒤에 {appended.join('·')}을 붙여 보냅니다.</p>}
      </div>
      <div className="confirm-section">
        <p className="field-label">보낸 뒤</p>
        <ul className="dialog-list">
          {after.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** 보내는 쪽 줄(reply-sender): 보내는 사람 주소, 또는 계정 없음·원본 없음·불러오기 실패 경고 */
function SenderLine({ reply }: { reply: ReplyBinding }): ReactElement {
  const entry = reply.context;
  const ctx = contextOf(entry);
  const loading = entry.status === 'loading' || entry.status === 'idle';
  const retry = (label: string): ReactElement => (
    <button type="button" className="link-btn reply-sender-retry" disabled={loading} onClick={reply.onLoadContext}>
      <IconRefresh size={14} />
      {loading ? '확인하는 중…' : label}
    </button>
  );

  if (!ctx) {
    if (entry.status === 'missing') {
      return (
        <div className="reply-sender reply-sender--warn" data-testid="reply-sender">
          <IconAlert size={16} />
          <p className="reply-sender-text">원본 메일을 찾지 못해 회신할 수 없습니다. 메일 파일이 옮겨졌거나 지워졌는지 확인해 주세요.</p>
          {retry('다시 확인')}
        </div>
      );
    }
    if (entry.status === 'error') {
      return (
        <div className="reply-sender reply-sender--warn" data-testid="reply-sender">
          <IconAlert size={16} />
          <p className="reply-sender-text">회신 정보를 불러오지 못했습니다. ({entry.message})</p>
          {retry('다시 시도')}
        </div>
      );
    }
    return (
      <p className="reply-sender" data-testid="reply-sender" role="status">
        <span className="state-spinner" aria-hidden="true" />
        보내는 계정과 원본 메일을 확인하는 중입니다…
      </p>
    );
  }

  // 보낼 수는 있지만 알릴 것(깨진 설정 파일을 기본값으로 되돌림 등)
  const notice = ctx.sender.notice ? (
    <div className="reply-sender reply-sender--warn" data-testid="reply-sender-notice" role="status">
      <IconAlert size={16} />
      <p className="reply-sender-text">{withCode(asSentence(ctx.sender.notice))}</p>
    </div>
  ) : null;

  if (!ctx.sender.ready) {
    return (
      <>
        <div className="reply-sender reply-sender--warn" data-testid="reply-sender">
          <IconAlert size={16} />
          <p className="reply-sender-text">
            {withCode(asSentence(ctx.sender.problem ?? '메일 계정이 없습니다'))} 설정하기 전에는 보낼 수 없습니다(초안은 만들 수
            있습니다).
          </p>
          {retry('다시 확인')}
        </div>
        {notice}
      </>
    );
  }

  const settings = reply.settings.value;
  return (
    <>
      <p className="reply-sender" data-testid="reply-sender">
        <IconMail size={16} />
        <span className="reply-sender-label">보내는 사람</span>
        <strong className="reply-sender-address">{senderText(ctx, settings)}</strong>
        {bccSelfOn(ctx, settings) && <span className="reply-sender-note">나에게 숨은참조</span>}
      </p>
      {notice}
    </>
  );
}

/** 피싱 의심 경고(reply-warning) — 발송을 막지는 않는다 */
function SuspicionWarning({ signals }: { signals: string[] }): ReactElement {
  return (
    <div className="reply-warning" data-testid="reply-warning">
      <IconAlert size={16} />
      <div className="reply-warning-text">
        <p>
          <strong>피싱 의심 메일입니다.</strong> 받는사람 주소와 요청 내용을 원본과 따로 확인한 뒤 보내세요.
        </p>
        <ul className="reply-warning-list">
          {signals.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 접이식 '보내는 사람·서명'(mail-settings) — 이름·서명·나에게 숨은참조 · [설정 저장] */
function MailSettingsPanel({ reply, locked }: { reply: ReplyBinding; locked: boolean }): ReactElement {
  const { settings } = reply;
  const [edit, setEdit] = useState<MailSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const loaded = settings.value !== undefined;
  const base = settings.value ?? DEFAULT_MAIL_SETTINGS;
  const shown = edit ?? base;
  const problem = edit ? settingsProblem(shown) : null;
  const dirty =
    edit !== null && (edit.fromName !== base.fromName || edit.signature !== base.signature || edit.bccSelf !== base.bccSelf);
  // 깨진 설정 파일을 기본값으로 되돌렸다는 알림이 있으면 고치지 않고도(기본값 그대로) 저장해 확인할 수 있다
  const recovered = !!contextOf(reply.context)?.sender.notice;
  const canSave = loaded && (dirty || recovered) && !problem && !saving && !locked;

  const change = (patch: Partial<MailSettings>): void => {
    setEdit({ ...shown, ...patch });
    setResult(null);
  };
  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    const failed = await reply.onSaveSettings(shown);
    setSaving(false);
    if (failed) {
      setResult({ tone: 'error', text: `설정을 저장하지 못했습니다. (${failed})` });
    } else {
      setEdit(null);
      setResult({ tone: 'ok', text: '설정을 저장했습니다. 다음 발송부터 이 이름·서명을 씁니다.' });
    }
    // 저장 중 비활성이던 [설정 저장]에서 떨어진 초점을 되돌린다(저장했으면 바뀐 것이 없어 비활성 — 이름 칸으로)
    refocusIfLost(
      () => saveRef.current,
      () => nameRef.current,
    );
  };
  const onToggle = (): void => {
    if (detailsRef.current?.open && (settings.status === 'idle' || settings.status === 'error')) reply.onLoadSettings();
  };
  // 이 칸 안의 Enter 는 처리 결과 폼을 제출하지 않고 설정을 저장한다
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void save();
  };

  return (
    <details className="reply-settings" data-testid="mail-settings" ref={detailsRef} onToggle={onToggle}>
      <summary className="reply-settings-summary">
        <IconChevronDown size={14} className="reply-settings-chevron" />
        <span className="reply-settings-title">보내는 사람·서명</span>
        <span className="reply-settings-note">{loaded ? settingsSummary(base) : settings.status === 'error' ? '불러오지 못함' : '불러오는 중…'}</span>
      </summary>
      <div className="reply-settings-body">
        {reply.onOpenSettings && (
          <button type="button" className="link-btn reply-settings-link" data-testid="mail-settings-open" onClick={reply.onOpenSettings}>
            설정 › 메일 보내기에서 보기
          </button>
        )}
        {settings.status === 'error' && !loaded && (
          <div className="reply-sender reply-sender--warn">
            <IconAlert size={16} />
            <p className="reply-sender-text">설정을 불러오지 못했습니다. ({settings.message})</p>
            <button type="button" className="link-btn reply-sender-retry" onClick={reply.onLoadSettings}>
              <IconRefresh size={14} />
              다시 시도
            </button>
          </div>
        )}
        <div className="field">
          <label htmlFor="mail-settings-name" className="field-label">
            보내는 이름
          </label>
          <input
            id="mail-settings-name"
            ref={nameRef}
            className="text-input"
            type="text"
            data-testid="mail-settings-name"
            disabled={!loaded || locked}
            maxLength={REPLY_LIMITS.fromName}
            autoComplete="off"
            spellCheck={false}
            placeholder="비워 두면 메일 주소만 보입니다"
            value={shown.fromName}
            aria-describedby={problem ? 'mail-settings-problem' : undefined}
            onKeyDown={onNameKey}
            onChange={(e) => change({ fromName: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="mail-settings-signature" className="field-label">
            서명
          </label>
          <textarea
            id="mail-settings-signature"
            className="text-input text-area"
            rows={4}
            data-testid="mail-settings-signature"
            disabled={!loaded || locked}
            maxLength={REPLY_LIMITS.signature}
            spellCheck={false}
            placeholder={'본문 끝에 빈 줄 하나를 두고 붙습니다.\n예: 홍길동 드림 / 연락처'}
            value={shown.signature}
            aria-describedby={problem ? 'mail-settings-problem' : undefined}
            onChange={(e) => change({ signature: e.target.value })}
          />
        </div>
        <label className="check-card">
          <input
            type="checkbox"
            data-testid="mail-settings-bcc"
            disabled={!loaded || locked}
            checked={shown.bccSelf}
            aria-labelledby="mail-settings-bcc-title"
            aria-describedby="mail-settings-bcc-desc"
            onChange={(e) => change({ bccSelf: e.target.checked })}
          />
          <span className="check-card-text">
            <span id="mail-settings-bcc-title" className="check-card-title">
              나에게 숨은참조
            </span>
            <span id="mail-settings-bcc-desc" className="check-card-desc">
              보낸 메일 사본을 내 메일함으로도 받습니다. Radar 에서 보낸 메일은 이것과 상관없이 메일함 「보낸 편지함」에 본문·첨부까지 남습니다.
            </span>
          </span>
        </label>
        {problem && (
          <p id="mail-settings-problem" className="form-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="reply-settings-actions">
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-mail-settings-save"
            ref={saveRef}
            disabled={!canSave}
            onClick={() => void save()}
          >
            {saving ? '저장 중…' : '설정 저장'}
          </button>
          {result ? (
            <span className={cls('reply-settings-result', result.tone === 'error' && 'is-error')} role="status">
              {result.text}
            </span>
          ) : (
            <span className="reply-settings-result">모든 회신에 함께 씁니다.</span>
          )}
        </div>
      </div>
    </details>
  );
}

export function ReplyComposer({ reply, saving, noteEmpty, holdDialogs = false, mode = 'task', noteField }: ReplyComposerProps): ReactElement {
  const mailMode = mode === 'mail';
  const { state, context } = reply;
  const ctx = contextOf(context);
  const check = checkReply(state, context);
  const running = state.draft.state === 'running';
  const now = useNow(running);
  const status = draftStatus(state, now);
  const addCount = ctx ? ccAllToAdd(state, ctx).length : 0;
  const ready = state.prefilled && !!ctx;
  const locked = saving;

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const set = (patch: Partial<ReplyState>): void => reply.onChange((s) => ({ ...s, ...patch }));

  // 할 일을 열 때마다 회신 문맥을 읽는다(지난 발송 배지·계정 준비). 폼은 할 일마다 새로 그려진다
  const { onLoadContext, onLoadSettings } = reply;
  // (의존성을 비워 둔다 — 부모가 그릴 때마다 새 함수를 넘기므로, 넣으면 그릴 때마다 다시 읽는다)
  useEffect(() => {
    onLoadContext();
  }, []);
  const settingsIdle = reply.settings.status === 'idle';
  useEffect(() => {
    if (state.enabled && settingsIdle) onLoadSettings();
  }, [state.enabled, settingsIdle, onLoadSettings]);

  // [초안 만들기] ↔ [중단]은 서로 다른 버튼이다 — 누른 버튼이 사라지면 짝 버튼으로(끝났을 때 [초안 만들기]가 아직 비활성이면 본문으로).
  // 작성 칸이 닫혀서 끝난 것([취소]로 되돌림·회신 끄기)이면 건드리지 않는다 — 옮길 버튼이 없고, 폼이 건 초점 요청(상태 라디오)을
  // 이 요청이 덮어 초점이 body 로 떨어진다(refocusIfLost 는 가장 최근 요청만 따른다).
  const panelOpen = state.enabled;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running && !wasRunning.current) refocusIfLost(() => cancelRef.current);
    if (!running && wasRunning.current && panelOpen) refocusIfLost(() => draftRef.current, () => bodyRef.current, 6);
    wasRunning.current = running;
  }, [running, panelOpen]);

  const onHintKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // 요청 칸의 Enter 는 폼 제출(보내기 확인) 대신 초안 만들기
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!running && !reply.draftBusy && !reply.draftUnavailable && !locked && ready) reply.onDraft();
  };

  const toggleDesc = !reply.supported
    ? '이 앱 연결에는 메일 회신 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.'
    : '원본 메일에 회신을 보내고 처리 결과를 함께 저장합니다. 보내기 전에 받는사람·제목·본문을 한 번 더 확인합니다.';

  let draftHint: string | null = null;
  if (!running && reply.draftingHere) draftHint = '초안 만들기를 멈추는 중입니다…';
  else if (!running && reply.draftUnavailable) draftHint = reply.draftUnavailable;
  else if (!running && reply.draftBusy)
    draftHint = mailMode ? '다른 회신 초안을 만드는 중입니다. 끝나면 만들 수 있습니다.' : '다른 할 일의 회신 초안을 만드는 중입니다. 끝나면 만들 수 있습니다.';
  else if (!running && noteEmpty && !state.draft.received)
    draftHint = mailMode
      ? '이번에 전할 핵심(위 칸)을 적으면 초안이 그 내용을 전합니다. 비워 두면 원본 메일에 답합니다.'
      : '처리 내용(위 칸)을 먼저 적으면 초안이 그 내용을 전합니다.';

  const pending = state.pendingDraft;
  const pendingPreview = pending ? previewLines(pending.body) : null;

  return (
    <>
      {!mailMode && (
      <label className={cls('check-card', !reply.supported && 'is-disabled')}>
        <input
          type="checkbox"
          data-testid="reply-toggle"
          checked={state.enabled}
          disabled={!reply.supported || locked}
          aria-labelledby="reply-toggle-title"
          aria-describedby="reply-toggle-desc"
          aria-controls={state.enabled ? 'reply-panel' : undefined}
          onChange={(e) => reply.onToggle(e.target.checked)}
        />
        <span className="check-card-text">
          <span id="reply-toggle-title" className="check-card-title">
            회신 메일 보내기
          </span>
          <span id="reply-toggle-desc" className="check-card-desc">
            {toggleDesc}
          </span>
        </span>
      </label>
      )}

      {state.enabled && (
        <section
          id="reply-panel"
          className="reply-panel"
          data-testid="reply-panel"
          data-ready={panelReadyAttr(context)}
          aria-labelledby="reply-panel-title"
          aria-busy={context.status === 'loading' || (!ready && context.status === 'idle')}
        >
          <h3 id="reply-panel-title" className="reply-panel-title">
            <IconReply size={16} />
            회신 메일
          </h3>
          {ctx && ctx.suspicious.length > 0 && <SuspicionWarning signals={ctx.suspicious} />}
          <SenderLine reply={reply} />

          {ready && ctx && (
            <>
              <div className="reply-fields">
                <div className="field">
                  <label htmlFor="reply-to" className="field-label">
                    받는사람
                  </label>
                  <input
                    id="reply-to"
                    className="text-input"
                    type="text"
                    data-testid="reply-to"
                    disabled={locked}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="이름 <주소> 또는 주소 — 여럿이면 쉼표로 구분"
                    value={state.to}
                    aria-describedby={check.problem ? 'reply-problem' : undefined}
                    onChange={(e) => set({ to: e.target.value })}
                  />
                </div>
                <div className="field">
                  <div className="field-head">
                    <label htmlFor="reply-cc" className="field-label">
                      참조
                    </label>
                    <button
                      type="button"
                      className="link-btn"
                      data-testid="btn-reply-all"
                      disabled={locked || (!state.ccAllApplied && addCount === 0)}
                      title={
                        state.ccAllApplied
                          ? '참조 칸을 비웁니다'
                          : addCount > 0
                            ? `원본 메일의 다른 받는사람·참조 ${addCount}명을 참조에 넣습니다`
                            : '원본 메일에 다른 받는사람·참조가 없습니다'
                      }
                      onClick={() => reply.onChange((s) => toggleCcAll(s, ctx))}
                    >
                      {state.ccAllApplied ? '참조 비우기' : addCount > 0 ? `전체 회신 (${addCount}명)` : '전체 회신'}
                    </button>
                  </div>
                  <input
                    id="reply-cc"
                    className="text-input"
                    type="text"
                    data-testid="reply-cc"
                    disabled={locked}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="비워 두면 참조 없이 보냅니다"
                    value={state.cc}
                    aria-describedby={check.problem ? 'reply-problem' : undefined}
                    onChange={(e) => set({ cc: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="reply-subject" className="field-label">
                    제목
                  </label>
                  <input
                    id="reply-subject"
                    className="text-input"
                    type="text"
                    data-testid="reply-subject"
                    disabled={locked}
                    maxLength={REPLY_LIMITS.subject}
                    autoComplete="off"
                    spellCheck={false}
                    value={state.subject}
                    aria-describedby={check.problem ? 'reply-problem' : undefined}
                    onChange={(e) => set({ subject: e.target.value })}
                  />
                </div>
              </div>

              {noteField}
              <div className="field">
                <div className="field-head">
                  <label htmlFor="reply-body" className="field-label">
                    본문
                  </label>
                  <span className="field-note">서명·원문 인용은 보낼 때 앱이 붙입니다</span>
                </div>
                <textarea
                  id="reply-body"
                  ref={bodyRef}
                  className="text-input text-area reply-body"
                  rows={12}
                  data-testid="reply-body"
                  disabled={locked}
                  maxLength={REPLY_LIMITS.body}
                  spellCheck={false}
                  placeholder="직접 쓰거나 [초안 만들기]로 Claude의 초안을 받아 고칩니다."
                  value={state.body}
                  aria-describedby={check.problem ? 'reply-problem draft-status' : 'draft-status'}
                  onChange={(e) => set({ body: e.target.value })}
                />
              </div>

              <div className="draft-bar">
                {running ? (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    data-testid="btn-draft-cancel"
                    ref={cancelRef}
                    onClick={reply.onCancelDraft}
                  >
                    <IconStop size={16} />
                    중단
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    data-testid="btn-draft"
                    ref={draftRef}
                    disabled={reply.draftBusy || !!reply.draftUnavailable || locked}
                    aria-describedby="draft-status"
                    onClick={reply.onDraft}
                  >
                    <IconPen size={16} />
                    {state.draft.received ? '다시 만들기' : '초안 만들기'}
                  </button>
                )}
                <input
                  className="text-input draft-hint"
                  type="text"
                  aria-label="초안에 더할 요청(선택)"
                  disabled={running || locked}
                  maxLength={HINT_MAX}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="초안에 더할 요청(선택) — 예: 더 짧게"
                  value={state.hint}
                  onKeyDown={onHintKey}
                  onChange={(e) => set({ hint: e.target.value })}
                />
              </div>
              <p id="draft-status" className="draft-status" data-testid="draft-status" data-state={state.draft.state} role="status">
                {running && <span className="state-spinner" aria-hidden="true" />}
                <span>{status.text}</span>
                {status.timer && (
                  <span className="draft-timer" aria-hidden="true">
                    {status.timer}
                  </span>
                )}
              </p>
              {draftHint && <p className="field-note">{draftHint}</p>}
              {state.draft.received && state.draft.state !== 'running' && (
                <p className="field-note draft-engine" data-testid="reply-draft-engine" data-engine={state.draft.engine ?? 'claude'}>
                  {state.draft.engine === 'local' ? '로컬 LLM 초안 · 위키 참고 없음' : 'Claude 초안'}
                </p>
              )}

              {state.draft.references.length > 0 && (
                <div className="field">
                  <h4 className="field-label">초안이 참고한 문서 {state.draft.references.length}개</h4>
                  <ul className="link-list" data-testid="draft-refs">
                    {state.draft.references.map((path) => (
                      <li key={path}>
                        <button
                          type="button"
                          className="link-row"
                          title={`${path} — Obsidian에서 열기`}
                          onClick={() => reply.onOpenFile(path)}
                        >
                          <span className="link-row-text">
                            <span className="link-row-name">{fileLabel(path)}</span>
                            <span className="link-row-hint">{path}</span>
                          </span>
                          <IconExternal size={14} className="link-row-icon" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {state.draft.notes && (
                <div className="draft-notes">
                  <h4 className="field-label">초안이 남긴 확인할 점</h4>
                  <p className="draft-notes-text">{state.draft.notes}</p>
                </div>
              )}

              <label className="check-card">
                <input
                  type="checkbox"
                  data-testid="reply-quote"
                  disabled={locked}
                  checked={state.quoteOriginal}
                  aria-labelledby="reply-quote-title"
                  aria-describedby="reply-quote-desc"
                  onChange={(e) => set({ quoteOriginal: e.target.checked })}
                />
                <span className="check-card-text">
                  <span id="reply-quote-title" className="check-card-title">
                    원문 인용 붙이기
                  </span>
                  <span id="reply-quote-desc" className="check-card-desc">
                    본문(과 서명) 끝에 원본 메일의 보낸사람·날짜·제목·본문을 ‘-----Original Message-----’로 붙입니다.
                  </span>
                </span>
              </label>

              <MailSettingsPanel reply={reply} locked={locked} />

              {check.problem && (
                <p id="reply-problem" className="form-problem" data-testid="reply-problem" role="alert">
                  {check.problem}
                </p>
              )}
            </>
          )}
        </section>
      )}

      <ConfirmDialog
        open={!!pending && state.enabled && !locked && !holdDialogs}
        testId="draft-replace-confirm"
        title="지금 본문을 초안으로 바꿀까요?"
        confirmText="초안으로 바꾸기"
        cancelText="지금 본문 두기"
        confirmIcon={<IconPen size={16} />}
        onConfirm={() => {
          reply.onChange(acceptPendingDraft);
          refocusIfLost(() => bodyRef.current);
        }}
        onCancel={() => {
          reply.onChange(rejectPendingDraft);
          refocusIfLost(() => bodyRef.current);
        }}
      >
        <p>
          Claude가 쓴 초안이 왔습니다. 바꾸면 <strong>지금 적힌 본문은 사라집니다</strong>. 바꾼 뒤에도 보내기 전에 고칠 수 있습니다.
        </p>
        {pendingPreview && (
          <pre className="confirm-body">
            {pendingPreview.lines.join('\n')}
            {pendingPreview.more > 0 && <span className="confirm-more">{`\n…(${pendingPreview.more}줄 더)`}</span>}
          </pre>
        )}
      </ConfirmDialog>
    </>
  );
}
