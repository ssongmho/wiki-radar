// VOC 쓰기 결과 알림(2.6단계 명세 §4): 성공은 잠시 뒤 사라지고, 실패는 서버 문장을 그대로 보이며 닫을 때까지 남는다.
// 모양은 저장 결과 알림(SaveNotice)과 같다 — 상세 열 아래쪽에 자기 자리를 차지한다.
import { useEffect, type ReactElement } from 'react';
import { IconAlert, IconCheck, IconClose } from '../../../components/Icons';
import { cls } from '../../../lib/cls';
import type { VocActionNotice } from '../../../lib/voc';

const AUTO_HIDE_MS = 12_000;

export function VocNotice({ notice, onClose }: { notice: VocActionNotice; onClose: () => void }): ReactElement {
  useEffect(() => {
    if (notice.tone !== 'ok') return;
    const timer = window.setTimeout(onClose, AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.tone, onClose]);

  const isError = notice.tone === 'error';
  return (
    <div
      className={cls('save-notice', isError ? 'save-notice--error' : 'save-notice--ok')}
      data-testid="voc-action-notice"
      data-tone={notice.tone}
      data-kind={notice.kind}
      role={isError ? 'alert' : 'status'}
    >
      <div className="save-notice-head">
        {isError ? <IconAlert size={16} /> : <IconCheck size={16} />}
        <p className="save-notice-title">{notice.title}</p>
        <button type="button" className="icon-btn save-notice-close" aria-label="VOC 결과 알림 닫기" onClick={onClose}>
          <IconClose size={16} />
        </button>
      </div>
      {notice.lines.length > 0 && (
        <ul className="save-notice-lines">
          {notice.lines.map((line, i) => (
            <li key={`${i}:${line}`} className={cls(isError && 'is-warn')}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
