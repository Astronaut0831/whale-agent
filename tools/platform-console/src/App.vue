<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { darkTheme, NButton, NConfigProvider, NGlobalStyle, NTag, useOsTheme } from 'naive-ui';
import { fetchLogs, fetchStatus, type Status } from './api';

const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === 'dark' ? darkTheme : null));

const status = ref<Status | null>(null);
const error = ref('');
const logs = ref<string[]>([]);
const logSource = ref('adapter');
const loading = ref(false);
let timer: number | undefined;

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
  await Promise.all([loadStatus(), loadLogs()]);
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
          <p class="subtitle">只读监控 · {{ loading ? '刷新中…' : '自动刷新 5s' }}</p>
        </div>
        <div class="header-actions">
          <a class="link" :href="status?.links.snowluma || 'http://127.0.0.1:5099'" target="_blank" rel="noreferrer noopener">打开 SnowLuma 控制台</a>
          <NButton size="small" type="primary" :loading="loading" @click="refresh">刷新</NButton>
        </div>
      </header>

      <p v-if="error" class="empty">状态读取失败：{{ error }}</p>

      <section class="grid">
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
    </main>
  </NConfigProvider>
</template>
