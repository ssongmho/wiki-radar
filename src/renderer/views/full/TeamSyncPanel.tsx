// 설정 › 점검 칸의 「팀 위키 동기화」 칸(2.8단계 명세 docs/stage2.8-contract.md).
// 상태·지금 동기화·많이 지우거나 덮어쓸 때의 확인·충돌·최근 변경·Obsidian·폴더 열기. 켜기·끄기와 경로는 설정 › 위키 칸(2.13단계 §C-1)에서 정한다.
import { useEffect, useState, type ReactElement } from 'react';
import { IconAlert, IconCheck, IconExternal, IconFolder, IconRefresh, IconSettings } from '../../components/Icons';
import type { TeamSyncHook } from '../../hooks/useTeamSync';
import { cls } from '../../lib/cls';
import { agoText, changeText, teamSyncSummary } from '../../lib/teamSync';

const TONE_ICON = {
  ok: <IconCheck size={16} />,
  off: <IconAlert size={16} />,
  warn: <IconAlert size={16} />,
  wait: <IconRefresh size={16} />,
} as const;

export function TeamSyncPanel({
  sync,
  onFix,
}: {
  sync: TeamSyncHook;
  /** [고치기] — 설정 › 위키 칸을 연다(점검 칸에서만). 켜기·경로는 그 칸에서 정한다(2.13단계 §C-1) */
  onFix?: () => void;
}): ReactElement | null {
  const { status } = sync;
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // "3분 전" 같은 글자가 멈춰 있지 않게
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!sync.supported) return null;
  if (!status) {
    return (
      <li className="setup-item is-wait" data-testid="setup-teamsync">
        <span className="setup-mark" aria-hidden="true">
          <IconRefresh size={16} />
        </span>
        <div className="setup-body">
          <p className="setup-head">
            <span className="setup-title">팀 위키 동기화</span>
            <span className="setup-state">확인 중</span>
          </p>
        </div>
      </li>
    );
  }

  const sum = teamSyncSummary(status, now);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className={cls('setup-item', `is-${sum.tone}`)}
      data-testid="setup-teamsync"
      data-tone={sum.tone}
      data-phase={status.phase}
      aria-labelledby="setup-teamsync-title"
    >
      <span className="setup-mark" aria-hidden="true">
        {TONE_ICON[sum.tone]}
      </span>
      <div className="setup-body">
        <p className="setup-head">
          <span id="setup-teamsync-title" className="setup-title">
            팀 위키 동기화
          </span>
          <span className="setup-state" data-testid="setup-teamsync-state">
            {sum.state}
          </span>
        </p>
        <p className="setup-detail">{sum.detail}</p>

        {status.enabled && (
          <p className="setup-path" title={`${status.remote} ↔ ${status.local}`}>
            {status.remote} ↔ {status.local}
          </p>
        )}

        {sync.error && (
          <p className="form-problem" role="alert" data-testid="ts-error">
            {sync.error}
          </p>
        )}

        {status.phase === 'paused' && status.pending && (
          <div className="ts-pending" role="alert" data-testid="ts-pending">
            <p>
              지울 것 <strong>{status.pending.deletes}</strong>개 · 덮어쓸 것 <strong>{status.pending.overwrites}</strong>개. NAS 연결이
              끊겼거나 폴더를 잘못 지정한 것이 아닌지 확인하세요. 지우는 것은 휴지통(`.휴지통`)으로 옮겨집니다.
            </p>
            {status.pending.sample.length > 0 && (
              <ul className="ts-sample">
                {status.pending.sample.map((rel) => (
                  <li key={rel}>{rel}</li>
                ))}
              </ul>
            )}
            <div className="setup-actions">
              <button type="button" className="btn btn--primary" data-testid="ts-confirm" disabled={busy} onClick={() => void act(() => sync.run(true))}>
                확인하고 계속
              </button>
            </div>
          </div>
        )}

        {status.enabled && status.last && status.last.conflicts.length > 0 && (
          <div className="ts-conflicts" data-testid="ts-conflicts">
            <p className="field-label">충돌 사본 — 원본과 합친 뒤 사본을 지우세요</p>
            <ul className="ts-sample">
              {status.last.conflicts.map((rel) => (
                <li key={rel}>{rel}</li>
              ))}
            </ul>
          </div>
        )}

        {status.enabled && status.recent.length > 0 && (
          <details className="ts-recent">
            <summary>최근 변경 {status.recent.length}건</summary>
            <ul className="ts-sample">
              {status.recent.slice(0, 15).map((c) => (
                <li key={`${c.at}-${c.dir}-${c.rel}`}>
                  <span className="ts-dir">{changeText(c.dir)}</span> {c.rel} <span className="ts-ago">{agoText(c.at, now)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {status.enabled && status.last && status.last.skipped.length > 0 && (
          <p className="field-note" data-testid="ts-skipped">
            건너뛴 파일 {status.last.skipped.length}개(다음 동기화 때 다시 봅니다): {status.last.skipped[0].rel} — {status.last.skipped[0].reason}
          </p>
        )}

        <div className="setup-actions">
          {status.enabled && (
            <>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="ts-run"
                disabled={busy || status.phase === 'running'}
                onClick={() => void act(() => sync.run(false))}
              >
                <IconRefresh size={16} />
                {status.phase === 'running' ? '동기화 중…' : '지금 동기화'}
              </button>
              <button type="button" className="btn btn--secondary" data-testid="ts-open-obsidian" onClick={() => void sync.open('obsidian')}>
                <IconExternal size={16} />
                Obsidian 으로 열기
              </button>
              <button type="button" className="btn btn--secondary" data-testid="ts-open-folder" onClick={() => void sync.open('folder')}>
                <IconFolder size={16} />
                폴더 열기
              </button>
            </>
          )}
          {onFix && (
            <button type="button" className="btn btn--secondary" data-testid="setup-teamsync-fix" onClick={onFix}>
              <IconSettings size={16} />
              {status.enabled ? '고치기' : '설정 › 위키에서 켜기'}
            </button>
          )}
        </div>
        {status.enabled && (
          <p className="field-note">
            Obsidian 에서 처음이면 「보관함 폴더 열기」로 위 내 PC 폴더를 한 번 여세요. 같은 문서를 동시에 고치면 둘 다 남습니다(충돌 사본).
          </p>
        )}
      </div>
    </li>
  );
}
