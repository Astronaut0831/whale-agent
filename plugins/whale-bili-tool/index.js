/** Read-only Bilibili tool for the agent: recommendations, search, video info, comments, frames. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/runtime.js';
import { fetchPopular, searchVideos } from '../lib/bilibili.js';
import { describe as describeImage } from '../lib/vision.js';

const API = 'https://api.bilibili.com';
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
};
const CACHE_DIR = path.join(repoRoot, 'data', 'bili-cache');
const NOTE_DIR = path.join(repoRoot, 'data', 'bili-notes');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8')); } catch { return {}; }
}

export function bvidOf(value) {
  const m = String(value || '').match(/\b(BV[0-9A-Za-z]{10})\b/);
  return m ? m[1] : '';
}

async function resolveBvid(value) {
  const raw = String(value || '').trim();
  const direct = bvidOf(raw);
  if (direct) return direct;
  const short = raw.match(/https?:\/\/b23\.tv\/[^\s"'<>]+/i);
  if (!short) return '';
  try {
    const r = await fetch(short[0], { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const fromUrl = bvidOf(r.url);
    if (fromUrl) return fromUrl;
    return bvidOf(await r.text());
  } catch {
    return '';
  }
}

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  if (!r.ok || !json) throw new Error('Bilibili request failed: HTTP ' + r.status);
  return json;
}

async function getView(bvid) {
  const j = await getJson(API + '/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
  if (j.code !== 0 || !j.data) throw new Error('Bilibili view: ' + (j.message || j.code));
  return j.data;
}

async function getComments(aid, limit = 5) {
  try {
    const j = await getJson(API + '/x/v2/reply?type=1&oid=' + encodeURIComponent(aid) + '&sort=2&ps=' + Math.min(20, Math.max(1, limit)) + '&pn=1');
    return ((j.data && j.data.replies) || []).map((x) => ({
      user: (x.member && x.member.uname) || '',
      text: String((x.content && x.content.message) || '').slice(0, 300),
      like: Number(x.like) || 0,
    }));
  } catch { return []; }
}

async function getSubtitles(bvid, cid) {
  try {
    const j = await getJson(API + '/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid));
    const subs = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
    if (!subs.length) return '';
    const url = subs[0].subtitle_url;
    if (!url) return '';
    const r = await fetch(url.startsWith('//') ? 'https:' + url : url, { headers: HEADERS });
    const arr = await r.json();
    return (Array.isArray(arr) ? arr : []).map((x) => String(x.content || '')).join(' ').slice(0, 5000);
  } catch { return ''; }
}

async function getAiConclusion(bvid, cid, upMid) {
  try {
    const j = await getJson(API + '/x/web-interface/view/conclusion/get?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid) + '&up_mid=' + encodeURIComponent(upMid));
    const d = j.data || {};
    return String(d.summary || d.conclusion || (d.result && d.result.summary) || '').trim().slice(0, 3000);
  } catch { return ''; }
}

function ffmpegBin(name) {
  const local = path.join(repoRoot, 'runtime', 'ffmpeg', 'bin', name + '.exe');
  return fs.existsSync(local) ? local : name;
}

function durationOf(file) {
  const p = spawnSync(ffmpegBin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', timeout: 15000 });
  return Number(String(p.stdout || '').trim()) || 0;
}

async function getPlayUrl(bvid, cid) {
  const j = await getJson(API + '/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid) + '&qn=32&fnval=1&fourk=0');
  const d = j.data || {};
  return d.durl && d.durl[0] && d.durl[0].url ? String(d.durl[0].url) : '';
}

async function downloadVideo(bvid, cid) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, bvid + '.mp4');
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const url = await getPlayUrl(bvid, cid);
  if (!url) throw new Error('没有拿到播放地址');
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('视频下载失败 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > 250 * 1024 * 1024) throw new Error('视频为空或超过 250MB');
  fs.writeFileSync(file, buf);
  return file;
}

function framesOf(video, bvid, duration) {
  const dir = path.join(CACHE_DIR, bvid + '-frames');
  fs.mkdirSync(dir, { recursive: true });
  const times = [0.12, 0.35, 0.6, 0.85].map((x) => Math.max(0, duration * x));
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const file = path.join(dir, 'f' + i + '.jpg');
    const p = spawnSync(ffmpegBin('ffmpeg'), ['-y', '-ss', String(times[i]), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-1', file], { encoding: 'utf8', timeout: 30000 });
    if (fs.existsSync(file) && fs.statSync(file).size > 0) out.push(file);
  }
  return out;
}

async function describeFrames(files, title) {
  const cfg = readConfig();
  const out = [];
  for (const file of files.slice(0, 4)) {
    try {
      const imageBase64 = fs.readFileSync(file).toString('base64');
      const text = await describeImage(cfg, { imageBase64, mime: 'image/jpeg', prompt: '这是B站视频的一帧。只描述画面里能确定的内容：人物、动作、物品、场景、画面文字；不要猜剧情。不超过60字。' });
      if (text) out.push(String(text).trim());
    } catch { /* visual is best effort */ }
  }
  return out;
}

export async function biliWatch(args = {}) {
  const mode = String(args.mode || 'feed');
  if (mode === 'feed') {
    const list = await fetchPopular(Math.min(10, Number(args.limit) || 6));
    const text = list.map((v) => `${v.bvid} | ${v.title} | ${v.owner} | ${Math.round((v.duration || 0) / 60)}分`).join('\n');
    return { ok: true, text: 'B站热门：\n' + text + '\n想看哪个就调用 bili_watch，mode=watch，bvid=...' };
  }
  if (mode === 'search') {
    const q = String(args.query || '').trim();
    if (!q) throw new Error('search 需要 query');
    const list = await searchVideos(q);
    const text = list.slice(0, 8).map((v) => `${v.bvid} | ${v.title} | ${v.owner}`).join('\n');
    return { ok: true, text: 'B站搜索：' + q + '\n' + text };
  }
  if (mode !== 'watch') throw new Error('mode 只能是 feed/search/watch');
  const bvid = await resolveBvid(args.bvid || args.url || '');
  if (!bvid) throw new Error('watch 需要 bvid 或 B站链接');
  const v = await getView(bvid);
  const aid = v.aid;
  const cid = v.cid;
  const title = String(v.title || '');
  const owner = String((v.owner && v.owner.name) || '');
  const desc = String(v.desc || '').slice(0, 1200);
  const [comments, subtitles, ai] = await Promise.all([
    getComments(aid, 6),
    getSubtitles(bvid, cid),
    getAiConclusion(bvid, cid, (v.owner && v.owner.mid) || 0),
  ]);
  let frames = [];
  let visual = [];
  let videoError = '';
  try {
    const file = await downloadVideo(bvid, cid);
    const duration = durationOf(file);
    frames = framesOf(file, bvid, duration || Math.min(600, Number(v.duration) || 60));
    visual = await describeFrames(frames, title);
  } catch (e) {
    videoError = String(e && e.message || e).slice(0, 160);
  }
  const note = {
    bvid, title, owner, url: 'https://www.bilibili.com/video/' + bvid,
    duration: Number(v.duration) || 0,
    desc, ai, subtitles, comments, visual, videoError, at: Date.now(),
  };
  try {
    fs.mkdirSync(NOTE_DIR, { recursive: true });
    fs.writeFileSync(path.join(NOTE_DIR, bvid + '.json'), JSON.stringify(note, null, 2), 'utf8');
  } catch { /* note is best effort */ }
  const lines = [
    'B站视频：' + title,
    'UP：' + owner + ' | 时长：' + Math.round((note.duration || 0) / 60) + ' 分钟',
    '链接：' + note.url,
    desc ? '简介：' + desc : '',
    ai ? 'B站AI摘要：' + ai : '',
    subtitles ? '字幕摘录：' + subtitles.slice(0, 1800) : '',
    visual.length ? '画面理解：\n- ' + visual.join('\n- ') : '',
    videoError ? '（画面没取到：' + videoError + '）' : '',
    comments.length ? '热评：\n' + comments.map((c) => '- ' + c.user + '：' + c.text).join('\n') : '',
    '（只读，不发评论）',
  ].filter(Boolean);
  return { ok: true, text: lines.join('\n').slice(0, 12000) };
}

const registered = new WeakSet();
export function registerBiliTool(agentCtx, config = {}) {
  if (!agentCtx || !agentCtx.tools || registered.has(agentCtx)) return false;
  registered.add(agentCtx);
  agentCtx.tools.register({
    name: 'bili_watch',
    description: 'Read Bilibili recommendations/search, or watch a video read-only: metadata, comments, subtitles and sampled frame descriptions. Never posts comments.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['feed', 'search', 'watch'], description: 'feed=热门，search=搜索，watch=看一个视频' },
        query: { type: 'string', description: 'search 关键词' },
        bvid: { type: 'string', description: 'watch 的 BV 号或链接' },
        limit: { type: 'number', description: 'feed 条数，默认 6' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
    },
    async execute(args) { return biliWatch(args); },
  });
  return true;
}

export const name = 'whale-bili-tool';
export const inject = ['agents'];
export function apply(ctx, config = {}) {
  const onAgent = ({ agent } = {}) => registerBiliTool(agent && agent.ctx, config);
  ctx.on('agent/created', onAgent);
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/start') return;
    const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(session && session.id) : null;
    if (agent) registerBiliTool(agent.ctx, config);
  });
}
export default { name, inject, apply };
