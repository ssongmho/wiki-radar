// 저장 결과 알림: 고친 파일 수·백업 위치·로그/메모 처리·대기열, 못 찾은 앵커·경고는 경고색.
// 상세 열 아래쪽에 자기 자리를 차지해(본문 위에 겹치지 않는다) 스크롤해도 보인다. 경고·실패는 닫을 때까지 남고, 문제없으면 잠시 뒤 사라진다.
import { useEffect, type ReactElement } from 'react';
import { IconAlert, IconCheck, IconClose } from '../../components/Icons';
import { cls } from '../../lib/cls';
import type { SaveNotice as SaveNoticeData } from '../../lib/result';

const AUTO_HIDE_MS = 12_000;

export interface SaveNoticeProps {
  notice: SaveNoticeData;
  onClose: () => void;
}

export function SaveNotice({ notice, onClose }: SaveNoticeProps): ReactElement {
  useEffect(() => {
    if (notice.tone !== 'ok') return;
    const timer = window.setTimeout(onClose, AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.tone, onClose]);

  const isError = notice.tone === 'error';
  return (
    <div
      className={cls('save-notice', `save-notice--${notice.tone}`)}
      data-testid="save-notice"
      data-tone={notice.tone}
      role={isError ? 'alert' : 'status'}
    >
      <div className="save-notice-head">
        {notice.tone === 'ok' ? <IconCheck size={16} /> : <IconAlert size={16} />}
        <p className="save-notice-title">{notice.title}</p>
        <button type="button" className="icon-btn save-notice-close" aria-label="저장 결과 알림 닫기" onClick={onClose}>
          <IconClose size={16} />
        </button>
      </div>
      {notice.lines.length > 0 && (
        <ul className="save-notice-lines">
          {notice.lines.map((line, i) => (
            <li key={`${i}:${line.text}`} className={cls(line.warn && 'is-warn')}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
