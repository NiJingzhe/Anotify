// 登录态：/v1/auth/me 判定；用户有交互时按节流发送活动心跳，会话滑动续期（无活动 14 天过期）
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { identifyUser, resetAnalytics } from './analytics.js';

const SessionContext = createContext(null);

const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 最近 5 分钟有交互才算「活跃」
const BEAT_EVERY_MS = 10 * 60 * 1000; // 活跃期间每 10 分钟最多一次心跳

export function SessionProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = 加载中，null = 未登录
  const lastActivity = useRef(Date.now());
  const lastBeat = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setUser(await api('GET', '/v1/auth/me'));
    } catch (e) {
      if (e.status === 401) setUser(null);
      else setUser((u) => (u === undefined ? null : u));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const beat = useCallback(async () => {
    lastBeat.current = Date.now();
    try {
      await api('POST', '/v1/auth/heartbeat', {});
    } catch (e) {
      if (e.status === 401) setUser(null);
    }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const mark = () => { lastActivity.current = Date.now(); };
    const events = ['pointerdown', 'keydown', 'scroll', 'mousemove', 'touchstart'];
    for (const ev of events) window.addEventListener(ev, mark, { passive: true });
    const tick = () => {
      const active = Date.now() - lastActivity.current < ACTIVE_WINDOW_MS && document.visibilityState === 'visible';
      if (active && Date.now() - lastBeat.current >= BEAT_EVERY_MS) beat();
    };
    tick();
    const timer = setInterval(tick, 60 * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      for (const ev of events) window.removeEventListener(ev, mark);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [user, beat]);

  const logout = useCallback(async () => {
    await api('POST', '/v1/auth/logout', {}).catch(() => {});
    setUser(null);
  }, []);

  // PostHog：登录即 identify（留存/动线按用户聚合）；登出即 reset 防串号
  useEffect(() => {
    if (user) identifyUser(user.user_id ?? user.id, { email: user.email });
    else if (user === null) resetAnalytics();
  }, [user]);

  return (
    <SessionContext.Provider value={{ user, setUser, refresh, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export const useSession = () => useContext(SessionContext);
