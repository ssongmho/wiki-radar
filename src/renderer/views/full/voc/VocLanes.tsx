// VOC 화면 왼쪽 칸 목록(2.6단계 명세 §3-1): 미배정(맨 위, 건이 있으면 앰버) · 나 · 팀원들.
// 줄마다 이름·건수·(있으면) SLA 초과(코랄)·임박(앰버)·P1·가장 오래된 경과일. 칸은 Tab 순서로 옮긴다(위/아래 키는 티켓 목록).
import type { ReactElement } from 'react';
import type { VocLane } from '../../../../shared/types';
import { IconTicket, IconUser } from '../../../components/Icons';
import { cls } from '../../../lib/cls';
import { laneAriaLabel, laneSubLabel, laneSummaryParts } from '../../../lib/voc';

export interface VocLanesProps {
  lanes: readonly VocLane[];
  selectedKey: string | null;
  onSelect: (lane: VocLane) => void;
}

export function VocLanes({ lanes, selectedKey, onSelect }: VocLanesProps): ReactElement {
  return (
    <nav className="vv-lanes scroll" aria-label="담당 칸">
      <ul className="vv-lane-list">
        {lanes.map((lane) => {
          const selected = lane.key === selectedKey;
          const unassigned = lane.key === 'unassigned';
          const parts = laneSummaryParts(lane.summary);
          const sub = laneSubLabel(lane);
          return (
            <li key={lane.key}>
              <button
                type="button"
                className={cls(
                  'vv-lane',
                  selected && 'is-selected',
                  unassigned && 'vv-lane--unassigned',
                  unassigned && lane.summary.total > 0 && 'is-attention',
                )}
                data-testid="voc-lane"
                data-lane={lane.key}
                data-count={lane.summary.total}
                aria-current={selected ? 'true' : undefined}
                aria-label={laneAriaLabel(lane)}
                onClick={() => onSelect(lane)}
              >
                <span className="vv-lane-head">
                  {unassigned ? <IconTicket size={16} /> : <IconUser size={16} />}
                  <span className="vv-lane-name">
                    {lane.label}
                    {sub && <span className="vv-lane-sub">{sub}</span>}
                  </span>
                  <span className={cls('vv-lane-count', lane.summary.total === 0 && 'is-zero')}>{lane.summary.total}</span>
                </span>
                {parts.length > 0 && (
                  <span className="vv-lane-meta" aria-hidden="true">
                    {parts.map((p) => (
                      <span key={p.key} className={cls('vv-lane-part', p.tone && `tone-${p.tone}`)}>
                        {p.text}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
