// 두 창이 같은 번들을 쓴다. 모드(?mode=sidebar|full)에 따라 레이아웃만 다르다.
import type { ReactElement } from 'react';
import type { WindowMode } from '../shared/types';
import { useSnapshot } from './hooks/useSnapshot';
import { FullView } from './views/FullView';
import { Sidebar } from './views/Sidebar';

export function App({ mode }: { mode: WindowMode }): ReactElement {
  const snapshot = useSnapshot();
  return mode === 'sidebar' ? <Sidebar {...snapshot} /> : <FullView {...snapshot} />;
}
