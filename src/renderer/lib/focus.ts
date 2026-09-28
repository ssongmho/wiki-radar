// 초점 돌려놓기(DOM 도우미). 누른 버튼이 사라지거나(목록 줄·알림 닫기) 비활성이 되면(저장 중·취소 뒤·반영 시작 뒤)
// 브라우저는 초점을 body 로 떨어뜨린다 — 키보드로 쓰는 사람은 자리를 잃고 화면 낭독기는 읽을 곳을 잃는다.
// 그럴 때만(초점이 이미 다른 곳에 있으면 건드리지 않는다) 다음 그리기 뒤 알맞은 자리로 옮긴다.

/**
 * 초점이 사라졌는가: body·문서 자체에 있거나, 초점 받은 요소가 비활성이 되었거나 문서에서 빠졌다
 * (비활성이 된 버튼의 초점은 브라우저가 다음 그리기 때에야 body 로 옮기므로 그 전에도 사라진 것으로 본다).
 */
export function focusLost(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  return !el.isConnected || (el as HTMLButtonElement).disabled === true;
}

/**
 * 화면이 다시 그려진 뒤 fn 을 한 번 부른다. 보통은 다음 프레임(requestAnimationFrame)이고, 창이 가려져 프레임이 늦으면
 * 잠시 뒤 타이머로 — 둘 중 먼저 오는 쪽.
 */
export function afterRender(fn: () => void): void {
  let ran = false;
  const go = (): void => {
    if (ran) return;
    ran = true;
    fn();
  };
  requestAnimationFrame(go);
  window.setTimeout(go, 50);
}

type Pick = () => HTMLElement | null | undefined;

function usable(el: HTMLElement | null | undefined): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  return !(el as HTMLButtonElement | HTMLInputElement).disabled;
}

/** 가장 최근 요청 번호 — 늦게 도는 옛 요청(창이 가려져 프레임이 밀린 것 등)이 새 요청의 자리를 빼앗지 않게 */
let latest = 0;

/**
 * 다음 그리기 뒤 초점이 사라져 있으면 pick() 이 고른 요소로 옮긴다. 화면이 아직 바뀌기 전이라 pick() 이 쓸 수 있는
 * 요소(연결돼 있고 비활성이 아닌 것)를 못 찾으면 몇 번 더 기다린다. 끝내 못 찾으면 fallback() 으로 옮긴다.
 * 그사이 새 요청이 오면 이 요청은 버린다.
 */
export function refocusIfLost(pick: Pick, fallback?: Pick, frames = 3): void {
  const token = ++latest;
  let left = frames;
  const run = (): void => {
    if (token !== latest || !focusLost()) return;
    const el = pick();
    if (usable(el)) {
      el.focus();
      return;
    }
    if (--left > 0) {
      afterRender(run);
      return;
    }
    const alt = fallback?.();
    if (usable(alt)) alt.focus();
  };
  afterRender(run);
}
