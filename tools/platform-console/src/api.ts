export interface PortStatus {
  name: string;
  port: number;
  ok: boolean;
}

export interface Status {
  at: number;
  ports: PortStatus[];
  adapter: { ok: boolean; status?: number; error?: string };
  wechat: { ready: boolean; readyAt: string | null; pid: number | null; alive: boolean };
  qqTransport: null | {
    connected?: boolean;
    starting?: boolean;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string;
    selfId?: string;
    nickname?: string;
  };
  snowluma: { url: string; webui: boolean; onebot: boolean };
  links: { gui: string; snowluma: string };
}

export async function fetchStatus(): Promise<Status> {
  const r = await fetch('/api/status');
  if (!r.ok) throw new Error('status HTTP ' + r.status);
  return r.json();
}

export async function fetchLogs(source: string, tail = 100): Promise<string[]> {
  const r = await fetch('/api/logs?source=' + encodeURIComponent(source) + '&tail=' + tail);
  if (!r.ok) throw new Error('logs HTTP ' + r.status);
  const d = await r.json();
  return Array.isArray(d.lines) ? d.lines : [];
}

export interface PlatformAccess {
  groups: string[];
  privates: string[];
  allowAllGroups?: boolean;
  owner?: string;
}

export interface AccessResponse {
  access: {
    wechat: PlatformAccess;
    qq: PlatformAccess;
  };
}

export interface SeenEntry {
  name?: string;
  lastAt?: number;
  count?: number;
}

export interface SeenResponse {
  seen: Record<string, { groups?: Record<string, SeenEntry>; privates?: Record<string, SeenEntry> }>;
}

export async function fetchAccess(): Promise<AccessResponse> {
  const r = await fetch('/api/access');
  if (!r.ok) throw new Error('access HTTP ' + r.status);
  return r.json();
}

export async function fetchSeen(): Promise<SeenResponse> {
  const r = await fetch('/api/seen');
  if (!r.ok) throw new Error('seen HTTP ' + r.status);
  return r.json();
}

export async function saveAccess(platform: 'qq' | 'wechat', access: PlatformAccess): Promise<void> {
  const r = await fetch('/api/access', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform, ...access }),
  });
  if (!r.ok) throw new Error('save access HTTP ' + r.status);
}

export interface OnlineState {
  wechat: boolean;
  qq: boolean;
}

export async function fetchOnline(): Promise<{ online: OnlineState }> {
  const r = await fetch('/api/online');
  if (!r.ok) throw new Error('online HTTP ' + r.status);
  return r.json();
}

export async function saveOnline(platform: 'qq' | 'wechat', online: boolean): Promise<void> {
  const r = await fetch('/api/online', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform, online }),
  });
  if (!r.ok) throw new Error('save online HTTP ' + r.status);
}

export async function fetchPersona(): Promise<string> {
  const r = await fetch('/api/persona');
  if (!r.ok) throw new Error('persona HTTP ' + r.status);
  const d = await r.json();
  return String(d.persona || '');
}

export async function savePersona(persona: string): Promise<void> {
  const r = await fetch('/api/persona', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (!r.ok) throw new Error('save persona HTTP ' + r.status);
}

export interface ServicesState {
  snowluma: { webui: boolean; onebot: boolean };
  qqTransport: { running: boolean; lastError: string };
  wechatBridge: { running: boolean; ready: boolean; stopFlag: boolean };
}

export async function fetchServices(): Promise<ServicesState> {
  const r = await fetch('/api/services');
  if (!r.ok) throw new Error('services HTTP ' + r.status);
  return r.json();
}

export async function startConsoleService(
  name: 'qq-transport' | 'wechat-bridge',
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string; alreadyRunning?: boolean }> {
  const r = await fetch('/api/services/' + name + '/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: { ok?: boolean; error?: string; alreadyRunning?: boolean } = {};
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error(data.error || ('start HTTP ' + r.status));
  return { ok: Boolean(data.ok), alreadyRunning: data.alreadyRunning };
}



