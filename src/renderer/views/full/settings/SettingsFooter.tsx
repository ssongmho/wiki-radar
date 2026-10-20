// 설정 칸 공통 바닥(2.13단계 명세 §C-0): [저장] · [되돌리기] · [연결 시험] · 상태 글.
import type { ReactElement, ReactNode } from 'react';
import type { ConnectionTestResult } from '../../../../shared/types';
import { IconCheck, IconRefresh, IconUndo } from '../../../components/Icons';
import type { SectionStatus } from '../../../hooks/useSettingsSection';
import { cls } from '../../../lib/cls';
import { TestResult } from './TestResult';

export interface SettingsFooterProps {
  dirty: boolean;
  /** 검사 문제가 있어 저장·시험할 수 없다 */
  blocked: boolean;
  saving: boolean;
  testing?: boolean;
  status: SectionStatus | null;
  testResult?: ConnectionTestResult | null;
  onSave: () => void;
  onRevert: () => void;
  /** 없으면 [연결 시험] 없음 */
  onTest?: () => void;
  /** 단추 위 덧붙임(위키 다시 시작 안내 등) */
  extra?: ReactNode;
}

export function SettingsFooter({ dirty, blocked, saving, testing, status, testResult, onSave, onRevert, onTest, extra }: SettingsFooterProps): ReactElement {
  return (
    <div className="sv-footer">
      {testResult && <TestResult result={testResult} />}
      {extra}
      <div className="qv-actions">
        <button type="button" className="btn btn--primary" data-testid="sv-save" disabled={!dirty || blocked || saving} onClick={onSave}>
          <IconCheck size={16} />
          {saving ? '저장 중…' : '저장'}
        </button>
        <button type="button" className="btn btn--secondary" data-testid="sv-revert" disabled={!dirty || saving} onClick={onRevert}>
          <IconUndo size={16} />
          되돌리기
        </button>
        {onTest && (
          <button type="button" className="btn btn--secondary" data-testid="sv-test" disabled={!!testing || saving || blocked} onClick={onTest}>
            <IconRefresh size={16} />
            {testing ? '시험 중…' : '연결 시험'}
          </button>
        )}
      </div>
      <p
        className={cls('sv-status', status?.tone === 'error' && 'is-error', status?.tone === 'ok' && 'is-ok')}
        data-testid="sv-status"
        data-tone={status?.tone ?? 'idle'}
        role="status"
      >
        {status ? status.text : dirty ? '저장하지 않은 변경이 있습니다.' : '저장하면 다시 시작하지 않아도 바로 적용됩니다.'}
      </p>
    </div>
  );
}
