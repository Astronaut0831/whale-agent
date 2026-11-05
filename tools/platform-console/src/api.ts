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

