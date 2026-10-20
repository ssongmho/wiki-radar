// VOC 쓰기 확인 대화상자(2.6단계 명세 §4·§5). VOC 운영 데이터는 사람이 여기서 [실행]을 누를 때만 바뀐다.
// components/ConfirmDialog 를 그대로 쓰고(식별자 voc-confirm·btn-voc-confirm), 동작 종류는 대화상자에 data-kind 로 붙인다.
import type { ReactElement } from 'react';
import type { VocActionKind } from '../../../../shared/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { IconAssign, IconCheck, IconReply } from '../../../components/Icons';
import { vocConfirm, type VocConfirmContext, type VocPendingAction } from '../../../lib/voc';

/**
 * 대화상자 요소에 data-kind 를 붙인다. ConfirmDialog 는 이 속성을 받지 않으므로, 본문 안의 표식에서 가장 가까운
 * <dialog> 를 찾아 붙이고 닫힐 때(표식이 빠질 때) 뗀다(React 19 ref 정리 함수).
 */
export function DialogKind({ kind }: { kind: string }): ReactElement {
  return (
    <span
      hidden
      ref={(el) => {
        const dialog = el?.closest('dialog');
        dialog?.setAttribute('data-kind', kind);
        return () => dialog?.removeAttribute('data-kind');
      }}
    />
  );
}

const CONFIRM_ICON: Record<VocActionKind, ReactElement> = {
  assign: <IconAssign size={16} />,
  ictDue: <IconCheck size={16} />,
  priority: <IconCheck size={16} />,
  status: <IconCheck size={16} />,
  reply: <IconReply size={16} />,
};

export interface VocConfirmDialogProps {
  /** 확인할 동작(null 이면 닫힘) */
  pending: VocPendingAction | null;
  context: VocConfirmContext;
  onConfirm: () => void;
  onCancel: () => void;
}

export function VocConfirmDialog({ pending, context, onConfirm, onCancel }: VocConfirmDialogProps): ReactElement {
  const summary = pending ? vocConfirm(pending, context) : null;
  return (
    <ConfirmDialog
      open={!!summary}
      testId="voc-confirm"
      confirmTestId="btn-voc-confirm"
      title={summary?.title ?? ''}
      confirmText={summary?.confirmText ?? '실행'}
      confirmIcon={summary ? CONFIRM_ICON[summary.kind] : undefined}
      onConfirm={onConfirm}
      onCancel={onCancel}
      wide={summary?.kind === 'reply'}
    >
      {summary && (
        <>
          <DialogKind kind={summary.kind} />
          <p className="voc-confirm-subject">{summary.subject}</p>
          <p>
            <strong>{summary.lead}</strong>
          </p>
          {summary.preview && (
            <pre className="confirm-body">
              {summary.preview.lines.join('\n')}
              {summary.preview.more > 0 && <span className="confirm-more">{`\n…(${summary.preview.more}줄 더)`}</span>}
            </pre>
          )}
          {summary.lines.length > 0 && (
            <ul className="dialog-list">
              {summary.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </ConfirmDialog>
  );
}
