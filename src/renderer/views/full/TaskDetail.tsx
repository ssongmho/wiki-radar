// 풀스크린 상세: 구간 경로, 제목, 칩, 배경·관련, 이전 메모, 처리 결과 입력(2단계 — 메일 할 일이면 회신 작성 칸, 2.5단계), Obsidian 에서 열기.
// 메일 할 일이면 처리 결과 입력 아래에 'VOC 로 등록'(2.6단계 §6 — 회신 칸과 따로)이 붙는다.
// 내 담당 VOC 할 일(source 'voc', 2.6단계 §5)은 위키에 줄이 없다 — 배경·메모·처리 결과 입력·Obsidian 대신 'VOC 처리'를 보인다.
// 팀 위키 할 일(source 'team', 2.9단계 §4-3)은 처리 결과 입력 대신 팀 할 일 입력(상태·담당·기한), [Obsidian에서 열기]는 팀 사본의 문서.
// 저장 결과 알림(notice)은 항목이 바뀌어도(완료로 목록에서 빠져 다음 항목으로 넘어가도) 열 아래쪽에 남는다.
// 알림은 스크롤 영역 밖(아래)에 따로 자리를 차지한다 — 폼 위에 겹쳐 [저장]·[취소]를 가리지 않고, 폼은 그 위에서 스크롤된다.
// ref 는 스크롤 영역(상세 본문)에 붙는다(항목이 바뀌면 맨 위로 올리고, 초점을 돌려놓을 요소를 찾는 데 쓴다).
import type { ReactElement, ReactNode, Ref } from 'react';
import type { Task } from '../../../shared/types';
import { Icon, IconExternal, IconMemo } from '../../components/Icons';
import { EmptyState } from '../../components/StateMessage';
import { cls } from '../../lib/cls';
import { BUCKET_INFO, bucketOf, detailChips, isTeamTask, isVocTask, taskTitle, textOf } from '../../lib/tasks';
import { canCreateVoc } from '../../lib/vocTask';
import { ResultForm, type ResultFormProps } from './ResultForm';
import { TeamTaskForm, type TeamTaskFormProps } from './TeamTaskForm';
import { VocCreatePanel } from './VocCreatePanel';
import { VocTaskPanel } from './VocTaskPanel';

export interface TaskDetailProps {
  task: Task | null;
  today: string;
  onOpenFile: (path: string) => void;
  /** 처리 결과 입력(없으면 폼을 그리지 않는다). VOC 할 일에는 주어도 그리지 않는다(VOC 처리를 보인다) */
  form?: Omit<ResultFormProps, 'task'>;
  /** 팀 위키 할 일 입력(없으면 그리지 않는다 — 옛 앱 연결). 팀 할 일에만 쓴다 */
  teamForm?: Omit<TeamTaskFormProps, 'task'>;
  /** 팀 사본의 문서를 Obsidian 에서 연다(팀 할 일의 [Obsidian에서 열기]) */
  onOpenTeamDoc?: (path: string) => void;
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

export function TaskDetail({ task, today, onOpenFile, form, teamForm, onOpenTeamDoc, notice, ref }: TaskDetailProps): ReactElement {
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
  const voc = isVocTask(task);
  const team = isTeamTask(task);
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
                <li
                  key={chip.key}
                  className={cls('chip', chip.tone && `chip--${chip.tone}`, chip.key === 'voc' && 'chip--voc')}
                  data-testid={chip.testId}
                >
                  <Icon name={chip.icon} size={14} />
                  {chip.text}
                </li>
              ))}
            </ul>
          )}
        </header>

        {voc ? (
          // VOC 할 일: 항목마다 새 칸(초점·대화상자가 앞 항목에 이어지지 않게). 입력값은 useVocCreate 가 taskId 별로 들고 있다
          <VocTaskPanel key={task.id} task={task} today={today} />
        ) : team ? (
          <>
            <p className="empty-note">
              팀 위키 할 일입니다. 상태·담당·기한은 팀 위키의 그 줄에 바로 쓰고, 처리 내용은 팀 위키 문서에 직접 적습니다.
            </p>
            {teamForm ? (
              <TeamTaskForm key={`team:${task.id}`} task={task} {...teamForm} />
            ) : (
              <p className="empty-note">이 앱 연결에는 팀 할 일 저장 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.</p>
            )}
            <div className="detail-actions">
              {file && onOpenTeamDoc ? (
                <button type="button" className="btn btn--secondary" data-testid="btn-open-team-doc" onClick={() => onOpenTeamDoc(file)}>
                  <IconExternal size={16} />
                  Obsidian에서 열기
                </button>
              ) : (
                <p className="empty-note">팀 위키 문서를 열 수 없습니다.</p>
              )}
            </div>
          </>
        ) : (
          <>
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

            {/* 메일 할 일 → VOC 등록(회신 칸과 따로, 폼 아래). 작성 칸은 useVocCreate 가 taskId 별로 들고 있다.
                key 는 폼과 따로 — 형제의 key 가 같으면 항목이 바뀔 때 앞 항목의 폼이 지워지지 않고 화면에 남는다 */}
            {canCreateVoc(task) && <VocCreatePanel key={`voc-create:${task.id}`} task={task} />}

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
          </>
        )}
      </div>
      {noticeArea}
    </main>
  );
}
