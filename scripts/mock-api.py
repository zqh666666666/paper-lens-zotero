from http.server import BaseHTTPRequestHandler, HTTPServer
import json
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.headers.get('Authorization')!='Bearer integration-test-key':
            self.send_response(401);self.end_headers();return
        if self.path!='/chat/completions' or body.get('model')!='fixture-model':
            self.send_response(400);self.end_headers();return
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        for text in ['这是本地模拟 API 的测试回答。','转速变化会影响信号。[P1-1]','\n方法采用角域重采样。[P2-1]']:
            self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'content':text}}]},ensure_ascii=False)+'\n\n').encode());self.wfile.flush()
        self.wfile.write(b'data: [DONE]\n\n')
    def log_message(self,*args):pass
HTTPServer(('127.0.0.1',18765),Handler).serve_forever()
