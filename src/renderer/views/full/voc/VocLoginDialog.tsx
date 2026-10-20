// VOC 로그인 대화상자(2.6단계 명세 §13): 아이디 · 비밀번호 · 아이디 기억 → [로그인]. main 이 `voc-cli login -u <아이디> --password` 를
// 부르고 비밀번호는 표준입력으로만 넘긴다(인자·로그·파일에 남지 않는다). 비밀번호는 이 대화상자의 입력 칸에만 있고 성공·실패·닫기 뒤 비운다.
// <dialog>.showModal() 로 연다 — 바깥이 inert 가 되고 Esc 로 닫히며 초점이 안에 갇힌다(VocSettingsDialog 와 같은 방식).
// 처음 초점은 아이디가 비면 아이디 칸, 있으면 비밀번호 칸. Enter 로 보낸다(form submit). 보내는 동안 [로그인]·[취소]·Esc 는 막고
// 입력 칸은 읽기 전용으로 둔다(초점을 잃지 않게).
import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { NO_BRIDGE_MESSAGE, getRadar } from '../../../api';
import { IconLogin } from '../../../components/Icons';
import { NO_VOC_MESSAGE } from '../../../hooks/useVocBoard';
import { refocusIfLost } from '../../../lib/focus';
import { asSentence } from '../../../lib/reply';
import { errorText } from '../../../lib/snapshot';
import { textOf } from '../../../lib/tasks';
import { vocLoginProblem } from '../../../lib/voc';
import { VOC_PASSWORD_MAX } from '../../../../shared/voc';

export interface VocLoginDialogProps {
  open: boolean;
  /** 아이디 기본값(보드의 loginId — 기억한 아이디 또는 whoami 로 안 것). 없으면 빈 칸 */
  defaultId?: string;
  onClose: () => void;
  /** 로그인했다(결과 문장). 부른 쪽이 대화상자를 닫고 보드를 새로 받는다 */
  onLoggedIn: (message: string) => void;
}

export function VocLoginDialog({ open, defaultId, onClose, onLoggedIn }: VocLoginDialogProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const leadId = `${baseId}-lead`;
  const errorId = `${baseId}-error`;
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 같은 문장이 또 와도 읽기 도구가 다시 읽게(role=alert 를 새로 붙인다)
  const [attempt, setAttempt] = useState(0);
  // 두 번 누르기 방지: 상태 갱신은 다음 그리기에 반영되므로 ref 로 바로 막는다
  const busyRef = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const id = defaultId ?? '';
      setLoginId(id);
      setPassword('');
      setRemember(true);
      setError(null);
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', ''); // showModal 이 없는 환경(시험 등)
      }
      // 아이디를 이미 알면 비밀번호부터
      (id === '' ? idRef : passwordRef).current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      setPassword('');
      setError(null);
    }
    // defaultId 는 열 때 한 번만 쓴다(열린 뒤 보드가 바뀌어도 적던 아이디를 덮지 않는다)
  }, [open]);

  const close = (): void => {
    if (busyRef.current) return;
    setPassword('');
    onClose();
  };

  const showError = (message: string): void => {
    setError(message);
    setAttempt((n) => n + 1);
  };

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (busyRef.current) return;
    const id = loginId.trim();
    const problem = vocLoginProblem(id, password);
    if (problem) {
      showError(problem.message);
      (problem.field === 'id' ? idRef : passwordRef).current?.focus();
      return;
    }
    const api = getRadar();
    if (!api || typeof api.vocLogin !== 'function') {
      showError(api ? NO_VOC_MESSAGE : NO_BRIDGE_MESSAGE);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let ok = false;
    try {
      const result = await api.vocLogin({ loginId: id, password, remember });
      if (result && typeof result === 'object' && result.ok === true) {
        ok = true;
        onLoggedIn(asSentence(textOf(result.message) ?? 'VOC 에 로그인했습니다'));
      } else {
        showError(asSentence(textOf(result?.message) ?? '로그인하지 못했습니다'));
      }
    } catch (err) {
      showError(`로그인하지 못했습니다. (${errorText(err)})`);
    } finally {
      // 성공·실패 모두 비밀번호 칸을 비운다(명세 §13)
      setPassword('');
      busyRef.current = false;
      setBusy(false);
    }
    // 실패: 비운 비밀번호 칸으로(누른 [로그인]이 비활성이 되어 초점이 떨어졌을 때)
    if (!ok) refocusIfLost(() => passwordRef.current, () => idRef.current);
  };

  return (
    <dialog
      ref={ref}
      className="dialog vv-login"
      data-testid={open ? 'voc-login' : undefined}
      aria-labelledby={titleId}
      aria-describedby={leadId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {open && (
        <form className="dialog-inner" noValidate onSubmit={(e) => void submit(e)}>
          <h2 id={titleId} className="dialog-title vv-login-title">
            <IconLogin size={18} />
            VOC 로그인
          </h2>
          <div className="dialog-body vv-login-body">
            <p id={leadId}>
              VOC 아이디와 비밀번호로 로그인합니다. 비밀번호는 저장하지 않고 VOC 서버에 한 번 보내기만 합니다 — 로그인 세션(토큰)은 이
              PC 의 Windows 계정으로 암호화해 둡니다.
            </p>
            <div className="field">
              <label htmlFor={`${baseId}-id`} className="field-label">
                아이디
              </label>
              <input
                id={`${baseId}-id`}
                ref={idRef}
                className="text-input"
                type="text"
                data-testid="voc-login-id"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={64}
                readOnly={busy}
                value={loginId}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setLoginId(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`${baseId}-password`} className="field-label">
                비밀번호
              </label>
              <input
                id={`${baseId}-password`}
                ref={passwordRef}
                className="text-input"
                type="password"
                data-testid="voc-login-password"
                autoComplete="off"
                spellCheck={false}
                maxLength={VOC_PASSWORD_MAX}
                readOnly={busy}
                value={password}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <label className="check-card">
              <input
                type="checkbox"
                data-testid="voc-login-remember"
                disabled={busy}
                checked={remember}
                aria-labelledby={`${baseId}-remember-title`}
                aria-describedby={`${baseId}-remember-desc`}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span className="check-card-text">
                <span id={`${baseId}-remember-title`} className="check-card-title">
                  아이디 기억
                </span>
                <span id={`${baseId}-remember-desc`} className="check-card-desc">
                  다음에 로그인 창을 열 때 아이디를 채웁니다(앱 데이터 폴더의 VOC 설정). 비밀번호는 기억하지 않습니다.
                </span>
              </span>
            </label>
            {error && (
              <p key={attempt} id={errorId} className="form-problem" role="alert" data-testid="voc-login-error">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-actions">
            <button
              type="submit"
              className="btn btn--primary"
              data-testid="btn-voc-login"
              disabled={busy}
              aria-describedby={error ? errorId : undefined}
            >
              <IconLogin size={16} />
              {busy ? '로그인하는 중…' : '로그인'}
            </button>
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={close}>
              취소
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
