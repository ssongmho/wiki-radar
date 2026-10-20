// [위키에 반영](2.14단계 명세 §8-2) — 읽기 칸 안 작은 폼: 범위 · 남길 것(선택) · 업체·주제(선택) · 회사 밖 안내 한 줄.
// 제출하면 main 이 그 메일(또는 스레드)을 반영 대기열에 kind mail 로 넣는다(위키에는 쓰지 않는다 — 반영은 [반영 대기] 화면에서).
// 회사 밖 안내는 늘 보인다 — 폼 제출([확인하고 반영 대기에 넣기])이 확인이다. 실제로 보내는 때는 반영 대기 화면의 [반영 시작].
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { QueueItem, QueueMailInput, QueueMailResult } from '../../../../shared/types';
import { IconUpload } from '../../../components/Icons';
import {
  MAIL_WIKI_HINT_MAX,
  MAIL_WIKI_NOTE_MAX,
  appTimeText,
  mailWikiDuplicateText,
  mailWikiOutsideText,
} from '../../../lib/mailbox';

export interface MailWikiFormProps {
  mailKey: string;
  /** 스레드 메일 수(1이면 범위 줄 없음) */
  threadCount: number;
  /** 스레드에 피싱 의심 메일이 있다 — 「스레드 전체」를 막는다 */
  threadSuspicious: boolean;
  /** 이 메일의 첨부 수 */
  attachments: number;
  /** 이미 대기 중인 항목(있으면 그 범위·메모·힌트로 채우고 바꾸기를 묻는다) */
  existing?: QueueItem;
  /** 이미 위키에 반영한 시각(있으면 한 줄 알림) */
  reflectedAt?: string;
  today: string;
  /** main 에 보낸다. 실패하면 던진다 */
  onSubmit: (input: QueueMailInput) => Promise<QueueMailResult>;
  onDone: (item: QueueItem, warnings: string[]) => void;
  onCancel: () => void;
  onOpenQueue: () => void;
}

export function MailWikiForm(props: MailWikiFormProps): ReactElement {
  const { existing, threadCount, threadSuspicious, today } = props;
  const [scope, setScope] = useState<'mail' | 'thread'>(() =>
    existing?.scope === 'thread' && threadCount > 1 && !threadSuspicious ? 'thread' : 'mail',
  );
  const [note, setNote] = useState(existing?.note ?? '');
  const [hint, setHint] = useState(existing?.hint ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** 중복 안내(처음부터 대기 중이었거나 제출 결과가 duplicate) */
  const [duplicate, setDuplicate] = useState<QueueItem | null>(existing ?? null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  const send = async (replace: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const input: QueueMailInput = { key: props.mailKey, scope, note };
      if (hint.trim()) input.hint = hint.trim();
      if (replace) input.replace = true;
      const out = await props.onSubmit(input);
      if (out.status === 'duplicate') {
        setDuplicate(out.existing);
        return;
      }
      props.onDone(out.item, out.warnings);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const hintBad = /[\u0000-\u001f\u007f]/.test(hint);
  const canSend = !busy && !hintBad && note.length <= MAIL_WIKI_NOTE_MAX && hint.length <= MAIL_WIKI_HINT_MAX;

  return (
    <form
      className="mb-task-form mb-wiki-form"
      data-testid="mail-wiki-form"
      data-scope={scope}
      aria-labelledby="mb-wiki-title"
      onSubmit={(e) => {
        e.preventDefault();
        void send(duplicate !== null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <div className="mb-wiki-head">
        <h2 id="mb-wiki-title" className="mb-section-title">
          위키에 반영
        </h2>
        <button type="button" className="link-btn" disabled={busy} onClick={props.onCancel}>
          닫기
        </button>
      </div>
      {props.reflectedAt && (
        <p className="field-note" data-testid="mail-wiki-reflected">
          {appTimeText(props.reflectedAt, today)}에 위키에 반영함 — 다시 넣으면 Claude 가 같은 내용을 한 번 더 정리합니다.
        </p>
      )}
      {threadCount > 1 && (
        <fieldset className="mb-wiki-scope">
          <legend className="field-label">범위</legend>
          <label className="mb-wiki-radio">
            <input
              type="radio"
              name="mail-wiki-scope"
              data-testid="mail-wiki-scope-mail"
              checked={scope === 'mail'}
              disabled={busy}
              onChange={() => setScope('mail')}
            />
            이 메일
          </label>
          <label className="mb-wiki-radio">
            <input
              type="radio"
              name="mail-wiki-scope"
              data-testid="mail-wiki-scope-thread"
              checked={scope === 'thread'}
              disabled={busy || threadSuspicious}
              onChange={() => setScope('thread')}
            />
            스레드 전체 {threadCount}통
          </label>
          {threadSuspicious && <span className="field-note is-warn">스레드에 피싱 의심 메일이 있어 이 메일만 넣을 수 있습니다</span>}
        </fieldset>
      )}
      <div className="field">
        <label htmlFor="mail-wiki-note" className="field-label">
          남길 것(선택)
        </label>
        <textarea
          id="mail-wiki-note"
          ref={noteRef}
          className="text-input mb-wiki-note"
          data-testid="mail-wiki-note"
          rows={3}
          maxLength={MAIL_WIKI_NOTE_MAX}
          placeholder="예: 11월 정기보수 일정과 담당 변경만"
          disabled={busy}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="mail-wiki-hint" className="field-label">
          업체·주제(선택)
        </label>
        <input
          id="mail-wiki-hint"
          className="text-input"
          data-testid="mail-wiki-hint"
          maxLength={MAIL_WIKI_HINT_MAX}
          autoComplete="off"
          spellCheck={false}
          placeholder="예: 한결케미칼 · 화관법 정기검사"
          disabled={busy}
          value={hint}
          onChange={(e) => setHint(e.target.value.replace(/[\r\n]+/g, ' '))}
        />
      </div>
      {props.attachments > 0 && (
        <p className="field-note" data-testid="mail-wiki-attach-note">
          첨부 {props.attachments}개는 이름만 보냅니다(내용은 보내지 않습니다).
        </p>
      )}
      <p className="mb-wiki-outside" data-testid="mail-wiki-outside">
        {mailWikiOutsideText(scope, threadCount)}
      </p>
      {duplicate && (
        <div className="mb-wiki-duplicate" role="status" data-testid="mail-wiki-duplicate">
          <p>{mailWikiDuplicateText(duplicate, today)}</p>
          <div className="result-actions">
            <button type="button" className="btn btn--primary" data-testid="btn-mail-wiki-replace" disabled={!canSend} onClick={() => void send(true)}>
              <IconUpload size={16} />
              {busy ? '바꾸는 중…' : '바꾸기'}
            </button>
            <button type="button" className="btn btn--secondary" data-testid="btn-mail-wiki-keep" disabled={busy} onClick={props.onCancel}>
              그대로 두기
            </button>
            <button type="button" className="link-btn" onClick={props.onOpenQueue}>
              반영 대기 보기
            </button>
          </div>
        </div>
      )}
      {problem && (
        <p className="form-problem" role="alert">
          {problem}
        </p>
      )}
      {!duplicate && (
        <div className="result-actions">
          <button type="submit" className="btn btn--primary" data-testid="btn-mail-wiki-queue" disabled={!canSend}>
            <IconUpload size={16} />
            {busy ? '넣는 중…' : '확인하고 반영 대기에 넣기'}
          </button>
          <button type="button" className="btn btn--secondary" data-testid="btn-mail-wiki-cancel" disabled={busy} onClick={props.onCancel}>
            취소
          </button>
          <span className="result-hint">넣기만 해서는 아무것도 보내지 않습니다. 반영 대기 화면의 [위키에 반영]에서 보냅니다.</span>
        </div>
      )}
    </form>
  );
}
