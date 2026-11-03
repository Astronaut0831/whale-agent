# 桥接：定期导出会话目录（名字 -> wxid），供 /listen add 名字 使用
import io

P = r'D:\dsh-workspace\chat\whale_gril\examples\wechatauto_bridge.py'
src = io.open(P, encoding='utf-8').read()

# 1) 在 recent_chats 后面加导出函数
if 'def dump_chat_directory' not in src:
    anchor = '''    def notify_away():'''
    func = '''    def dump_chat_directory():
        """把最近会话写成 data/chats.json，让服务端 /listen add 名字 能解析到 wxid。"""
        try:
            items = []
            for s in (db.get_sessions(limit=50) or []):
                u = str(s.get("username") or "")
                if not u or u == "filehelper":
                    continue
                items.append({
                    "id": u,
                    "name": display_name(u),
                    "kind": "group" if u.endswith("@chatroom") else "private",
                })
            path = os.path.join(ROOT, "data", "chats.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"items": items, "ts": time.time()}, f, ensure_ascii=False)
        except Exception:
            pass

    def chat_directory_loop():
        while True:
            dump_chat_directory()
            time.sleep(60)

''' + anchor
    if anchor in src:
        src = src.replace(anchor, func, 1)
        print('OK 导出函数')

# 2) 启动线程
if 'chat_directory_loop, daemon=True' not in src:
    anchor2 = 'threading.Thread(target=listener_watch, daemon=True).start()'
    src = src.replace(anchor2, anchor2 + '\n    threading.Thread(target=chat_directory_loop, daemon=True).start()', 1)
    print('OK 线程')

io.open(P, 'w', encoding='utf-8').write(src)
print('写入完成')
