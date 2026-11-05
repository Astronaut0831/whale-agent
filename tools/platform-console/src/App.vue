<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { darkTheme, NButton, NConfigProvider, NGlobalStyle, NInput, NTag, useOsTheme } from 'naive-ui';
import { fetchAccess, fetchLogs, fetchSeen, fetchStatus, saveAccess, type AccessResponse, type SeenResponse, type Status } from './api';

const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === 'dark' ? darkTheme : null));

const status = ref<Status | null>(null);
const error = ref('');
const logs = ref<string[]>([]);
const logSource = ref('adapter');
const loading = ref(false);
let timer: number | undefined;

const view = ref<'monitor' | 'access'>('monitor');
const access = ref<AccessResponse | null>(null);
const seen = ref<SeenResponse | null>(null);
const accessPlatform = ref<'qq' | 'wechat'>('qq');
const accessError = ref('');
const saving = ref(false);
const newGroup = ref('');
const newPrivate = ref('');

const sources = [
  { id: 'adapter', label: 'adapter' },
  { id: 'wechatBridge', label: '微信 bridge' },
  { id: 'web', label: 'web' },
  { id: 'qqTransport', label: 'QQ transport' },
];

function fmt(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function ago(ts?: number | null): string {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  return Math.round(sec / 3600) + ' 小时前';
}

function portOk(port: number): boolean {
  return Boolean(status.value?.ports.find((p) => p.port === port)?.ok);
}

const qq = computed(() => status.value?.qqTransport || null);
const qqLabel = computed(() => {
  if (!qq.value) return '未启动';
  if (qq.value.connected) return '在线';
  if (qq.value.starting) return '启动中';
  return '离线';
});
const qqTagType = computed(() => (qq.value?.connected ? 'success' : qq.value?.starting ? 'warning' : 'error'));

const platformAccess = computed(() => access.value?.access?.[accessPlatform.value] || { groups: [], privates: [] });
const pendingGroups = computed(() => {
  const entries = Object.entries(seen.value?.seen?.[accessPlatform.value]?.groups || {});
  return entries
    .filter(([id]) => !platformAccess.value.groups.includes(id))
    .map(([id, v]) => ({ id, name: v.name || id, lastAt: v.lastAt, count: v.count || 0 }))
    .sort((a, b) => Number(b.lastAt || 0) - Number(a.lastAt || 0));
});
const pendingPrivates = computed(() => {
  const entries = Object.entries(seen.value?.seen?.[accessPlatform.value]?.privates || {});
  return entries
    .filter(([id]) => !platformAccess.value.privates.includes(id))
    .map(([id, v]) => ({ id, name: v.name || id, lastAt: v.lastAt, count: v.count || 0 }))
    .sort((a, b) => Number(b.lastAt || 0) - Number(a.lastAt || 0));
});

async function loadAccess() {
  try {
    const [a, s] = await Promise.all([fetchAccess(), fetchSeen()]);
    access.value = a;
    seen.value = s;
    accessError.value = '';
  } catch (e) {
    accessError.value = String((e as Error)?.message || e);
  }
}

async function saveCurrentAccess() {
  if (!access.value) return;
  saving.value = true;
  try {
    const p = access.value.access[accessPlatform.value];
    await saveAccess(accessPlatform.value, {
      groups: p.groups,
      privates: p.privates,
      allowAllGroups: p.allowAllGroups,
      owner: p.owner,
    });
    accessError.value = '';
    await loadSeenOnly();
  } catch (e) {
    accessError.value = String((e as Error)?.message || e);
  } finally {
    saving.value = false;
  }
}

async function loadSeenOnly() {
  try { seen.value = await fetchSeen(); } catch { /* best effort */ }
}

function addGroup() {
  const id = newGroup.value.trim();
  if (!id || !access.value) return;
  const p = access.value.access[accessPlatform.value];
  if (!p.groups.includes(id)) p.groups.push(id);
  newGroup.value = '';
}

function removeGroup(id: string) {
  if (!access.value) return;
  const p = access.value.access[accessPlatform.value];
  p.groups = p.groups.filter((x) => x !== id);
}

function addPrivate() {
  const id = newPrivate.value.trim();
  if (!id || !access.value) return;
  const p = access.value.access[accessPlatform.value];
  if (!p.privates.includes(id)) p.privates.push(id);
  newPrivate.value = '';
}

function removePrivate(id: string) {
  if (!access.value) return;
  const p = access.value.access[accessPlatform.value];
  p.privates = p.privates.filter((x) => x !== id);
}

async function approveGroup(id: string) {
  if (!access.value) return;
  const p = access.value.access[accessPlatform.value];
  if (!p.groups.includes(id)) p.groups.push(id);
  await saveCurrentAccess();
}

async function approvePrivate(id: string) {
  if (!access.value) return;
  const p = access.value.access[accessPlatform.value];
  if (!p.privates.includes(id)) p.privates.push(id);
  await saveCurrentAccess();
}


async function loadStatus() {
  loading.value = true;
  try {
    status.value = await fetchStatus();
    error.value = '';
  } catch (e) {
    error.value = String((e as Error)?.message || e);
  } finally {
    loading.value = false;
  }
}

async function loadLogs() {
  try {
    logs.value = await fetchLogs(logSource.value, 120);
  } catch (e) {
    logs.value = ['读取日志失败：' + String((e as Error)?.message || e)];
  }
}

async function selectSource(id: string) {
  logSource.value = id;
  await loadLogs();
}

async function refresh() {
  if (view.value === 'access') {
    await Promise.all([loadStatus(), loadAccess()]);
  } else {
    await Promise.all([loadStatus(), loadLogs()]);
  }
}

async function switchView(next: 'monitor' | 'access') {
  view.value = next;
  await refresh();
}

onMounted(async () => {
  await refresh();
  timer = window.setInterval(() => {
    if (!document.hidden) void loadStatus();
  }, 5000);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <NConfigProvider :theme="theme">
    <NGlobalStyle />
    <main class="page">
      <header class="header">
        <div>
          <h1 class="title">鲸鲸控制台</h1>
          <p class="subtitle">{{ view === 'monitor' ? '监控' : '多端接入' }} · {{ loading ? '刷新中…' : '自动刷新 5s' }}</p>
        </div>
        <div class="header-actions">
          <NButton size="small" :type="view === 'monitor' ? 'primary' : 'default'" @click="switchView('monitor')">监控</NButton>
          <NButton size="small" :type="view === 'access' ? 'primary' : 'default'" @click="switchView('access')">接入</NButton>
          <a class="link" :href="status?.links.snowluma || 'http://127.0.0.1:5099'" target="_blank" rel="noreferrer noopener">打开 SnowLuma 控制台</a>
          <NButton size="small" type="primary" :loading="loading" @click="refresh">刷新</NButton>
        </div>
      </header>

      <p v-if="error" class="empty">状态读取失败：{{ error }}</p>

      <section v-if="view === 'monitor'" class="grid">
        <article class="card wide">
          <p class="card-title">platform-adapter</p>
          <div class="metric">
            <span class="dot" :class="status?.adapter.ok ? 'ok' : 'bad'" />
            {{ status?.adapter.ok ? '正常' : '不可用' }}
          </div>
          <p class="meta">8788 · {{ status?.adapter.ok ? 'HTTP 200' : (status?.adapter.error || '连接失败') }}</p>
        </article>

        <article class="card wide">
          <p class="card-title">SnowLuma</p>
          <div class="metric">
            <span class="dot" :class="status?.snowluma.onebot ? 'ok' : 'bad'" />
            {{ status?.snowluma.onebot ? 'OneBot 在线' : 'OneBot 离线' }}
          </div>
          <p class="meta">
            WebUI {{ status?.snowluma.webui ? '在线' : '离线' }} ·
            <a class="link" :href="status?.links.snowluma || 'http://127.0.0.1:5099'" target="_blank" rel="noreferrer noopener">:5099</a>
          </p>
        </article>

        <article class="card wide">
          <p class="card-title">QQ transport-only</p>
          <div class="metric">
            <span class="dot" :class="qq?.connected ? 'ok' : qq?.starting ? 'bad' : 'bad'" />
            {{ qqLabel }}
            <NTag size="small" :type="qqTagType">{{ qq?.selfId || '未登录' }}</NTag>
          </div>
          <p class="meta">
            {{ qq?.nickname || 'SnowLuma 个人号' }} · 最后入站 {{ ago(qq?.lastInboundAt) }} · 最后出站 {{ ago(qq?.lastOutboundAt) }}
          </p>
          <p v-if="qq?.lastError" class="meta">最近错误：{{ qq.lastError }}</p>
        </article>

        <article class="card wide">
          <p class="card-title">微信 bridge</p>
          <div class="metric">
            <span class="dot" :class="status?.wechat.alive ? 'ok' : 'bad'" />
            {{ status?.wechat.alive ? '进程在线' : '进程离线' }}
          </div>
          <p class="meta">PID {{ status?.wechat.pid || '—' }} · ready {{ status?.wechat.readyAt || '—' }}</p>
        </article>

        <article class="card full">
          <p class="card-title">端口</p>
          <div class="ports">
            <span v-for="p in status?.ports || []" :key="p.port" class="port">
              <span class="dot" :class="p.ok ? 'ok' : 'bad'" />
              {{ p.name }} :{{ p.port }}
            </span>
          </div>
          <p class="meta">最后刷新 {{ fmt(status?.at) }}</p>
        </article>

        <article class="card full">
          <p class="card-title">日志</p>
          <div class="header-actions" style="margin-bottom: 10px">
            <NButton
              v-for="s in sources"
              :key="s.id"
              size="small"
              :type="logSource === s.id ? 'primary' : 'default'"
              @click="selectSource(s.id)"
            >{{ s.label }}</NButton>
            <NButton size="small" @click="loadLogs">重新读取</NButton>
          </div>
          <div v-if="logs.length" class="logs">{{ logs.join('\n') }}</div>
          <p v-else class="empty">暂无日志。</p>
        </article>
      </section>

      <section v-else class="grid">
        <article class="card full">
          <p class="card-title">平台接入</p>
          <div class="header-actions" style="margin-bottom: 12px">
            <NButton size="small" :type="accessPlatform === 'qq' ? 'primary' : 'default'" @click="accessPlatform = 'qq'">QQ</NButton>
            <NButton size="small" :type="accessPlatform === 'wechat' ? 'primary' : 'default'" @click="accessPlatform = 'wechat'">微信</NButton>
            <NButton size="small" type="primary" :loading="saving" @click="saveCurrentAccess">保存</NButton>
          </div>
          <p v-if="accessError" class="empty">读取/保存失败：{{ accessError }}</p>
          <p class="meta">只有 allowlist 里的会话会进入 adapter；未批准会话只显示在下面。</p>
          <label v-if="accessPlatform === 'qq'" class="check-row">
            <input v-model="platformAccess.allowAllGroups" type="checkbox" />
            允许所有群（危险，SnowLuma 会收到账号全部群消息）
          </label>
          <div v-if="accessPlatform === 'qq'" class="header-actions" style="margin-top: 10px">
            <span class="meta">主人 QQ（共用微信主人记忆）</span>
            <input v-model="platformAccess.owner" class="text-input" placeholder="QQ 号" />
          </div>
        </article>

        <article class="card wide">
          <p class="card-title">允许的群</p>
          <div class="list">
            <div v-for="id in platformAccess.groups" :key="id" class="list-row">
              <code>{{ id }}</code>
              <NButton size="tiny" type="error" ghost @click="removeGroup(id)">移除</NButton>
            </div>
            <p v-if="!platformAccess.groups.length" class="empty">还没有允许的群。</p>
          </div>
          <div class="header-actions" style="margin-top: 12px">
            <input v-model="newGroup" class="text-input" placeholder="群号" @keyup.enter="addGroup" />
            <NButton size="small" @click="addGroup">添加</NButton>
          </div>
        </article>

        <article class="card wide">
          <p class="card-title">允许的私聊</p>
          <div class="list">
            <div v-for="id in platformAccess.privates" :key="id" class="list-row">
              <code>{{ id }}</code>
              <NButton size="tiny" type="error" ghost @click="removePrivate(id)">移除</NButton>
            </div>
            <p v-if="!platformAccess.privates.length" class="empty">还没有允许的私聊。</p>
          </div>
          <div class="header-actions" style="margin-top: 12px">
            <input v-model="newPrivate" class="text-input" placeholder="QQ 号 / wxid" @keyup.enter="addPrivate" />
            <NButton size="small" @click="addPrivate">添加</NButton>
          </div>
        </article>

        <article class="card full">
          <p class="card-title">待批准：群</p>
          <div v-if="pendingGroups.length" class="list">
            <div v-for="g in pendingGroups" :key="g.id" class="list-row">
              <span><strong>{{ g.name }}</strong> <code>{{ g.id }}</code></span>
              <span class="meta">最后 {{ ago(g.lastAt) }} · {{ g.count }} 条</span>
              <NButton size="tiny" type="primary" @click="approveGroup(g.id)">允许</NButton>
            </div>
          </div>
          <p v-else class="empty">暂无待批准群。transport 收到未授权群消息后会出现在这里。</p>
        </article>

        <article class="card full">
          <p class="card-title">待批准：私聊</p>
          <div v-if="pendingPrivates.length" class="list">
            <div v-for="p in pendingPrivates" :key="p.id" class="list-row">
              <span><strong>{{ p.name }}</strong> <code>{{ p.id }}</code></span>
              <span class="meta">最后 {{ ago(p.lastAt) }} · {{ p.count }} 条</span>
              <NButton size="tiny" type="primary" @click="approvePrivate(p.id)">允许</NButton>
            </div>
          </div>
          <p v-else class="empty">暂无待批准私聊。</p>
        </article>
      </section>
    </main>
  </NConfigProvider>
</template>
