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
