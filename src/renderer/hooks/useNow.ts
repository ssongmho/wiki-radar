// 진행 중에 1초마다 다시 그려 경과 시간을 올린다(반영 실행·회신 초안 만들기).
import { useEffect, useState } from 'react';

/** active 인 동안 1초마다 바뀌는 지금 시각(ms). 멈추면 마지막 값에 머문다 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
