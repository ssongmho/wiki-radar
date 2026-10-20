// 메일함 오른쪽 읽기 칸(2.10단계 명세 §8-2·§6): 피싱 의심 띠 · 머리(제목 · 보낸이 → 받는이 · 참조 N명 · 날짜 · 메일함) ·
// 동작 줄([회신] [VOC로 등록] [할 일로] [위키에 반영](2.14) [처리함으로] [회신 필요] · 「…」 안 [미확인으로] · [Obsidian에서 열기]) · 「분석은 로컬 LLM 연결 뒤」 ·
// 본문 · 첨부 · 이 스레드 · 연결.
// 메일 본문은 데이터다(§6-2): 파일의 본문은 이미 평문이라 텍스트 노드 + white-space: pre-wrap 으로만 그린다 —
// dangerouslySetInnerHTML·markdown 렌더·자동 링크·이미지 없음. 본문 속 <script>·<img>·<a href> 는 글자로 보일 뿐이다.
import { useState, type ReactElement, type ReactNode, type Ref } from 'react';
import { FEATURES } from '../../../../shared/edition';
import type { MailThreadDetail, MailThreadMail } from '../../../../shared/types';
import {
  IconAlert,
  IconArchive,
  IconAttach,
  IconChecklist,
  IconExternal,
  IconFlag,
  IconFolder,
  IconInbox,
  IconMail,
  IconMore,
  IconReply,
  IconSend,
  IconTicket,
  IconUpload,
} from '../../../components/Icons';
import { EmptyState, LoadingState } from '../../../components/StateMessage';
import { MailHtmlView } from './MailHtmlView';
import { MailAnalysisPanel } from './MailAnalysisPanel';
import type { MessageEntry, ThreadEntry } from '../../../hooks/useMailbox';
import { cls } from '../../../lib/cls';
import {
  MAIL_ANALYSIS_OFF,
  MAIL_SUSPICIOUS_TEXT,
  appTimeText,
  mailDateText,
  mailWikiButtonLabel,
  recipientsShort,
  sizeText,
  threadWikiText,
  type MailWikiState,
} from '../../../lib/mailbox';
import { statusLabel } from '../../../lib/result';

/** 동작 버튼 하나의 상태(막혔으면 이유) */
export interface MailAction {
  blocked?: string | null;
}

export interface MailReaderProps {
  thread: ThreadEntry;
  mail: MailThreadMail | null;
  message: MessageEntry;
  today: string;
  /** 스레드가 처리함인가(모든 메일) */
  archived: boolean;
  /** 이 메일이 회신 필요인가 */
  replyNeeded: boolean;
  reply: MailAction;
  voc: MailAction & { done?: string };
  task: MailAction;
  /** [위키에 반영](2.14) — 없으면(옛 preload) 버튼을 숨긴다 */
  wiki?: MailAction & { state: MailWikiState };
  busy: boolean;
  onReply: () => void;
  onVoc: () => void;
  onTask: () => void;
  onWiki?: () => void;
  /** 반영 대기 화면을 연다 */
  onOpenQueue?: () => void;
  onArchive: () => void;
  onReplyNeeded: () => void;
  onUnread: () => void;
  onOpenFile: (path: string) => void;
  onSelectMail: (key: string) => void;
  /** 분석의 할 일 후보로 [할 일로] 칸 열기(2.16) */
  onTaskSuggest?: (task: { title: string; due?: string }) => void;
  /** false 면 분석 자리를 옛 한 줄로(시험·옛 preload) */
  analysis?: boolean;
  onReveal: (index: number) => void;
  onOpenTask: (taskId: string) => void;
  onOpenVoc: (number: string) => void;
  /** [할 일로] 작은 칸(열렸을 때) */
  taskForm?: ReactNode;
  /** [위키에 반영] 작은 폼(열렸을 때) */
  wikiForm?: ReactNode;
  /** 결과 알림(save-notice) */
  notice?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}

function ActionButton({
  testId,
  action,
  label,
  icon,
  shortcut,
  primary,
  pressed,
  extra,
  onClick,
}: {
  testId: string;
  action: MailAction;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  primary?: boolean;
  pressed?: boolean;
  /** 더 붙일 data-* 속성 */
  extra?: Record<string, string>;
  onClick: () => void;
}): ReactElement {
  const blocked = action.blocked ?? undefined;
  return (
    <button
      type="button"
      className={cls('btn', primary ? 'btn--primary' : 'btn--secondary', 'mb-action', pressed && 'is-on')}
      data-testid={testId}
      {...extra}
      data-blocked-reason={blocked}
      disabled={!!blocked}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      title={blocked ?? (shortcut ? `${label} (${shortcut})` : label)}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function ThreadList({
  detail,
  current,
  today,
  onSelectMail,
}: {
  detail: MailThreadDetail;
  current: string | null;
  today: string;
  onSelectMail: (key: string) => void;
}): ReactElement {
  const sent = detail.links.sent;
  return (
    <section className="mb-section" aria-labelledby="mb-thread-title">
      <h2 id="mb-thread-title" className="mb-section-title">
        이 스레드 {detail.mails.length}통
      </h2>
      <ol className="mb-thread" data-testid="mail-thread">
        {detail.mails.map((m) => {
          const here = m.key === current;
          return (
            <li key={m.key}>
              <button
                type="button"
                className={cls('mb-thread-item', here && 'is-current', m.unread && 'is-unread')}
                data-testid="mail-thread-item"
                data-mail-key={m.key}
                data-wiki={m.wiki?.state}
                aria-current={here ? 'true' : undefined}
                onClick={() => onSelectMail(m.key)}
              >
                <span className="mb-thread-date">{mailDateText(m.date, today)}</span>
                <span className="mb-thread-text">
                  {m.mine ? <strong className="mb-thread-me">나</strong> : <span>{m.fromName || m.from}</span>}
                  {m.mine && <span className="mb-thread-note"> · 보낸 편지함</span>}
                  {here && <span className="mb-thread-note"> — 지금 보는 메일</span>}
                  {m.problem && <span className="mb-thread-note is-warn"> · {m.problem}</span>}
                  {m.wiki && <span className="mb-thread-note mb-thread-wiki"> · 위키 {threadWikiText(m.wiki)}</span>}
                </span>
              </button>
            </li>
          );
        })}
        {sent.map((s) => (
          <li key={`sent:${s.at}`} className="mb-thread-item mb-thread-item--sent">
            <span className="mb-thread-date">{mailDateText(s.at, today)}</span>
            <span className="mb-thread-text">
              <IconSend size={12} /> 앱에서 회신함 — {recipientsShort(s.to)}
            </span>
          </li>
        ))}
        {detail.links.replyGuess && sent.length === 0 && (
          <li className="mb-thread-item mb-thread-item--sent">
            <span className="mb-thread-date">{mailDateText(detail.links.replyGuess, today)}</span>
            <span className="mb-thread-text">회신 추정(보낸 편지함에 늦은 사본)</span>
          </li>
        )}
      </ol>
    </section>
  );
}

function Links({
  detail,
  mail,
  today,
  onOpenTask,
  onOpenVoc,
  onOpenQueue,
}: {
  detail: MailThreadDetail;
  mail: MailThreadMail;
  today: string;
  onOpenTask: (taskId: string) => void;
  onOpenVoc: (number: string) => void;
  onOpenQueue?: () => void;
}): ReactElement | null {
  const { tasks, voc } = detail.links;
  const wiki = mail.wiki;
  if (tasks.length === 0 && voc.length === 0 && !mail.taskFile && !wiki) return null;
  return (
    <section className="mb-section" aria-labelledby="mb-links-title" data-testid="mail-links">
      <h2 id="mb-links-title" className="mb-section-title">
        연결
      </h2>
      <ul className="mb-links">
        {tasks.map((t) => (
          <li key={t.taskId}>
            <button type="button" className="link-row" title="할 일 화면에서 이 할 일을 엽니다" onClick={() => onOpenTask(t.taskId)}>
              <IconChecklist size={14} />
              <span className="link-row-text">
                <span className="link-row-name">{t.title}</span>
                <span className="link-row-hint">할 일 · {statusLabel(t.status)}</span>
              </span>
            </button>
          </li>
        ))}
        {tasks.length === 0 && mail.taskFile && (
          <li>
            <p className="link-row link-row--static">
              <IconChecklist size={14} />
              <span className="link-row-text">
                <span className="link-row-name">메일함에서 만든 할 일</span>
                <span className="link-row-hint">{mail.taskFile} · 완료했거나 목록에 아직 없음</span>
              </span>
            </p>
          </li>
        )}
        {wiki && (
          <li>
            <p className="link-row link-row--static" data-testid="mail-links-wiki" data-state={wiki.state}>
              <IconUpload size={14} />
              <span className="link-row-text">
                <span className="link-row-name">
                  {wiki.state === 'queued' || wiki.state === 'running'
                    ? `위키: ${wiki.state === 'running' ? '반영 중' : '반영 대기'}${wiki.at ? `(${appTimeText(wiki.at, today)})` : ''}`
                    : wiki.state === 'skipped'
                      ? `위키: ${wiki.at ? `${appTimeText(wiki.at, today)} ` : ''}반영에서 건너뜀`
                      : `위키: ${wiki.at ? `${appTimeText(wiki.at, today)} ` : ''}반영함`}
                </span>
              </span>
              {(wiki.state === 'queued' || wiki.state === 'running') && onOpenQueue && (
                <button type="button" className="link-btn" onClick={onOpenQueue}>
                  반영 대기 보기
                </button>
              )}
            </p>
          </li>
        )}
        {voc.map((n) => (
          <li key={n}>
            <button type="button" className="link-row" title="VOC 화면에서 이 티켓을 엽니다" onClick={() => onOpenVoc(n)}>
              <IconTicket size={14} />
              <span className="link-row-text">
                <span className="link-row-name">{n}</span>
                <span className="link-row-hint">VOC 티켓</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MailReader(props: MailReaderProps): ReactElement {
  const { thread, mail, message, today, archived, replyNeeded } = props;
  /** 원본이 있으면 원본(HTML)을 먼저 — 글은 위키 반영·검색용(2.15) */
  const [bodyView, setBodyView] = useState<'html' | 'text'>('html');
  if (thread.status === 'idle') {
    return (
      <section className="mb-reader" data-testid="mail-reader" aria-label="메일 읽기">
        <div className="mb-reader-empty">
          <EmptyState title="고른 메일이 없습니다.">왼쪽 목록에서 메일을 고르세요.</EmptyState>
        </div>
      </section>
    );
  }
  if (!mail || !thread.detail) {
    return (
      <section className="mb-reader" data-testid="mail-reader" aria-label="메일 읽기">
        <div className="mb-reader-empty">
          {thread.status === 'error' ? (
            <EmptyState title="스레드를 읽지 못했습니다.">{thread.message}</EmptyState>
          ) : thread.status === 'missing' ? (
            <EmptyState title="이 스레드를 찾지 못했습니다.">새 메일로 스레드가 바뀌었을 수 있습니다. 목록에서 다시 고르세요.</EmptyState>
          ) : (
            <LoadingState text="메일을 불러오는 중입니다…" />
          )}
        </div>
      </section>
    );
  }
  const detail = thread.detail;
  const msg = message.message;
  const suspicious = msg ? msg.suspicious : mail.suspicious;
  const signals = msg?.suspicion ?? [];
  const to = msg ? msg.to : mail.to;
  const ccCount = msg ? msg.cc.length : mail.ccCount;
  return (
    <section className="mb-reader" data-testid="mail-reader" data-mail-key={mail.key} aria-labelledby="mb-reader-title">
      <div className="mb-reader-scroll scroll">
        {suspicious && (
          <div className="mb-suspicious" data-testid="mail-suspicious" role="alert">
            <IconAlert size={16} />
            <div>
              <p className="mb-suspicious-title">{MAIL_SUSPICIOUS_TEXT}</p>
              {signals.length > 0 && (
                <ul className="mb-suspicious-list">
                  {signals.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        <header className="mb-reader-head">
          <p className="mb-reader-kicker">
            <span className="mb-chip mb-chip--plain">
              <IconFolder size={12} />
              {mail.folder}
            </span>
            {detail.mails.length > 1 && <span>스레드 {detail.mails.length}통</span>}
            {mail.mine && <span>보낸 편지함(내가 보낸 메일)</span>}
            {replyNeeded && <span className="mb-chip mb-chip--amber">회신 필요</span>}
            {archived && <span className="mb-chip mb-chip--plain">처리함</span>}
          </p>
          <h1 id="mb-reader-title" className="mb-reader-title" tabIndex={-1} ref={props.headingRef}>
            {(msg?.subject ?? mail.subject) || '(제목 없음)'}
          </h1>
          <p className="mb-reader-meta">
            <span>{msg?.from ?? mail.from}</span>
            <span aria-hidden="true"> → </span>
            <span className="sr-only">받는이 </span>
            <span>{recipientsShort(to)}</span>
            {ccCount > 0 && <span> · 참조 {ccCount}명</span>}
            <span> · {mailDateText(msg?.date ?? mail.date, today)}</span>
          </p>
          {msg?.replyTo && <p className="mb-reader-meta">회신주소 {msg.replyTo}</p>}
        </header>

        <div className="mb-actions" role="toolbar" aria-label="메일 동작">
          <ActionButton testId="btn-mail-reply" action={props.reply} label="회신" icon={<IconReply size={16} />} shortcut="R" primary onClick={props.onReply} />
          {/* 공개판은 VOC·로컬 LLM 분석을 가린다(src/shared/edition.ts) */}
          {!FEATURES.voc ? null : props.voc.done ? (
            <button
              type="button"
              className="voc-created-badge mb-action-badge"
              data-testid="btn-mail-voc"
              data-done={props.voc.done}
              title="VOC 화면에서 이 티켓을 엽니다"
              onClick={() => props.onOpenVoc(props.voc.done as string)}
            >
              <IconTicket size={14} />
              <span>{props.voc.done} 로 등록함</span>
            </button>
          ) : (
            <ActionButton testId="btn-mail-voc" action={props.voc} label="VOC로 등록" icon={<IconTicket size={16} />} shortcut="V" onClick={props.onVoc} />
          )}
          <ActionButton testId="btn-mail-task" action={props.task} label="할 일로" icon={<IconChecklist size={16} />} shortcut="T" onClick={props.onTask} />
          {props.wiki && props.onWiki && (
            <ActionButton
              testId="btn-mail-wiki"
              action={props.wiki}
              label={mailWikiButtonLabel(props.wiki.state)}
              icon={<IconUpload size={16} />}
              shortcut="W"
              extra={{ 'data-wiki-state': props.wiki.state }}
              onClick={props.onWiki}
            />
          )}
          <ActionButton
            testId="btn-mail-reply-needed"
            action={{ blocked: props.busy ? '바꾸는 중입니다' : null }}
            label={replyNeeded ? '회신 필요 해제' : '회신 필요'}
            icon={<IconFlag size={16} />}
            shortcut="M"
            pressed={replyNeeded}
            onClick={props.onReplyNeeded}
          />
          <ActionButton
            testId="btn-mail-archive"
            action={{ blocked: props.busy ? '바꾸는 중입니다' : null }}
            label={archived ? '받은편지함으로' : '처리함으로'}
            icon={archived ? <IconInbox size={16} /> : <IconArchive size={16} />}
            shortcut="E"
            onClick={props.onArchive}
          />
          <details className="mb-more-menu">
            <summary className="btn btn--secondary mb-action mb-more-summary" aria-label="그 밖의 동작">
              <IconMore size={16} />
            </summary>
            <div className="mb-more-pop">
              <button type="button" className="link-btn" data-testid="btn-mail-unread" aria-keyshortcuts="U" disabled={props.busy || mail.mine || mail.muted} onClick={props.onUnread}>
                <IconMail size={14} />
                미확인으로 (U)
              </button>
              <button type="button" className="link-btn" data-testid="btn-mail-obsidian" onClick={() => props.onOpenFile(mail.path)}>
                <IconExternal size={14} />
                Obsidian에서 열기
              </button>
            </div>
          </details>
        </div>

        {!FEATURES.localLlm ? null : mail && props.analysis !== false ? (
          <MailAnalysisPanel mailKey={mail.key} {...(props.onTaskSuggest ? { onTask: props.onTaskSuggest } : {})} {...(!props.voc.done && !props.voc.blocked ? { onVoc: props.onVoc } : {})} />
        ) : (
          <p className="mb-analysis-off" data-testid="mail-analysis-off">
            {MAIL_ANALYSIS_OFF}
          </p>
        )}

        {props.notice}
        {props.taskForm}
        {props.wikiForm}

        {message.status === 'loading' || message.status === 'idle' ? (
          <LoadingState text="본문을 불러오는 중입니다…" />
        ) : message.status === 'error' ? (
          <p className="form-problem" role="alert">
            본문을 읽지 못했습니다. ({message.error})
          </p>
        ) : !msg ? (
          <p className="form-problem" role="alert">
            메일 파일을 찾지 못했습니다. 옮겨졌거나 지워졌는지 확인해 주세요.
          </p>
        ) : (
          <>
            {msg.hasOriginal && (
              <div className="mb-view-toggle" role="group" aria-label="본문 보기">
                <button type="button" className={cls('chip', bodyView === 'html' && 'is-on')} aria-pressed={bodyView === 'html'} data-testid="mail-view-html" onClick={() => setBodyView('html')}>
                  원본
                </button>
                <button type="button" className={cls('chip', bodyView === 'text' && 'is-on')} aria-pressed={bodyView === 'text'} data-testid="mail-view-text" onClick={() => setBodyView('text')}>
                  글
                </button>
              </div>
            )}
            {msg.hasOriginal && bodyView === 'html' ? (
              <MailHtmlView path={msg.path} />
            ) : (
              <div className="mb-body" data-testid="mail-body">
                {msg.body === '' ? '(본문 없음)' : msg.body}
              </div>
            )}
            {msg.truncated && <p className="field-note">본문이 길어 앞 100,000자만 보입니다. 전체는 Obsidian에서 여세요.</p>}
            {msg.attachments.length > 0 && (
              <section className="mb-section" aria-labelledby="mb-att-title" data-testid="mail-attachments">
                <h2 id="mb-att-title" className="mb-section-title">
                  첨부 {msg.attachments.length}개
                </h2>
                <ul className="mb-attachments">
                  {msg.attachments.map((a, i) => (
                    <li key={`${i}:${a.name}`} className="mb-attachment" data-testid="mail-attachment" data-blocked={a.blocked ? 'true' : 'false'}>
                      <IconAttach size={14} />
                      <span className="mb-attachment-name">{a.name}</span>
                      <span className="mb-attachment-meta">
                        {[sizeText(a.size), a.contentType].filter(Boolean).join(' · ')}
                        {a.blocked && ' · 저장 안 함(실행형)'}
                      </span>
                      {!a.blocked && a.rel && (
                        <button
                          type="button"
                          className="link-btn"
                          data-testid="btn-mail-attachment-reveal"
                          title="탐색기에서 이 첨부가 있는 폴더를 엽니다(파일은 열지 않습니다)"
                          onClick={() => props.onReveal(i)}
                        >
                          폴더에서 보기
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <ThreadList detail={detail} current={mail.key} today={today} onSelectMail={props.onSelectMail} />
        <Links detail={detail} mail={mail} today={today} onOpenTask={props.onOpenTask} onOpenVoc={props.onOpenVoc} onOpenQueue={props.onOpenQueue} />
      </div>
    </section>
  );
}
