// renderer 진입점. 글꼴(IBM Plex Sans KR)은 앱에 내장한다 — 보안 정책상 웹폰트를 받지 않는다.
import '@fontsource/ibm-plex-sans-kr/400.css';
import '@fontsource/ibm-plex-sans-kr/500.css';
import '@fontsource/ibm-plex-sans-kr/600.css';
import '@fontsource/ibm-plex-sans-kr/700.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/sidebar.css';
import './styles/full.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { WindowMode } from '../shared/types';
import { App } from './App';

/** ?mode=sidebar|full (기본 full) */
function readMode(search: string): WindowMode {
  return new URLSearchParams(search).get('mode') === 'sidebar' ? 'sidebar' : 'full';
}

const mode = readMode(window.location.search);
document.documentElement.dataset.mode = mode;
document.title = mode === 'sidebar' ? 'wiki-radar 사이드바' : 'wiki-radar';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App mode={mode} />
    </StrictMode>,
  );
}
