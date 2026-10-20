// VOC 상태 안내 띠(2.6단계 명세 §1 표·§3-1): 보드가 ok 가 아닐 때 머리 아래에. 로그인 필요면 [로그인](앱 안 로그인 대화상자 — 명세 §13)과,
// main 이 voc-cli 를 띄울 때(WIKI_RADAR_VOC_CLI)만 '터미널에서 하려면' 아래에 접어 둔 명령 + [복사]. 로그인·토큰은 main 이 관리한다
// (앱이 VOC API 를 직접 부르면 암호화한 세션 파일, voc-cli 면 voc-cli 의 세션 — 화면은 토큰을 보지 않는다, 명세 §15).
import { useRef, type ReactElement } from 'react';
import { IconAlert, IconChevronDown, IconCopy, IconLogin, IconSettings } from '../../../components/Icons';
import { cls } from '../../../lib/cls';
import { loginCopiedText, type VocBannerInfo } from '../../../lib/voc';

/**
 * 글자를 클립보드에 넣는다. navigator.clipboard 가 막혀 있으면(권한 처리기가 거부 등) 숨은 입력 칸 + execCommand('copy'),
 * 그것도 안 되면 false(부른 쪽이 글자를 골라 두고 Ctrl+C 를 안내한다).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 아래 방법으로
  }
  try {
    const active = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    active?.focus();
    return ok;
  } catch {
    return false;
  }
}

/** 요소 안 글자를 골라 둔다(복사가 막혔을 때 Ctrl+C 로 복사할 수 있게) */
function selectContents(el: HTMLElement | null): void {
  if (!el) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

export interface VocBannerProps {
  info: VocBannerInfo;
  onSettings: () => void;
  /** [로그인] — 로그인 대화상자를 연다 */
  onLogin?: () => void;
  notify: (message: string) => void;
}

export function VocBanner({ info, onSettings, onLogin, notify }: VocBannerProps): ReactElement {
  const commandRef = useRef<HTMLElement>(null);
  const copy = async (): Promise<void> => {
    if (!info.command) return;
    const ok = await copyText(info.command);
    if (ok) {
      // 명령에 로그인 ID 가 이미 들어 있으면(whoami 로 알았다) 바꿀 자리가 없다
      notify(loginCopiedText(info.command));
    } else {
      selectContents(commandRef.current);
      notify('복사하지 못했습니다. 명령 글자를 골라 두었으니 Ctrl+C 로 복사하세요.');
    }
  };
  return (
    <div
      className={cls('vv-banner', `vv-banner--${info.tone}`)}
      data-testid="voc-banner"
      data-state={info.state}
      role={info.state === 'loading' ? 'status' : 'alert'}
    >
      {info.busy ? <span className="state-spinner" aria-hidden="true" /> : <IconAlert size={16} className="vv-banner-icon" />}
      <div className="vv-banner-text">
        <p className="vv-banner-title">{info.title}</p>
        {info.detail && <p className="vv-banner-detail">{info.detail}</p>}
        {info.hint && <p className="vv-banner-detail">{info.hint}</p>}
        {info.command && (
          <details className="vv-terminal">
            <summary className="vv-terminal-summary">
              <IconChevronDown size={14} className="vv-terminal-chevron" />
              터미널에서 하려면
            </summary>
            {info.commandHint && <p className="vv-banner-detail">{info.commandHint}</p>}
            <div className="vv-command">
              <code className="vv-command-text" data-testid="voc-login-command" ref={commandRef}>
                {info.command}
              </code>
              <button type="button" className="btn btn--secondary vv-command-copy" onClick={() => void copy()}>
                <IconCopy size={16} />
                복사
              </button>
            </div>
          </details>
        )}
      </div>
      {info.login && onLogin && (
        <button type="button" className="btn btn--primary vv-banner-action" data-testid="btn-voc-login-open" onClick={onLogin}>
          <IconLogin size={16} />
          로그인
        </button>
      )}
      {info.settings && (
        <button type="button" className="btn btn--secondary vv-banner-action" onClick={onSettings}>
          <IconSettings size={16} />
          설정 열기
        </button>
      )}
    </div>
  );
}
