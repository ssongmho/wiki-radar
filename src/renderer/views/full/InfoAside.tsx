// 풀스크린 오른쪽 열: 원 메일 · 출처 · 연결된 줄. 내 담당 VOC 할 일(2.6단계 §5)은 위키에 줄·메일이 없어 'VOC 티켓' 한 칸만.
// 팀 위키 할 일(2.9단계 §4-2)은 '팀 위키' 칸(문서·담당)과 연결된 줄(팀 사본의 그 줄 — 누르면 팀 사본 문서를 연다).
// 메일 본문 요약은 데이터일 뿐이다 — 글자로만 보여 주고 HTML·링크로 해석하지 않는다.
import type { ReactElement, Ref } from 'react';
import type { MailSummary, Task } from '../../../shared/types';
import { IconExternal, IconFile, IconLink, IconMail, IconTicket, IconUser } from '../../components/Icons';
import { useMail } from '../../hooks/useMail';
import { showVocTicket } from '../../hooks/useVocCreate';
import { formatMailDate, yearOf } from '../../lib/date';
import { fileLabel, isTeamTask, isVocTask, numberOf, senderName, splitSources, teamDocOf, teamOwnersOf, textOf } from '../../lib/tasks';

interface SectionProps {
  task: Task | null;
  onOpenFile: (path: string) => void;
}

function MailCard({ mail, path, today, onOpenFile }: { mail: MailSummary; path: string; today: string; onOpenFile: (p: string) => void }): ReactElement {
  const from = senderName(mail.from);
  const date = formatMailDate(mail.date, { refYear: yearOf(today) });
  const excerpt = textOf(mail.excerpt);
  return (
    <div className="mail-card">
      <p className="mail-subject" data-testid="mail-subject">
        {textOf(mail.subject) ?? fileLabel(path)}
      </p>
      {(from || date) && (
        <p className="mail-meta">
          {from && <span title={textOf(mail.from)}>{from}</span>}
          {date && <span>{date}</span>}
        </p>
      )}
      {excerpt && <p className="mail-excerpt">{excerpt}</p>}
      <button type="button" className="link-btn" onClick={() => onOpenFile(path)}>
        <IconExternal size={14} />
        메일 원문 열기
      </button>
    </div>
  );
}

function MailSection({ task, version, today, onOpenFile }: SectionProps & { version: string; today: string }): ReactElement {
  const path = textOf(task?.mail);
  const state = useMail(path, version);
  let body: ReactElement;
  switch (state.status) {
    case 'none':
      body = <p className="empty-note">연결된 메일이 없습니다.</p>;
      break;
    case 'loading':
      body = (
        <p className="empty-note" role="status">
          메일을 불러오는 중입니다…
        </p>
      );
      break;
    case 'missing':
      body = (
        <div className="mail-card mail-card--missing">
          <p className="empty-note">메일 파일을 찾지 못했습니다.</p>
          <p className="path-text">{path}</p>
        </div>
      );
      break;
    case 'error':
      body = <p className="empty-note">메일을 불러오지 못했습니다. ({state.message})</p>;
      break;
    case 'ready':
      // 할 일 줄이 메일 ID([mail:: m:…] — 2.15)면 main 이 푼 경로(state.mail.path)를 쓴다
      body = <MailCard mail={state.mail} path={state.mail.path || path || ''} today={today} onOpenFile={onOpenFile} />;
      break;
  }
  return (
    <section className="aside-section" aria-labelledby="aside-mail-title">
      <h2 id="aside-mail-title" className="sub-title">
        <IconMail size={16} />
        원 메일
      </h2>
      {body}
    </section>
  );
}

function SourceSection({ task, onOpenFile }: SectionProps): ReactElement {
  const sources = splitSources(task?.src);
  return (
    <section className="aside-section aside-section--tight" aria-labelledby="aside-src-title">
      <h2 id="aside-src-title" className="sub-title">
        <IconFile size={16} />
        출처
      </h2>
      {sources.length === 0 ? (
        <p className="empty-note">기록된 출처가 없습니다.</p>
      ) : (
        <ul className="link-list">
          {sources.map((src) => {
            const content = (
              <>
                <span className="link-row-text">
                  <span className="link-row-name">{src.name}</span>
                  {src.folder && <span className="link-row-hint">{src.folder}</span>}
                </span>
                {src.openPath && <IconExternal size={14} className="link-row-icon" />}
              </>
            );
            const openPath = src.openPath;
            return (
              <li key={src.key}>
                {openPath ? (
                  <button type="button" className="link-row" title={`${openPath} — Obsidian에서 열기`} onClick={() => onOpenFile(openPath)}>
                    {content}
                  </button>
                ) : (
                  <div className="link-row link-row--static">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LineSection({ task, onOpenFile }: SectionProps): ReactElement {
  const file = textOf(task?.file);
  const line = numberOf(task?.line);
  const rawLine = textOf(task?.rawLine);
  const anchors = Array.isArray(task?.anchors) ? task.anchors : [];
  let body: ReactElement;
  if (file) {
    body = (
      <>
        <button type="button" className="link-btn link-btn--path" title="Obsidian에서 열기" onClick={() => onOpenFile(file)}>
          <IconExternal size={14} />
          <span className="link-btn-text">
            {file}
            {line !== undefined && `:${line}`}
          </span>
        </button>
        {rawLine && <pre className="raw-line">{rawLine}</pre>}
      </>
    );
  } else if (anchors.length > 0) {
    body = (
      <>
        <p className="empty-note">앵커 줄을 찾지 못했습니다. 위키에서 이 문구가 들어간 체크박스 줄을 확인해 주세요.</p>
        <ul className="anchor-list">
          {anchors.map((anchor, i) => (
            <li key={`${anchor.file}|${anchor.match}|${i}`}>
              <span className="path-text">{anchor.file}</span>
              <span className="anchor-match">“{anchor.match}”</span>
            </li>
          ))}
        </ul>
      </>
    );
  } else {
    body = <p className="empty-note">연결된 위키 줄이 없습니다.</p>;
  }
  return (
    <section className="aside-section" aria-labelledby="aside-line-title">
      <h2 id="aside-line-title" className="sub-title">
        <IconLink size={16} />
        연결된 줄
      </h2>
      {body}
    </section>
  );
}

export interface InfoAsideProps {
  task: Task | null;
  /** 스냅샷 생성 시각(메일 요약을 다시 읽을지 판단) */
  version: string;
  today: string;
  onOpenFile: (path: string) => void;
  /** 팀 사본 문서 열기(팀 할 일의 연결된 줄) */
  onOpenTeamDoc?: (path: string) => void;
  ref?: Ref<HTMLElement>;
}

/** 팀 위키 할 일: 문서 · 담당 */
function TeamSection({ task }: { task: Task }): ReactElement {
  const owners = teamOwnersOf(task);
  return (
    <section className="aside-section" aria-labelledby="aside-team-title" data-testid="aside-team">
      <h2 id="aside-team-title" className="sub-title">
        <IconFile size={16} />
        팀 위키
      </h2>
      <p className="path-text">{teamDocOf(task) ?? textOf(task.file)}</p>
      <p className="aside-team-owner">
        <IconUser size={14} />
        {owners.length > 0 ? `담당 ${owners.join(', ')}` : '미배정'}
      </p>
      <p className="empty-note">팀 위키에서 온 할 일이라 원 메일·출처가 없습니다. 상태·담당·기한은 가운데 ‘팀 할 일 입력’으로 팀 위키에 씁니다.</p>
    </section>
  );
}

/** VOC 할 일: 번호 + 위키에 줄이 없다는 안내 + VOC 화면에서 보기 */
function VocSection({ task }: { task: Task }): ReactElement {
  const number = textOf(task.voc?.number);
  const ticketId = numberOf(task.voc?.id);
  return (
    <section className="aside-section" aria-labelledby="aside-voc-title">
      <h2 id="aside-voc-title" className="sub-title">
        <IconTicket size={16} />
        VOC 티켓
      </h2>
      {number && <p className="path-text">{number}</p>}
      <p className="empty-note aside-voc-note">VOC 에서 온 할 일이라 원 메일·출처·연결된 위키 줄이 없습니다. 처리는 가운데 ‘VOC 처리’에서 VOC 에 남깁니다.</p>
      {ticketId !== undefined && (
        <button type="button" className="link-btn" onClick={() => showVocTicket(ticketId)}>
          <IconTicket size={14} />
          VOC 화면에서 보기
        </button>
      )}
    </section>
  );
}

export function InfoAside({ task, version, today, onOpenFile, onOpenTeamDoc, ref }: InfoAsideProps): ReactElement {
  return (
    <aside className="fv-aside scroll" aria-label="연결된 정보" ref={ref}>
      {task && isVocTask(task) && <VocSection task={task} />}
      {task && isTeamTask(task) && (
        <>
          <TeamSection task={task} />
          <LineSection task={task} onOpenFile={onOpenTeamDoc ?? (() => undefined)} />
        </>
      )}
      {task && !isVocTask(task) && !isTeamTask(task) && (
        <>
          <MailSection task={task} version={version} today={today} onOpenFile={onOpenFile} />
          <SourceSection task={task} onOpenFile={onOpenFile} />
          <LineSection task={task} onOpenFile={onOpenFile} />
        </>
      )}
    </aside>
  );
}
