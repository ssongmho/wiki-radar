// 할 일 한 줄(시안의 strip 모양): 왼쪽 칸(+N/영업일 등) + 제목 + 메타.
import type { ReactElement, Ref } from 'react';
import type { Bucket, Task } from '../../shared/types';
import { cls } from '../lib/cls';
import { BUCKET_ICON, BUCKET_INFO, bucketOf, rowMeta, stripCell, taskTitle } from '../lib/tasks';
import { Icon } from './Icons';

export interface TaskRowProps {
  task: Task;
  today: string;
  variant: 'sidebar' | 'full';
  selected?: boolean;
  tabIndex?: number;
  onActivate: (task: Task) => void;
  ref?: Ref<HTMLButtonElement>;
}

export function TaskRow({ task, today, variant, selected, tabIndex, onActivate, ref }: TaskRowProps): ReactElement {
  const cell = stripCell(task, today);
  const meta = rowMeta(task);
  const title = taskTitle(task);
  return (
    <button
      ref={ref}
      type="button"
      className={cls('row', `row--${variant}`, selected && 'is-selected')}
      data-testid="task-row"
      data-task-id={task.id}
      data-bucket={bucketOf(task)}
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
        <span className="row-title">{title}</span>
        {meta.length > 0 && (
          <span className="row-meta">
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
