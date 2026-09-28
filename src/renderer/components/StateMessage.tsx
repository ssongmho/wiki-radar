// 불러오는 중·오류·빈 상태 문구
import type { ReactElement, ReactNode } from 'react';
import { IconAlert, IconRefresh } from './Icons';

export function LoadingState({ text = '할 일을 불러오는 중입니다…' }: { text?: string }): ReactElement {
  return (
    <div className="state" role="status">
      <span className="state-spinner" aria-hidden="true" />
      <p className="state-text">{text}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): ReactElement {
  return (
    <div className="state state--error" role="alert">
      <div className="state-error-text" data-testid="snapshot-error">
        <p className="state-title">
          <IconAlert size={16} />
          할 일을 불러오지 못했습니다.
        </p>
        <p className="state-detail">{message}</p>
      </div>
      {onRetry && (
        <button type="button" className="btn btn--secondary" onClick={onRetry}>
          <IconRefresh size={16} />
          다시 시도
        </button>
      )}
    </div>
  );
}

/**
 * 부분 스냅샷 안내: 읽지 못한 파일이 있어 목록이 불완전할 때(잠긴 파일 등). main 이 잠시 뒤 다시 읽어 보낸다.
 * 사이드바처럼 경고 목록이 없는 화면에서도 "지금 보이는 목록이 다가 아니다"를 알리는 한 줄이다.
 */
export function PartialNote(): ReactElement {
  return (
    <p className="partial-note" role="status" data-testid="snapshot-partial">
      <IconAlert size={14} />
      <span>일부 파일을 읽지 못해 목록이 불완전합니다. 잠시 뒤 다시 읽습니다.</span>
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }): ReactElement {
  return (
    <div className="state">
      <p className="state-title state-title--plain">{title}</p>
      {children && <p className="state-detail">{children}</p>}
    </div>
  );
}

/** 잠깐 뜨는 안내(읽기 도구가 읽도록 늘 자리를 둔다) */
export function NoticeBar({ notice }: { notice: string | null }): ReactElement {
  return (
    <div className="notice" role="status" aria-live="polite">
      {notice}
    </div>
  );
}
