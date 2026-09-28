// 확인 대화상자. 브라우저의 <dialog>.showModal() 을 쓴다 — 바깥이 inert 가 되고 Esc 로 닫히며 초점이 안에 갇힌다.
// 처음 초점은 [취소]에 둔다(되돌리기 번거로운 동작을 Enter 한 번으로 시작하지 않게).
import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmText: string;
  cancelText?: string;
  /** 확인 버튼 앞의 아이콘 */
  confirmIcon?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

export function ConfirmDialog(props: ConfirmDialogProps): ReactElement {
  const { open, title, children, confirmText, cancelText = '취소', confirmIcon, onConfirm, onCancel, testId } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', ''); // showModal 이 없는 환경(시험 등)
      }
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      data-testid={open ? testId : undefined}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      // Esc: 브라우저가 닫기 전에 상태로 되돌린다(열림 상태를 React 가 쥐고 있게)
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      {open && (
        <div className="dialog-inner">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <div id={bodyId} className="dialog-body">
            {children}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn--primary" onClick={onConfirm}>
              {confirmIcon}
              {confirmText}
            </button>
            <button type="button" className="btn btn--secondary" ref={cancelRef} onClick={onCancel}>
              {cancelText}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
