// 풀스크린 상세: 구간 경로, 제목, 칩, 배경·관련, 이전 메모, 처리 결과 입력(2단계), Obsidian 에서 열기.
// 저장 결과 알림(notice)은 항목이 바뀌어도(완료로 목록에서 빠져 다음 항목으로 넘어가도) 열 아래쪽에 남는다.
// 알림은 스크롤 영역 밖(아래)에 따로 자리를 차지한다 — 폼 위에 겹쳐 [저장]·[취소]를 가리지 않고, 폼은 그 위에서 스크롤된다.
// ref 는 스크롤 영역(상세 본문)에 붙는다(항목이 바뀌면 맨 위로 올리고, 초점을 돌려놓을 요소를 찾는 데 쓴다).
import type { ReactElement, ReactNode, Ref } from 'react';
import type { Task } from '../../../shared/types';
import { Icon, IconExternal, IconMemo } from '../../components/Icons';
import { EmptyState } from '../../components/StateMessage';
import { cls } from '../../lib/cls';
import { BUCKET_INFO, bucketOf, detailChips, taskTitle, textOf } from '../../lib/tasks';
import { ResultForm, type ResultFormProps } from './ResultForm';

export interface TaskDetailProps {
  task: Task | null;
  today: string;
  onOpenFile: (path: string) => void;
  /** 처리 결과 입력(없으면 폼을 그리지 않는다) */
  form?: Omit<ResultFormProps, 'task'>;
  /** 저장 결과 알림 */
  notice?: ReactNode;
  /** 스크롤되는 상세 본문 */
  ref?: Ref<HTMLDivElement>;
}

/** 긴 제목(체크박스 줄 전문)은 글자를 줄인다. 시안 크기(22px)는 짧은 제목에만 쓴다. */
function titleSizeClass(title: string): string | undefined {
  if (title.length > 140) return 'detail-title--xlong';
  if (title.length > 60) return 'detail-title--long';
  return undefined;
}

export function TaskDetail({ task, today, onOpenFile, form, notice, ref }: TaskDetailProps): ReactElement {
  const noticeArea = notice ? <div className="detail-notice scroll">{notice}</div> : null;
  if (!task) {
    return (
      <main className="fv-detail" data-testid="detail">
        <div className="fv-detail-body scroll" ref={ref}>
          <EmptyState title="선택한 할 일이 없습니다.">왼쪽 목록에서 할 일을 고르면 여기에 자세히 보입니다.</EmptyState>
        </div>
        {noticeArea}
      </main>
    );
  }

  const info = BUCKET_INFO[bucketOf(task)];
  const title = taskTitle(task);
  const chips = detailChips(task, today);
  const why = textOf(task.why);
  const who = textOf(task.who);
  const memo = textOf(task.memo);
  const file = textOf(task.file);

  return (
    <main className="fv-detail" data-testid="detail" data-task-id={task.id} aria-labelledby="detail-title">
      <div className="fv-detail-body scroll" ref={ref}>
        <header className="detail-head">
          <p className="crumb">
            <span>할 일</span>
            <span aria-hidden="true">/</span>
            <span className={`tone-${info.tone}`}>{info.label}</span>
          </p>
          {/* tabIndex -1: 알림을 닫는 등으로 초점이 사라졌을 때 돌려놓을 자리(Tab 순서에는 들지 않는다) */}
          <h1 id="detail-title" className={cls('detail-title', titleSizeClass(title))} data-testid="detail-title" tabIndex={-1}>
            {title}
          </h1>
          {chips.length > 0 && (
            <ul className="chips" aria-label="할 일 속성">
              {chips.map((chip) => (
                <li key={chip.key} className={cls('chip', chip.tone && `chip--${chip.tone}`)}>
                  <Icon name={chip.icon} size={14} />
                  {chip.text}
                </li>
              ))}
            </ul>
          )}
        </header>

        {why || who ? (
          <section className="panel detail-context" aria-label="배경과 관련">
            {why && (
              <div className="field">
                <h2 className="field-label">배경</h2>
                <p className="field-body">{why}</p>
              </div>
            )}
            {who && (
              <div className="field">
                <h2 className="field-label">관련</h2>
                <p className="field-body">{who}</p>
              </div>
            )}
          </section>
        ) : (
          <p className="empty-note">
            {file ? '배경 설명이 없는 할 일입니다. 원문은 오른쪽 ‘연결된 줄’에서 볼 수 있습니다.' : '배경 설명이 없는 할 일입니다.'}
          </p>
        )}

        <section className="detail-memo" aria-labelledby="detail-memo-title">
          <h2 id="detail-memo-title" className="sub-title">
            <IconMemo size={16} />
            이전 메모
          </h2>
          {memo ? (
            <p className="memo-text" data-testid="memo">
              {memo}
            </p>
          ) : (
            <p className="empty-note">남긴 메모가 없습니다.</p>
          )}
        </section>

        {/* 항목마다 새 폼(초점·라디오 이름이 앞 항목에 이어지지 않게). 입력값은 부모가 taskId 별로 들고 있다 */}
        {form && <ResultForm key={task.id} task={task} {...form} />}

        <div className="detail-actions">
          {file ? (
            <button type="button" className="btn btn--secondary" onClick={() => onOpenFile(file)}>
              <IconExternal size={16} />
              Obsidian에서 열기
            </button>
          ) : (
            <p className="empty-note">연결된 위키 줄이 없어 Obsidian에서 열 문서가 없습니다.</p>
          )}
        </div>
      </div>
      {noticeArea}
    </main>
  );
}
