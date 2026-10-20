// 메일함 안의 VOC 등록 화면(2.10단계 명세 §7-2·§8-3, 시안 Mail-2 틀): 가운데 = 2.6 VocCreatePanel(메일 대상),
// 오른쪽 = 「등록하면」(할 일 줄에 붙는지 / 메일 상태에만 남는지) · 같은 스레드로 만든 티켓(사실만) · 원본 메일.
// 시안의 「중복 확인(비슷한 진행 중 티켓)」은 분석 기능이라 넣지 않는다.
import { useEffect, useRef, type ReactElement } from 'react';
import type { MailThreadDetail, MailThreadMail } from '../../../../shared/types';
import { IconBack, IconTicket } from '../../../components/Icons';
import { useVocCreateEntry } from '../../../hooks/useVocCreate';
import { mailDateText, mailTargetKey } from '../../../lib/mailbox';
import { VocCreatePanel } from '../VocCreatePanel';

export interface MailVocViewProps {
  mail: MailThreadMail;
  detail: MailThreadDetail;
  today: string;
  onBack: () => void;
  onOpenVoc: (number: string) => void;
}

export function MailVocView({ mail, detail, today, onBack, onOpenVoc }: MailVocViewProps): ReactElement {
  const entry = useVocCreateEntry(mailTargetKey(mail.path));
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [mail.path]);
  const linkedTask = entry.mailLink?.taskId ? detail.links.tasks.find((t) => t.taskId === entry.mailLink?.taskId) : undefined;
  const sameThread = [
    ...new Set([...(entry.mailLink?.threadVoc ?? []), ...detail.mails.filter((m) => m.key !== mail.key && m.voc).map((m) => m.voc as string)]),
  ];
  const created = entry.created?.number ?? mail.voc;

  return (
    <>
      <section className="mb-sub-main scroll" data-testid="mail-voc-view" aria-labelledby="mb-voc-title">
        <div className="mb-sub-head">
          <button type="button" className="link-btn" data-testid="btn-mail-back" onClick={onBack}>
            <IconBack size={16} />
            메일로 돌아가기
          </button>
        </div>
        <h1 id="mb-voc-title" className="mb-sub-title" tabIndex={-1} ref={headingRef}>
          VOC로 등록 — {mail.subject || '(제목 없음)'}
        </h1>
        {sameThread.length > 0 && !created && (
          <p className="mb-linked-note" data-testid="mail-voc-same-thread">
            <IconTicket size={16} />
            같은 스레드로 만든 티켓: {sameThread.join(', ')}
          </p>
        )}
        {created && (
          <p className="mb-linked-note mb-linked-note--ok" data-testid="mail-voc-done" data-number={created}>
            <IconTicket size={16} />
            <span>{created} 로 등록했습니다.</span>
            <button type="button" className="link-btn" onClick={() => onOpenVoc(created)}>
              VOC 화면에서 보기
            </button>
          </p>
        )}
        <VocCreatePanel mail={{ path: mail.path }} />
      </section>
      <aside className="mb-sub-aside scroll" aria-label="등록 참고">
        <section className="mb-aside-section">
          <h2 className="mb-section-title">등록하면</h2>
          <ul className="mb-aside-list mb-aside-list--text">
            <li>VOC 에 새 티켓이 만들어집니다(요청 경로 email). 담당을 고르면 그 사람에게 배정 메일이 갑니다.</li>
            {linkedTask ? (
              <li>
                이 메일은 할 일 「{linkedTask.title}」과 연결돼 있어, 그 할 일 줄 끝에 <code>[voc:: 번호]</code>를 붙입니다(쓰기 전에 백업).
              </li>
            ) : (
              <li>연결된 할 일이 없어(또는 둘 이상이라) 위키에는 쓰지 않고, 번호를 메일 상태(앱 데이터)에만 남깁니다.</li>
            )}
            <li>메일함 목록과 읽기 칸에 「VOC-…」 배지가 붙습니다.</li>
          </ul>
        </section>
        <section className="mb-aside-section">
          <h2 className="mb-section-title">원본 메일</h2>
          <p className="mb-aside-meta">
            {mail.from} · {mailDateText(mail.date, today)} · {mail.folder}
          </p>
          <p className="mb-aside-subject">{mail.subject || '(제목 없음)'}</p>
        </section>
      </aside>
    </>
  );
}
