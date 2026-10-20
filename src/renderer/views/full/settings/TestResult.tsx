// 연결 시험 결과(2.13단계 명세 §C-0): 단계 목록(연결 · 보안 · 로그인 · …) 각 줄 표시와 걸린 시간.
import type { ReactElement } from 'react';
import type { ConnectionTestResult } from '../../../../shared/types';
import { IconAlert, IconCheck } from '../../../components/Icons';
import { cls } from '../../../lib/cls';
import { stepTone } from '../../../lib/settings';

export function TestResult({ result }: { result: ConnectionTestResult }): ReactElement {
  return (
    <div className={cls('sv-test', result.ok ? 'is-ok' : 'is-fail')} data-testid="sv-test-result" data-ok={result.ok ? 'true' : 'false'} role="status">
      <p className="sv-test-head">
        <span>{result.ok ? '연결 시험 성공' : '연결 시험 실패'}</span>
        <span className="sv-test-ms">{(result.ms / 1000).toFixed(1)}초</span>
      </p>
      <ul className="sv-test-steps">
        {result.steps.map((s, i) => {
          const tone = stepTone(s);
          return (
            <li key={`${s.label}-${i}`} className={cls('sv-test-step', `is-${tone}`)} data-testid="sv-test-step" data-tone={tone}>
              <span className="sv-test-mark" aria-hidden="true">
                {tone === 'ok' ? <IconCheck size={14} /> : <IconAlert size={14} />}
              </span>
              <span className="sv-test-label">{s.label}</span>
              {s.detail && <span className="sv-test-detail">{s.detail}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
