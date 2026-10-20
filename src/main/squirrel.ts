// Squirrel.Windows 설치 이벤트 처리. 설치·업데이트·제거 때 Update.exe 가 앱을 --squirrel-* 인자로 띄우는데,
// 이때는 창을 열지 않고 바로가기만 만들거나 지우고 끝낸다(electron-squirrel-startup 과 같은 일).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';

/** Squirrel 이벤트로 실행됐으면 처리를 시작하고 true. 이때 호출한 쪽은 앱을 띄우지 말아야 한다 */
export function handleSquirrelEvent(argv: string[] = process.argv): boolean {
  if (process.platform !== 'win32') return false;
  const event = argv[1];
  if (!event?.startsWith('--squirrel-')) return false;

  // 설치 폴더 구조: %LOCALAPPDATA%\wiki-radar\app-<버전>\wiki-radar.exe, Update.exe 는 한 단계 위
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  const exeName = path.basename(process.execPath);
  const runUpdate = (args: string[]) => {
    try {
      spawn(updateExe, args, { detached: true }).on('close', () => app.quit());
    } catch {
      app.quit();
    }
  };

  switch (event) {
    case '--squirrel-install':
    case '--squirrel-updated':
      runUpdate([`--createShortcut=${exeName}`]);
      return true;
    case '--squirrel-uninstall':
      runUpdate([`--removeShortcut=${exeName}`]);
      return true;
    case '--squirrel-obsolete':
      app.quit();
      return true;
    default:
      // --squirrel-firstrun 은 설치 직후 첫 실행 — 평소처럼 띄운다
      return false;
  }
}
