// 로컬 LLM 메일 분석(docs/stage2.16-contract.md §4) — 읽기 칸의 「분석」 자리.
// 요약 · 종류 · 회신 필요(추정)·이유 · 기한 단서 · 할 일 후보([할 일로] 칸을 채움) · VOC 후보 · [분석]/[다시 분석].
// 결과는 추정이다 — 사람이 켜는 [회신 필요] 표시와 섞지 않고, 할 일·VOC 는 만들지 않고 입력 칸만 채운다.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { MailAnalysis, MailAnalysisKind, MailAnalysisView } from '../../../../shared/types';
import { getRadar } from '../../../api';
import { IconChecklist, IconRefresh, IconTicket } from '../../../components/Icons';
import { errorText } from '../../../lib/snapshot';

export const MAIL_ANALYSIS_KIND_LABEL: Readonly<Record<MailAnalysisKind, string>> = {
  request: '요청',
  question: '질문',
  info: '알림·공유',
  meeting: '회의·일정',
  ad: '광고·홍보',
  other: '기타',
};

/** 'YYYY-MM-DD' → 'M/D' */
function shortDay(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}`;
}

export interface MailAnalysisPanelProps {
  mailKey: string;
  /** 할 일 후보로 [할 일로] 칸 열기 */
  onTask?: (task: NonNullable<MailAnalysis['task']>) => void;
  /** VOC 후보 → [VOC로 등록] */
  onVoc?: () => void;
}

export function MailAnalysisPanel({ mailKey, onTask, onVoc }: MailAnalysisPanelProps): ReactElement | null {
  const api = getRadar();
  const supported = !!api && typeof api.getMailAnalysis === 'function';
  const [view, setView] = useState<MailAnalysisView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!supported || !api) return;
    api.getMailAnalysis?.(mailKey).then(
      (v) => setView(v),
      (err: unknown) => setError(errorText(err)),
    );
  }, [api, supported, mailKey]);

  useEffect(() => {
    setView(null);
    setError('');
    load();
    const off = api?.onMailAnalysis?.((e) => {
      if (e.key === mailKey) load();
    });
    return () => off?.();
  }, [api, mailKey, load]);

  if (!supported || !api) return null;

  const analyze = async (force: boolean): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const v = await api.analyzeMail?.({ key: mailKey, force });
      if (v) setView(v);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const a = view?.analysis;
  const status = busy ? 'running' : view?.status ?? 'none';
  return (
    <section className="mb-analysis" aria-label="분석(로컬 LLM)" data-testid="mail-analysis" data-status={status}>
      {a ? (
        <>
          <p className="mb-analysis-summary" data-testid="mail-analysis-summary">
            <span className="chip mb-analysis-kind" data-testid="mail-analysis-kind">
              {MAIL_ANALYSIS_KIND_LABEL[a.kind]}
            </span>
            {a.summary}
          </p>
          <ul className="mb-analysis-lines">
            {a.reply && (
              <li data-testid="mail-analysis-reply">
                <strong>회신 필요(추정)</strong>
                {a.replyReason ? ` — ${a.replyReason}` : ''}
              </li>
            )}
            {a.due && <li data-testid="mail-analysis-due">기한 단서: {shortDay(a.due)}</li>}
            {a.task && (
              <li data-testid="mail-analysis-task">
                할 일 후보: {a.task.title}
                {a.task.due ? ` (~${shortDay(a.task.due)})` : ''}
                {onTask && (
                  <button type="button" className="link-btn" data-testid="mail-analysis-task-use" onClick={() => onTask(a.task as NonNullable<MailAnalysis['task']>)}>
                    <IconChecklist size={14} />
                    할 일로
                  </button>
                )}
              </li>
            )}
            {a.voc && (
              <li data-testid="mail-analysis-voc">
                VOC 후보: {a.voc.reason}
                {onVoc && (
                  <button type="button" className="link-btn" data-testid="mail-analysis-voc-use" onClick={onVoc}>
                    <IconTicket size={14} />
                    VOC로 등록
                  </button>
                )}
              </li>
            )}
          </ul>
          <p className="mb-analysis-foot">
            로컬 LLM({a.model}) 추정 — 확인하고 쓰세요.
            <button type="button" className="link-btn" data-testid="mail-analysis-again" disabled={busy} onClick={() => void analyze(true)}>
              <IconRefresh size={14} />
              {busy ? '분석 중…' : '다시 분석'}
            </button>
          </p>
        </>
      ) : status === 'off' ? (
        <p className="mb-analysis-off" data-testid="mail-analysis-off">
          {view?.problem ?? '설정 › AI 에서 로컬 LLM 을 넣고 [연결 시험]을 하면 메일을 분석합니다'}
        </p>
      ) : (
        <p className="mb-analysis-off">
          {status === 'running' ? '분석 중…' : status === 'queued' ? '분석 대기 중' : status === 'error' ? `분석하지 못했습니다(${view?.problem ?? ''})` : '아직 분석하지 않았습니다'}
          {status !== 'running' && (
            <button type="button" className="link-btn" data-testid="mail-analysis-run" disabled={busy} onClick={() => void analyze(status === 'error')}>
              <IconRefresh size={14} />
              {status === 'error' ? '다시 분석' : '분석'}
            </button>
          )}
        </p>
      )}
      {error && (
        <p className="form-problem" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
