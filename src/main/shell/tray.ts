// 트레이·작업 표시줄 포트(2.12단계 명세 §1-6·§2). 실제 포트는 electron Tray·Menu·nativeImage·setOverlayIcon 을 만지고,
// 시험 모드(WIKI_RADAR_TEST_MODE=1)는 언제나 기록 포트 — 실제 트레이를 만들지 않고 바뀔 때마다 <데이터 폴더>/shell-log.jsonl 에 한 줄.
import fs from 'node:fs';
import path from 'node:path';
import { Menu, Tray, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { overlayIconSet, trayIconSet } from './icons';
import { overlayLabel, sameShellView, type ShellPort, type ShellView } from './state';

export const SHELL_LOG_FILE = 'shell-log.jsonl';
/** 트레이를 만들지 못했을 때 한 번 더 해 보는 때 */
const TRAY_RETRY_MS = 30_000;

export type TrayMenuLabel = '사이드바' | '풀스크린' | '알림함' | '종료';

export interface RecordingPort extends ShellPort {
  /** 마지막 상태(없으면 null) */
  last(): ShellView | null;
}

/** 시험 기록 포트: 실제 트레이 없이 바뀐 상태만 적는다. at: 시험 시계의 로컬 시각 'YYYY-MM-DDTHH:mm:ss' */
export function createRecordingPort(dataDir: string, at: () => string, warn: (m: string) => void = () => {}): RecordingPort {
  let last: ShellView | null = null;
  return {
    update(view: ShellView): void {
      if (sameShellView(last, view)) return;
      last = { ...view, menu: { ...view.menu }, overlay: { ...view.overlay } };
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        const line = JSON.stringify({ at: at(), level: view.level, tooltip: view.tooltip, overlay: view.overlay.count, inbox: view.menu.inboxLabel });
        fs.appendFileSync(path.join(dataDir, SHELL_LOG_FILE), line + '\n', 'utf8');
      } catch (err) {
        warn(`트레이 시험 기록을 쓰지 못함: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    destroy(): void {
      // 기록 포트는 놓을 것이 없다
    },
    last: () => last,
  };
}

export interface TrayPortOptions {
  /** 왼쪽 클릭(두 번 클릭도 같다) */
  onClick: () => void;
  onMenu: (label: TrayMenuLabel) => void;
  /** 오버레이를 걸 창(사이드바·풀스크린) */
  windows: () => BrowserWindow[];
  warn: (message: string) => void;
}

function imageOf(set: { scale: number; dataURL: string }[]): NativeImage {
  const img = nativeImage.createEmpty();
  for (const rep of set) img.addRepresentation({ scaleFactor: rep.scale, dataURL: rep.dataURL });
  return img;
}

export interface TrayPort extends ShellPort {
  /** 트레이가 있는가(만들지 못했으면 거짓 — 창 닫기는 그래도 숨긴다) */
  hasTray(): boolean;
  /** 창을 보이거나 다시 만들었을 때 오버레이를 다시 건다(숨은 창에 건 것은 남지 않는다 — index.ts 가 창의 'show' 에서 부른다) */
  reapplyOverlay(): void;
}

/** 실제 트레이·오버레이 포트 */
export function createTrayPort(opts: TrayPortOptions): TrayPort {
  let tray: Tray | null = null;
  let destroyed = false;
  let lastView: ShellView | null = null;
  let lastDark: boolean | null = null;
  let menuLabel: string | null = null;
  let overlayKey: string | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  const images = new Map<string, NativeImage>();

  const trayImage = (view: ShellView, dark: boolean): NativeImage => {
    const key = `${view.level}:${dark ? 'd' : 'l'}`;
    let img = images.get(key);
    if (!img) {
      img = imageOf(trayIconSet(view.level, dark));
      images.set(key, img);
    }
    return img;
  };

  const make = (): boolean => {
    if (destroyed || tray) return !!tray;
    try {
      const view = lastView;
      tray = new Tray(view ? trayImage(view, lastDark ?? true) : imageOf(trayIconSet('normal', true)));
      tray.on('click', () => opts.onClick());
      if (view) apply(view, lastDark ?? true, true);
      return true;
    } catch (err) {
      tray = null;
      opts.warn(`트레이 아이콘을 만들지 못함: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const setMenu = (label: string): void => {
    if (!tray || menuLabel === label) return;
    menuLabel = label;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '사이드바', click: () => opts.onMenu('사이드바') },
        { label: '풀스크린', click: () => opts.onMenu('풀스크린') },
        { label, click: () => opts.onMenu('알림함') },
        { type: 'separator' },
        { label: '종료', click: () => opts.onMenu('종료') },
      ]),
    );
  };

  const applyOverlay = (view: ShellView, force: boolean): void => {
    const text = view.overlay.count > 0 ? overlayLabel(view.overlay.count) : '';
    const key = `${text}|${view.overlay.description}`;
    if (!force && key === overlayKey) return;
    overlayKey = key;
    const img = text ? imageOf(overlayIconSet(text)) : null;
    for (const win of opts.windows()) {
      try {
        if (!win.isDestroyed()) win.setOverlayIcon(img, img ? view.overlay.description : '');
      } catch (err) {
        opts.warn(`작업 표시줄 오버레이를 걸지 못함: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const apply = (view: ShellView, dark: boolean, force: boolean): void => {
    if (tray) {
      try {
        tray.setImage(trayImage(view, dark));
        tray.setToolTip(view.tooltip);
        if (force) menuLabel = null;
        setMenu(view.menu.inboxLabel);
      } catch (err) {
        opts.warn(`트레이 아이콘을 바꾸지 못함: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    applyOverlay(view, force);
  };

  if (!make()) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!make()) opts.warn('트레이 아이콘 없이 동작함(Ctrl+Alt+R 로 창을 다시 띄움)');
    }, TRAY_RETRY_MS);
  }

  return {
    update(view: ShellView, dark: boolean): void {
      if (destroyed) return;
      if (sameShellView(lastView, view) && lastDark === dark) return;
      const darkChanged = lastDark !== dark;
      lastView = view;
      lastDark = dark;
      apply(view, dark, darkChanged);
    },
    destroy(): void {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      try {
        tray?.destroy();
      } catch {
        // 끝내는 중 — 무시
      }
      tray = null;
    },
    hasTray: () => !!tray,
    reapplyOverlay(): void {
      if (!destroyed && lastView) applyOverlay(lastView, true);
    },
  };
}
