// 메일 원본 보기(docs/stage2.15-contract.md §J) — 원본 .eml 의 HTML 을 sandbox iframe 에 그린다.
// - sandbox="allow-same-origin" 만(스크립트·팝업·폼·최상위 이동 없음) — 바깥(이 화면)이 문서 높이를 재고 링크 클릭을 가로챌 수 있게.
// - 문서는 main 이 정리했다(스크립트·폼·외부 연결 없음, cid 그림은 data:). 외부 그림은 [외부 그림 보기]를 눌러야 main 이 받아 넣는다.
// - 링크는 확인창 뒤 기본 브라우저(3a 와 같은 openExternalLink). http/https/mailto 밖은 열지 않는다.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { MailHtmlView as MailHtmlDoc } from '../../../../shared/types';
import { getRadar } from '../../../api';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { IconExternal, IconImage } from '../../../components/Icons';
import { LoadingState } from '../../../components/StateMessage';
import { openExternalLink } from '../../../hooks/useWikiDocs';
import { errorText } from '../../../lib/snapshot';

export interface MailHtmlViewProps {
  path: string;
}

export function MailHtmlView({ path }: MailHtmlViewProps): ReactElement {
  const [remote, setRemote] = useState(false);
  const [doc, setDoc] = useState<MailHtmlDoc | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'none' | 'error'>('loading');
  const [error, setError] = useState('');
  const [height, setHeight] = useState(200);
  const [extUrl, setExtUrl] = useState<string | null>(null);
  const [linkError, setLinkError] = useState('');
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setRemote(false);
  }, [path]);

  useEffect(() => {
    const api = getRadar();
    if (!api || typeof api.getMailHtml !== 'function') {
      setState('none');
      return undefined;
    }
    let alive = true;
    setState('loading');
    api.getMailHtml({ path, remote }).then(
      (d) => {
        if (!alive) return;
        setDoc(d);
        setState(d ? 'ready' : 'none');
      },
      (err: unknown) => {
        if (!alive) return;
        setError(errorText(err));
        setState('error');
      },
    );
    return () => {
      alive = false;
    };
  }, [path, remote]);

  /** 문서 높이에 맞추고, 링크 클릭을 가로챈다(문서 안에서는 아무것도 열리지 않는다) */
  const onLoad = useCallback(() => {
    const frame = frameRef.current;
    const d = frame?.contentDocument;
    if (!frame || !d) return;
    const fit = (): void => setHeight(Math.min(20000, Math.max(80, d.documentElement.scrollHeight + 4)));
    fit();
    for (const img of Array.from(d.images)) if (!img.complete) img.addEventListener('load', fit, { once: true });
    d.addEventListener('click', (e) => {
      const target = e.target instanceof d.defaultView!.Element ? (e.target as Element).closest('a') : null;
      if (!target) return;
      e.preventDefault();
      const href = target.getAttribute('href') ?? '';
      if (/^(https?:|mailto:)/i.test(href.trim())) setExtUrl(href.trim());
    });
  }, []);

  const openExt = async (): Promise<void> => {
    const url = extUrl;
    setExtUrl(null);
    if (!url) return;
    try {
      await openExternalLink(url);
    } catch (err) {
      setLinkError(`주소를 열지 못했습니다. (${errorText(err)})`);
    }
  };

  if (state === 'loading' && !doc) return <LoadingState text="원본을 불러오는 중입니다…" />;
  if (state === 'error') {
    return (
      <p className="form-problem" role="alert">
        원본을 읽지 못했습니다. ({error})
      </p>
    );
  }
  if (state === 'none' || !doc) return <p className="field-note">이 메일은 원본이 없어 글로만 볼 수 있습니다.</p>;

  return (
    <div className="mb-html" data-testid="mail-html">
      {doc.blockedRemote > 0 && !remote && (
        <p className="mb-html-note" data-testid="mail-html-blocked">
          <IconImage size={14} />
          외부 그림 {doc.blockedRemote}개를 막았습니다(보낸 쪽이 읽음을 알 수 있는 그림일 수 있습니다).
          <button type="button" className="link-btn" data-testid="mail-html-remote" onClick={() => setRemote(true)}>
            외부 그림 보기
          </button>
        </p>
      )}
      {remote && doc.failedRemote > 0 && <p className="mb-html-note">외부 그림 {doc.failedRemote}개는 받지 못했습니다.</p>}
      {linkError && (
        <p className="form-problem" role="alert">
          {linkError}
        </p>
      )}
      <iframe
        ref={frameRef}
        className="mb-html-frame"
        title="메일 원본"
        sandbox="allow-same-origin"
        srcDoc={doc.html}
        style={{ height }}
        onLoad={onLoad}
        data-testid="mail-html-frame"
      />
      <ConfirmDialog
        open={extUrl !== null}
        title="바깥 주소를 열까요?"
        confirmText="브라우저로 열기"
        confirmIcon={<IconExternal size={16} />}
        onConfirm={() => void openExt()}
        onCancel={() => setExtUrl(null)}
        testId="mail-html-ext-confirm"
        confirmTestId="mail-html-ext-ok"
        cancelTestId="mail-html-ext-cancel"
      >
        <p>메일 속 링크입니다. 보낸 사람을 믿을 수 있을 때만 여세요.</p>
        <p className="path-text">{extUrl}</p>
      </ConfirmDialog>
    </div>
  );
}
