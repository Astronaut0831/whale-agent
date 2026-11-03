# -*- coding: utf-8 -*-
"""
本地中文句向量服务（bge-small-zh-v1.5 量化版，ONNX CPU）

接口：POST /embed  {"texts": ["...", "..."]}  ->  {"vectors": [[...], [...]]}
      GET  /health -> {"ok": true, "dim": 512}

用法：python embed_server.py [端口]
主服务（Node）调不通时会自动退回字符相似度，所以这个进程挂了不影响聊天。
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, '..', 'runtime', 'models', 'bge-small-zh')

_lock = threading.Lock()
_session = None
_tokenizer = None
_input_names = []


def load():
    global _session, _tokenizer, _input_names
    if _session is not None:
        return
    model_path = os.path.join(MODEL_DIR, 'model_quantized.onnx')
    tok_path = os.path.join(MODEL_DIR, 'tokenizer.json')
    if not os.path.exists(model_path):
        raise RuntimeError('模型不存在：' + model_path)
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.intra_op_num_threads = 2
    _session = ort.InferenceSession(model_path, sess_options=so, providers=['CPUExecutionProvider'])
    _input_names = [i.name for i in _session.get_inputs()]
    _tokenizer = Tokenizer.from_file(tok_path)
    _tokenizer.enable_truncation(max_length=256)
    _tokenizer.enable_padding(length=None)
    print('[embed] 已加载 %s，输入 %s' % (model_path, _input_names), flush=True)


def embed(texts):
    load()
    texts = [str(t or '')[:512] for t in texts]
    encs = _tokenizer.encode_batch(texts)
    maxlen = max((len(e.ids) for e in encs), default=1)
    ids = np.zeros((len(encs), maxlen), dtype=np.int64)
    mask = np.zeros((len(encs), maxlen), dtype=np.int64)
    for i, e in enumerate(encs):
        n = len(e.ids)
        ids[i, :n] = e.ids
        mask[i, :n] = 1
    feeds = {}
    for name in _input_names:
        if name == 'input_ids':
            feeds[name] = ids
        elif name == 'attention_mask':
            feeds[name] = mask
        elif name == 'token_type_ids':
            feeds[name] = np.zeros_like(ids)
    with _lock:
        out = _session.run(None, feeds)[0]
    # BGE 用 [CLS] 作句向量，然后 L2 归一化
    vecs = out[:, 0, :]
    norm = np.linalg.norm(vecs, axis=1, keepdims=True)
    vecs = vecs / np.clip(norm, 1e-8, None)
    return vecs.tolist()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            try:
                load()
                self._json(200, {'ok': True, 'dim': 512})
            except Exception as e:
                self._json(500, {'ok': False, 'error': str(e)})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not self.path.startswith('/embed'):
            return self._json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            data = json.loads(self.rfile.read(n) or b'{}')
            texts = data.get('texts') or []
            if not isinstance(texts, list):
                return self._json(400, {'error': 'texts must be list'})
            if not texts:
                return self._json(200, {'vectors': []})
            if len(texts) > 64:
                texts = texts[:64]
            self._json(200, {'vectors': embed(texts)})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def log_message(self, fmt, *args):
        pass  # 安静


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    load()
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('[embed] 监听 http://127.0.0.1:%d' % port, flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
