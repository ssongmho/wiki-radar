// 할 일 한 줄(시안의 strip 모양): 왼쪽 칸(+N/영업일 등) + 제목 + 메타. 내 담당 VOC 할 일(2.6단계 §5)은 메타 앞에 VOC 칩(번호).
// 팀 위키 할 일(2.9단계 §4-2)은 제목 앞에 출처 칩 — 사이드바 "팀", 풀스크린은 목록이 섞일 때 "팀 · 문서이름" / 개인 "개인".
import type { ReactElement, Ref } from 'react';
import type { Bucket, Task } from '../../shared/types';
import { cls } from '../lib/cls';
import { BUCKET_ICON, BUCKET_INFO, bucketOf, rowMeta, sourceChipText, sourceKind, stripCell, taskTitle, vocChipText } from '../lib/tasks';
import { Icon } from './Icons';

export interface TaskRowProps {
  task: Task;
  today: string;
  variant: 'sidebar' | 'full';
  selected?: boolean;
  tabIndex?: number;
  onActivate: (task: Task) => void;
  /** 개인·팀 할 일이 섞인 목록인가(팀 동기화가 켜짐) — 풀스크린에서 출처 칩을 보인다 */
  mixed?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function TaskRow({ task, today, variant, selected, tabIndex, onActivate, mixed, ref }: TaskRowProps): ReactElement {
  const cell = stripCell(task, today);
  // 사이드바(좁은 줄)의 VOC 할 일은 번호 칩·SLA 를 남기고 VOC 상태 글자는 뺀다(말줄임으로 셋 다 잘리지 않게 — 상태는 상세에)
  const meta = variant === 'sidebar' ? rowMeta(task).filter((m) => m.key !== 'voc-status') : rowMeta(task);
  const title = taskTitle(task);
  const voc = vocChipText(task);
  const kind = sourceKind(task);
  const sourceChip = sourceChipText(task, variant, mixed === true);
  return (
    <button
      ref={ref}
      type="button"
      className={cls('row', `row--${variant}`, selected && 'is-selected')}
      data-testid="task-row"
      data-task-id={task.id}
      data-bucket={bucketOf(task)}
      data-source={kind}
      aria-current={selected ? 'true' : undefined}
      tabIndex={tabIndex}
      title={title}
      onClick={() => onActivate(task)}
    >
      <span className={`strip strip--${cell.tone}`} aria-hidden="true">
        <span className="strip-top">{cell.top}</span>
        <span className="strip-sub">{cell.sub}</span>
      </span>
      <span className="sr-only">{cell.label}: </span>
      <span className="row-body">
        <span className="row-title">
          {sourceChip && (
            <span className={cls('source-chip', `source-chip--${kind}`)} data-testid="task-source-chip">
              {sourceChip}
            </span>
          )}
          {title}
        </span>
        {(meta.length > 0 || voc) && (
          <span className="row-meta">
            {voc && (
              <span className="task-voc-chip" data-testid="task-voc-chip">
                <span className="sr-only">VOC 티켓 </span>
                {voc}
              </span>
            )}
            {meta.map((item) => (
              <span key={item.key} className={cls('meta', item.tone && `meta--${item.tone}`)}>
                {item.icon && <Icon name={item.icon} size={12} />}
                {item.text}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

export interface BucketHeadingProps {
  bucket: Bucket;
  count: number;
  id?: string;
  /** 이름 뒤에 붙는 작은 풀이(예: 15영업일 이상) */
  hint?: string;
}

/** 구간 머리: 아이콘 + 이름 + 수 */
export function BucketHeading({ bucket, count, id, hint }: BucketHeadingProps): ReactElement {
  const info = BUCKET_INFO[bucket];
  return (
    <h3 id={id} className={cls('bucket-head', `tone-${info.tone}`, count === 0 && 'is-empty')}>
      <Icon name={BUCKET_ICON[bucket]} size={14} />
      <span>{info.label}</span>
      <span className="bucket-count">{count}</span>
      {hint && <span className="bucket-hint">{hint}</span>}
    </h3>
  );
}
