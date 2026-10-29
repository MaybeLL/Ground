"""Host-restricted HTTP(S) download proxy owned by the preparation supervisor."""
import base64
import http.client
import http.server
import select
import socket
import threading
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def load_git_credentials(hosts, aliases=None):
    """Read operator-local configuration; never pass secrets to preparation scripts."""
    filename = os.environ.get('GROUNDS_PREPARE_GIT_CREDENTIALS')
    if not filename:
        return {}
    entries = json.loads(Path(filename).read_text())
    result = {}
    for entry in entries:
        remote = entry['repository']
        target = urlsplit(remote)
        if target.hostname not in hosts:
            continue
        if (target.scheme != 'https' or target.port not in (None, 443)
                or target.hostname not in hosts or target.username or target.password
                or target.query or target.fragment or not target.path.endswith('.git')
                or any(part in ('.', '..', '') for part in target.path.split('/')[1:])
                or '%' in target.path or '\\' in target.path):
            raise ValueError('credential repository must be an allowlisted HTTPS Git URL')
        lines = Path(entry['token_file']).read_text().splitlines()
        line = entry.get('token_line', 1)
        if not isinstance(line, int) or line < 1 or line > len(lines):
            raise ValueError('invalid credential token line')
        token = lines[line - 1].strip()
        if not token or any(c.isspace() for c in token):
            raise ValueError('invalid Git credential')
        result[remote] = token
        identity = entry.get('source_identity', remote)
        if not isinstance(identity, str) or not identity:
            raise ValueError('invalid source identity')
        if aliases is not None:
            if identity in aliases and aliases[identity] != remote:
                raise ValueError('conflicting repository transport mappings')
            aliases[identity] = remote
    return result


class PreparationProxy:
    def __init__(self, hosts, git_credentials=None):
        self.hosts = {h.lower() for h in hosts}
        self.git_credentials = git_credentials or {}
        self.git_routes = {'http://grounds-git.invalid/' + str(i) + '.git': remote
                           for i, remote in enumerate(self.git_credentials)}
        self.git_urls = {remote: local for local, remote in self.git_routes.items()}
        self.connections = set(); self.lock = threading.Lock(); self.closed = False
        proxy = self
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version='HTTP/1.0'
            def log_message(self,*_): pass
            def authorize(self, host):
                # The preparation sandbox can connect only to this exact, ephemeral
                # loopback port.  Do not put credentials in the proxy URL: besides
                # leaking through process environments, URL credentials are often
                # persisted by download tools.  The proxy still independently
                # enforces the declared destination-host allowlist.
                if host.lower() not in proxy.hosts or proxy.closed:
                    self.send_error(403); return False
                return True
            def do_CONNECT(self):
                target=urlsplit('https://'+self.path)
                if not target.hostname or target.username or target.password or not self.authorize(target.hostname):return
                remote=None
                try:
                    remote=socket.create_connection((target.hostname,target.port or 443),timeout=15)
                    with proxy.lock:proxy.connections.add(remote);proxy.connections.add(self.connection)
                    self.send_response(200);self.end_headers()
                    while not proxy.closed:
                        ready,_,_=select.select([remote,self.connection],[],[],.2)
                        for source in ready:
                            data=source.recv(65536)
                            if not data:return
                            (self.connection if source is remote else remote).sendall(data)
                except (OSError,ValueError):pass
                finally:
                    if remote:
                        with proxy.lock:proxy.connections.discard(remote);proxy.connections.discard(self.connection)
                        remote.close()
            def do_GET(self):self.forward()
            def do_POST(self):self.forward()
            def do_HEAD(self):self.forward()
            def forward(self):
                target=urlsplit(self.path)
                if target.hostname == 'grounds-git.invalid':
                    self.forward_git(target)
                    return
                if target.scheme!='http' or not target.hostname or target.username or target.password or not self.authorize(target.hostname):
                    if target.scheme!='http':self.send_error(403)
                    return
                remote=None;remote_socket=None
                try:
                    length=int(self.headers.get('Content-Length','0'))
                    if length<0 or length>64*1024*1024 or self.headers.get('Transfer-Encoding'):self.send_error(413);return
                    body=self.rfile.read(length) if length else None
                    headers={k:v for k,v in self.headers.items() if k.lower() not in ('proxy-authorization','proxy-connection','connection','host')}
                    headers['Connection']='close'
                    remote=http.client.HTTPConnection(target.hostname,target.port or 80,timeout=30)
                    path=target.path or '/'
                    if target.query:path+='?'+target.query
                    remote.connect();remote_socket=remote.sock
                    with proxy.lock:proxy.connections.add(remote_socket);proxy.connections.add(self.connection)
                    remote.request(self.command,path,body,headers);response=remote.getresponse()
                    self.send_response(response.status)
                    for k,v in response.getheaders():
                        if k.lower() not in ('connection','transfer-encoding'):self.send_header(k,v)
                    self.end_headers()
                    if self.command!='HEAD':
                        while not proxy.closed:
                            data=response.read(65536)
                            if not data:break
                            self.wfile.write(data)
                except (OSError,ValueError,http.client.HTTPException):
                    try:self.send_error(502)
                    except OSError:pass
                finally:
                    if remote_socket:
                        with proxy.lock:proxy.connections.discard(remote_socket);proxy.connections.discard(self.connection)
                    if remote:remote.close()
            def forward_git(self, target):
                # Only Git smart-HTTP fetch endpoints; no API, push, redirects or arbitrary paths.
                if not self.authorize(next(iter(proxy.hosts), '')):
                    return
                base, separator, tail = target.path.partition('.git/')
                local = 'http://grounds-git.invalid' + base + '.git'
                remote_url = proxy.git_routes.get(local)
                valid = ((self.command == 'GET' and tail == 'info/refs'
                          and target.query == 'service=git-upload-pack')
                         or (self.command == 'POST' and tail == 'git-upload-pack'
                             and not target.query))
                if (not separator or not remote_url or not valid or target.scheme != 'http'
                        or target.netloc != 'grounds-git.invalid' or target.fragment):
                    self.send_error(403); return
                remote = None; remote_socket = None
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if length < 0 or length > 64*1024*1024 or self.headers.get('Transfer-Encoding'):
                        self.send_error(413); return
                    body = self.rfile.read(length) if length else None
                    upstream = urlsplit(remote_url)
                    auth = base64.b64encode(('oauth2:' + proxy.git_credentials[remote_url]).encode()).decode()
                    headers = {'Authorization': 'Basic ' + auth, 'Connection': 'close'}
                    for key in ('Content-Type', 'Git-Protocol', 'Accept'):
                        if self.headers.get(key): headers[key] = self.headers[key]
                    remote = http.client.HTTPSConnection(upstream.hostname, 443, timeout=30)
                    path = upstream.path + '/' + tail
                    if target.query: path += '?' + target.query
                    remote.connect()
                    remote_socket = remote.sock
                    with proxy.lock: proxy.connections.add(remote_socket)
                    remote.request(self.command, path, body, headers)
                    response = remote.getresponse()
                    if response.status != 200:
                        self.send_error(502, 'Git repository fetch failed'); return
                    expected = ('application/x-git-upload-pack-advertisement' if self.command == 'GET'
                                else 'application/x-git-upload-pack-result')
                    if response.getheader('Content-Type', '').split(';')[0] != expected:
                        self.send_error(502, 'Unexpected Git response'); return
                    self.send_response(200); self.send_header('Content-Type', expected); self.end_headers()
                    while not proxy.closed:
                        data = response.read(65536)
                        if not data: break
                        self.wfile.write(data)
                except (OSError, ValueError, http.client.HTTPException):
                    try: self.send_error(502, 'Git repository fetch failed')
                    except OSError: pass
                finally:
                    if remote:
                        with proxy.lock: proxy.connections.discard(remote_socket)
                        remote.close()
        self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.url='http://127.0.0.1:'+str(self.server.server_port)

    @property
    def port(self):return self.server.server_port

    def __enter__(self):self.thread.start();return self

    def __exit__(self,*_):
        self.closed=True;self.server.shutdown();self.server.server_close();self.thread.join()
        with self.lock:
            for connection in self.connections:
                try:connection.shutdown(socket.SHUT_RDWR)
                except OSError:pass
                connection.close()
            self.connections.clear()
        self.git_credentials.clear()
