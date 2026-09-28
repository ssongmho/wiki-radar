// 풀스크린 오른쪽 열: 원 메일 · 출처 · 연결된 줄.
// 메일 본문 요약은 데이터일 뿐이다 — 글자로만 보여 주고 HTML·링크로 해석하지 않는다.
import type { ReactElement, Ref } from 'react';
import type { MailSummary, Task } from '../../../shared/types';
import { IconExternal, IconFile, IconLink, IconMail } from '../../components/Icons';
import { useMail } from '../../hooks/useMail';
import { formatMailDate, yearOf } from '../../lib/date';
import { fileLabel, numberOf, senderName, splitSources, textOf } from '../../lib/tasks';

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
      body = <MailCard mail={state.mail} path={path ?? state.mail.path} today={today} onOpenFile={onOpenFile} />;
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
  ref?: Ref<HTMLElement>;
}

export function InfoAside({ task, version, today, onOpenFile, ref }: InfoAsideProps): ReactElement {
  return (
    <aside className="fv-aside scroll" aria-label="연결된 정보" ref={ref}>
      {task && (
        <>
          <MailSection task={task} version={version} today={today} onOpenFile={onOpenFile} />
          <SourceSection task={task} onOpenFile={onOpenFile} />
          <LineSection task={task} onOpenFile={onOpenFile} />
        </>
      )}
    </aside>
  );
}
