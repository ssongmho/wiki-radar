// 선택한 할 일의 원 메일 요약을 불러온다. 같은 스냅샷 동안은 결과를 기억해 둔다.
import { useEffect, useState } from 'react';
import type { MailSummary } from '../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../api';
import { errorText } from '../lib/snapshot';

export type MailState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; mail: MailSummary }
  | { status: 'missing' }
  | { status: 'error'; message: string };

const CACHE_LIMIT = 200;
const cache = new Map<string, MailState>();

function remember(key: string, state: MailState): void {
  cache.set(key, state);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * @param path 볼트 기준 메일 경로(raw/mail/…). 없으면 'none'.
 * @param version 스냅샷 생성 시각 — 바뀌면 다시 읽는다.
 */
export function useMail(path: string | undefined, version: string): MailState {
  const key = path ? `${version}\n${path}` : '';
  const [entry, setEntry] = useState<{ key: string; state: MailState } | null>(null);

  useEffect(() => {
    if (!path) return;
    if (cache.has(key)) return;
    const api = getRadar();
    if (!api) {
      setEntry({ key, state: { status: 'error', message: NO_BRIDGE_MESSAGE } });
      return;
    }
    let alive = true;
    Promise.resolve()
      .then(() => api.getMail(path))
      .then(
        (mail) => {
          const state: MailState = mail && typeof mail === 'object' ? { status: 'ready', mail } : { status: 'missing' };
          remember(key, state);
          if (alive) setEntry({ key, state });
        },
        (error: unknown) => {
          // 오류는 기억하지 않는다(다음에 다시 시도).
          if (alive) setEntry({ key, state: { status: 'error', message: errorText(error) } });
        },
      );
    return () => {
      alive = false;
    };
  }, [key, path]);

  if (!path) return { status: 'none' };
  const cached = cache.get(key);
  if (cached) return cached;
  if (entry && entry.key === key) return entry.state;
  return { status: 'loading' };
}
