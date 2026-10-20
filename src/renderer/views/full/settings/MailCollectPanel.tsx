// 설정 › 메일 받기 칸의 수집 줄(2.15단계 명세 §B): 상태 칩 · [지금 받기] · 메일 보관소 줄.
// 옛 preload(수집 API 없음)면 아무것도 그리지 않는다.
import { useEffect, useState, type ReactElement } from 'react';
import type { MailCollectStatus } from '../../../../shared/types';
import { getRadar } from '../../../api';
import { IconRefresh } from '../../../components/Icons';
import { errorText } from '../../../lib/snapshot';

/** ISO → 'M/D HH:MM'(로컬) */
function shortTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 상태 칩 글·색 */
export function collectChip(s: MailCollectStatus): { text: string; tone: 'muted' | 'ok' | 'amber' } {
  switch (s.state) {
    case 'off':
      return { text: '수집 꺼짐', tone: 'muted' };
    case 'noAccount':
      return { text: '계정 없음', tone: 'amber' };
    case 'collecting':
      return { text: s.progress && s.progress.total > 0 ? `받는 중 ${s.progress.done}/${s.progress.total}` : '받는 중', tone: 'muted' };
    case 'error':
      return { text: `받지 못함 ${shortTime(s.lastRun)}`.trim(), tone: 'amber' };
    default:
      if (s.lastOk) return { text: `마지막 받음 ${shortTime(s.lastOk)} · 새 메일 ${s.lastCount ?? 0}통`, tone: 'ok' };
      return { text: '켜짐 — 곧 받음', tone: 'muted' };
  }
}

/** 보관소 줄 글 */
export function storeLine(s: MailCollectStatus): string {
  return `받은 메일은 앱 데이터의 메일 보관소에 있습니다: ${s.store.newMail}`;
}

export function MailCollectPanel(): ReactElement | null {
  const api = getRadar();
  const supported = !!api && typeof api.getMailCollect === 'function';
  const [status, setStatus] = useState<MailCollectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supported || !api) return undefined;
    let alive = true;
    api.getMailCollect?.().then(
      (s) => alive && setStatus(s),
      (err: unknown) => alive && setError(errorText(err)),
    );
    const off = api.onMailCollect?.((s) => alive && setStatus(s));
    return () => {
      alive = false;
      off?.();
    };
  }, [api, supported]);

  if (!supported || !api) return null;
  if (!status) return error ? <p className="field-note" role="alert">{`수집 상태를 읽지 못했습니다. (${error})`}</p> : null;

  const chip = collectChip(status);
  const working = status.state === 'collecting' || busy;

  const run = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const s = await api.collectMailNow?.();
      if (s) setStatus(s);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const chipClass = chip.tone === 'amber' ? 'chip chip--amber' : chip.tone === 'ok' ? 'chip' : 'chip sv-chip-muted';
  return (
    <div className="sv-collect-panel" data-testid="sv-mailin-collect-panel">
      <div className="sv-collect">
        <span className={chipClass} data-testid="sv-mailin-collect" data-state={status.state}>
          {chip.text}
        </span>
        <button type="button" className="btn btn--secondary" data-testid="sv-mailin-collect-now" disabled={working || status.state === 'off' || status.state === 'noAccount'} onClick={() => void run()}>
          <IconRefresh size={16} />
          {busy ? '받는 중…' : '지금 받기'}
        </button>
      </div>
      {status.problem && status.state !== 'off' && <p className="field-note">{status.problem}</p>}
      {status.state !== 'error' && status.lastError && <p className="field-note">{status.lastError}</p>}
      <p className="field-note" data-testid="sv-mailin-store">
        {storeLine(status)}
      </p>
      {error && (
        <p className="field-note" role="alert" data-testid="sv-mailin-collect-error">
          {error}
        </p>
      )}
    </div>
  );
}
