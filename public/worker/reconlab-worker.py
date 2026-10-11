#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ReconLab 执行器 (Worker) v1.0.0

在你自己授权的机器上运行，从 ReconLab 控制台领取任务并执行，
把资产与发现结果实时回传。零第三方依赖，只要有 Python 3.9+ 即可运行。

用法:
    python3 reconlab-worker.py --server https://your-console --email you@x.com --password ***
    python3 reconlab-worker.py --server https://your-console --email you@x.com --password *** --once

可选增强: 本机若已安装 nmap / subfinder / httpx / nuclei / whatweb /
         sqlmap，脚本会自动识别并在对应任务中优先调用；没有则使用内置引擎。

仅用于对已获书面授权目标的测试。
"""

import argparse
import concurrent.futures as futures
import json
import os
import platform
import random
import re
import socket
import ssl
import string
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0.0"
UA = "ReconLab-Worker/" + VERSION
LOG_LIMIT = 12000
LOG_KEEP = 220

# ═══════════════════════════════════════════════════════════════
# 内置字典
# ═══════════════════════════════════════════════════════════════

SUBDOMAIN_SMALL = """
www mail smtp pop imap webmail ns1 ns2 dns mx api dev test staging uat
admin portal vpn ftp cdn static img assets blog shop store app m mobile
git gitlab jenkins ci test1 demo beta old new backup db mysql redis
""".split()

SUBDOMAIN_MEDIUM = SUBDOMAIN_SMALL + """
www2 www3 web mail2 email exchange autodiscover owa remote rdp citrix
gw gateway firewall router switch proxy lb vip dmz internal intranet
corp office hr erp crm oa wiki docs confluence jira gitlab2 bitbucket
svn hg repo code build release registry docker k8s kube rancher
api2 api-v1 api-v2 rest graphql ws wss socket realtime push
app2 apps ios android h5 m wap touch pad tablet
cdn1 cdn2 static1 static2 img1 img2 assets1 media video file files
download upload up down ftp2 sftp ftps
shop mall cart pay payment billing invoice order account user member
admin2 adm manage manager console dashboard panel cp cpanel whm
blog2 news press media2 forum bbs community help support service
status monitor zabbix nagios grafana prometheus kibana elk
dev2 develop development testing test2 qa uat2 pre preprod prod
staging2 stage sandbox demo2 trial beta2 alpha canary
old2 legacy archive temp tmp bak backup2 db2 sql mysql2 postgres
redis2 mongo elastic search es cache memcache queue mq kafka rabbit
auth sso login id identity oauth sso2 ldap ad
sms mail3 smtp2 pop3 imap2 webdisk webmail2
ns3 ns4 dns2 dns1 dns3 mx1 mx2 mailgun sendgrid
""".split()

PORT_TOP = [21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 161, 389, 443, 445,
            465, 514, 587, 631, 636, 873, 993, 995, 1080, 1194, 1433, 1521, 1723,
            1883, 2049, 2082, 2083, 2181, 2222, 2375, 2376, 3000, 3128, 3268, 3306,
            3389, 3690, 4000, 4369, 4443, 4848, 5000, 5001, 5432, 5601, 5672, 5900,
            5901, 5984, 6000, 6379, 6443, 7001, 7002, 7070, 7199, 7474, 8000, 8001,
            8008, 8009, 8010, 8043, 8069, 8080, 8081, 8082, 8086, 8088, 8090, 8123,
            8161, 8180, 8200, 8443, 8500, 8529, 8600, 8649, 8686, 8800, 8834, 8880,
            8888, 8983, 9000, 9001, 9042, 9060, 9080, 9090, 9092, 9100, 9200, 9300,
            9443, 9600, 9999, 10000, 10250, 11211, 15672, 16379, 27017, 27018, 50070]

PORT_HIGH = [1024, 1080, 1099, 1158, 1521, 1604, 1701, 1741, 1755, 1812, 1863, 1900,
             2000, 2001, 2049, 2082, 2086, 2121, 2181, 2222, 2311, 2375, 2379, 2380,
             2404, 2443, 2480, 2601, 2638, 2809, 3000, 3001, 3005, 3128, 3180, 3222,
             3260, 3268, 3283, 3306, 3310, 3333, 3351, 3386, 3389, 3390, 3400, 3478,
             3500, 3517, 3527, 3541, 3542, 3560, 3580, 3659, 3689, 3690, 3702, 3724,
             3784, 3785, 3800, 4000, 4001, 4045, 4111, 4125, 4224, 4243, 4300, 4321,
             4333, 4369, 4443, 4444, 4500, 4502, 4567, 4664, 4711, 4730, 4786, 4800,
             4848, 4900, 4993, 5000, 5001, 5003, 5004, 5009, 5030, 5050, 5060, 5104,
             5190, 5222, 5269, 5280, 5298, 5353, 5357, 5405, 5414, 5432, 5433, 5440,
             5500, 5510, 5555, 5560, 5601, 5631, 5666, 5672, 5683, 5800, 5801, 5900,
             5901, 5984, 5985, 5986, 6000, 6001, 6002, 6004, 6050, 6101, 6112, 6267,
             6379, 6380, 6443, 6480, 6502, 6510, 6566, 6580, 6666, 6667, 6668, 6688,
             6697, 6789, 6881, 6969, 7000, 7001, 7002, 7004, 7007, 7019, 7070, 7071,
             7080, 7090, 7100, 7170, 7180, 7199, 7272, 7402, 7474, 7496, 7510, 7547,
             7548, 7657, 7676, 7680, 7687, 7697, 7777, 7778, 7800, 7878, 7890, 7900,
             7937, 7938, 7990, 7999, 8000, 8001, 8002, 8008, 8009, 8010, 8011, 8020,
             8021, 8022, 8031, 8032, 8042, 8043, 8045, 8050, 8060, 8069, 8080, 8081,
             8082, 8083, 8085, 8086, 8087, 8088, 8089, 8090, 8091, 8098, 8100, 8118,
             8123, 8126, 8161, 8172, 8180, 8181, 8188, 8192, 8194, 8200, 8222, 8243,
             8250, 8265, 8280, 8291, 8300, 8333, 8400, 8402, 8443, 8444, 8500, 8529,
             8530, 8531, 8600, 8649, 8686, 8688, 8800, 8834, 8880, 8888, 8889, 8899,
             8920, 8983, 8990, 8999, 9000, 9001, 9002, 9009, 9010, 9020, 9042, 9043,
             9050, 9060, 9080, 9081, 9090, 9091, 9092, 9100, 9101, 9160, 9200, 9220,
             9300, 9306, 9312, 9418, 9443, 9444, 9500, 9530, 9600, 9800, 9876, 9898,
             9900, 9901, 9981, 9987, 9990, 9999, 10000, 10001, 10010, 10050, 10051,
             10080, 10110, 10161, 10250, 10255, 10256, 10389, 10443, 10554, 10990,
             11000, 11001, 11211, 11300, 12000, 12345, 13579, 13720, 14000, 14147,
             14265, 14567, 15000, 15001, 15345, 15672, 16010, 16080, 16379, 16992,
             16993, 17000, 18080, 18081, 19101, 20000, 20560, 21025, 21379, 22222,
             23023, 23424, 24444, 24800, 25000, 25565, 25566, 26000, 27015, 27017,
             27018, 27019, 28017, 28080, 30000, 30071, 31000, 32000, 32768, 32769,
             32771, 33060, 33333, 34567, 35000, 36000, 36900, 37777, 40000, 44444,
             47001, 47808, 48080, 49152, 49153, 50000, 50030, 50060, 50070, 50075,
             50090, 54321, 55000, 55553, 55555, 56789, 60000, 61616, 62078, 65535]

DIR_SMALL = """
admin login wp-admin administrator api test backup uploads images js css
config .git .env robots.txt sitemap.xml phpinfo.php info.php server-status
manage dashboard console user users account static assets files data db
old new temp tmp log logs error errors web.config crossdomain.xml
""".split()

DIR_MEDIUM = DIR_SMALL + """
admin1 admin2 adminpanel admin_area adminarea admincp adminlogin
manage manager management manager/html console ui panel cp cpanel webadmin
login2 signin sign-in auth oauth sso sso2 account2 accounts profile user2
api api/v1 api/v2 api/v3 apis rest restapi graphql swagger swagger-ui
swagger-ui.html v2/api-docs v3/api-docs openapi.json api-docs api/health
health healthz status ping metrics actuator actuator/health actuator/env
actuator/beans actuator/mappings info env trace heapdump threaddump
druid druid/index.html monitor monitoring prometheus grafana kibana
backup backups bak baks old old2 oldsite temp tmp cache caches
test test1 test2 testing demo demo1 dev development staging stage
upload uploads uploadfiles download downloads files file media
images img image pics pictures photo photos assets static css js fonts
js/app.js css/main.css style.css main.js bundle.js webpack.config.js
robots.txt sitemap.xml sitemap_index.xml crossdomain.xml humans.txt
security.txt .well-known/security.txt favicon.ico manifest.json
.env .env.local .env.production .env.backup .git .git/config .git/HEAD
.gitignore .svn .svn/entries .hg .DS_Store .htaccess .htpasswd
config config.php config.json config.yml config.yaml configuration.php
settings.php wp-config.php web.config app.config database.yml
phpinfo.php info.php test.php phpinfo test.html debug.php
server-status server-info apache-status nginx_status
.git/config.bak backup.zip backup.tar.gz backup.sql dump.sql db.sql
data.sql database.sql www.zip wwwroot.zip site.zip web.zip source.zip
old.zip site.tar.gz backup.rar 1.zip 2.zip test.zip
phpmyadmin pma mysql adminer adminer.php dbadmin sqladmin
webmail mail roundcube squirrelmail phpmyadmin2
console jmx-console jolokia jolokia/list ws jboss jbossas
jenkins jenkins/login jenkins/script hudson bamboo teamcity
gitlab github bitbucket gitea gogs svn hg
confluence jira wiki docs doc documentation help support
log logs log.txt error.log access.log debug.log app.log
README.md README.txt readme.html CHANGELOG.md LICENSE
shell.php cmd.php upload.php uploader.php file.php files.php
xmlrpc.php wp-login.php wp-content wp-includes wp-json
administrator/index.php index.php index.html default.html
cgi-bin cgi-bin/ cgi-bin/test.cgi
""".split()

EXT_SUFFIX = ["", ".bak", ".old", ".zip", ".tar.gz", ".sql", "~", ".txt", ".1", ".save"]

SENSITIVE_PATHS = [
    ("/.git/config", ["[core]", "repositoryformatversion"]),
    ("/.env", ["APP_KEY", "DB_PASSWORD", "DB_HOST", "SECRET_KEY", "AWS_"]),
    ("/.svn/entries", ["dir", "svn"]),
    ("/config.php.bak", ["<?php", "db_"]),
    ("/web.config", ["<configuration", "connectionString"]),
    ("/backup.zip", None),
    ("/www.zip", None),
    ("/database.sql", ["INSERT INTO", "CREATE TABLE"]),
    ("/dump.sql", ["INSERT INTO", "CREATE TABLE"]),
    ("/.DS_Store", ["Bud1"]),
    ("/server-status", ["Apache Server Status", "Server Version"]),
    ("/phpinfo.php", ["phpinfo()", "PHP Version"]),
    ("/.htpasswd", [":$apr1$", ":$2y$"]),
    ("/id_rsa", ["BEGIN RSA PRIVATE KEY", "BEGIN OPENSSH PRIVATE KEY"]),
    ("/credentials", ["aws_access_key_id", "aws_secret_access_key"]),
]

EXPOSURE_PATHS = [
    ("/actuator/env", ["propertySources", "activeProfiles"], "Spring Actuator 环境信息未授权暴露"),
    ("/actuator/health", ['"status":"UP"'], "Spring Actuator 健康端点暴露"),
    ("/actuator/heapdump", None, "Spring Actuator 堆转储可直接下载"),
    ("/swagger-ui/index.html", ["swagger"], "Swagger 接口文档暴露"),
    ("/v2/api-docs", ['"swagger"', '"paths"'], "Swagger API 描述文件暴露"),
    ("/v3/api-docs", ['"openapi"', '"paths"'], "OpenAPI 描述文件暴露"),
    ("/druid/index.html", ["druid"], "Druid 监控面板未授权暴露"),
    ("/jenkins/", ["Jenkins"], "Jenkins 面板暴露"),
    ("/phpmyadmin/", ["phpMyAdmin"], "phpMyAdmin 面板暴露"),
    ("/adminer.php", ["Adminer"], "Adminer 数据库管理面板暴露"),
    ("/kibana", ["kibana"], "Kibana 面板暴露"),
    ("/grafana/login", ["grafana"], "Grafana 面板暴露"),
    ("/nacos/", ["nacos"], "Nacos 控制台暴露"),
    ("/solr/", ["solr"], "Solr 控制台暴露"),
    ("/api-docs", ['"paths"', '"swagger"'], "API 文档暴露"),
    ("/console", ["Web Console", "login"], "管理控制台入口暴露"),
]

REDIRECT_PARAMS = ["url", "redirect", "redirect_uri", "next", "return", "returnUrl", "target", "dest", "continue", "to"]
INJECT_PARAMS = ["id", "uid", "user", "username", "name", "page", "p", "q", "query", "search", "keyword",
                 "cat", "category", "type", "file", "path", "dir", "url", "link", "action", "do", "op",
                 "cmd", "exec", "code", "no", "num", "order", "sort", "key", "token", "lang"]

SECURITY_HEADERS = {
    "Strict-Transport-Security": ("缺少 HSTS 响应头", "low"),
    "X-Content-Type-Options": ("缺少 X-Content-Type-Options 响应头", "info"),
    "X-Frame-Options": ("缺少 X-Frame-Options 响应头,存在点击劫持风险", "low"),
    "Content-Security-Policy": ("缺少 CSP 响应头", "info"),
    "Referrer-Policy": ("缺少 Referrer-Policy 响应头", "info"),
}


# ═══════════════════════════════════════════════════════════════
# 控制台通信
# ═══════════════════════════════════════════════════════════════

class ConsoleError(Exception):
    pass


class Console(object):
    """ReconLab 控制台 API 客户端（PocketBase REST）"""

    def __init__(self, server, timeout=25):
        self.server = server.rstrip("/")
        self.timeout = timeout
        self.token = None
        self._lock = threading.Lock()

    def _request(self, method, path, body=None, query=None, auth=True, retries=3):
        url = self.server + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None and v != ""}
            if clean:
                url += "?" + urllib.parse.urlencode(clean, doseq=True)
        data = None
        headers = {"User-Agent": UA, "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if auth and self.token:
            headers["Authorization"] = self.token
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        attempt = 0
        wait = 3
        while True:
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read().decode("utf-8", "replace")
                return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode("utf-8", "replace")
                if exc.code >= 500 or exc.code == 429:
                    if attempt >= retries:
                        raise ConsoleError("控制台不可用 HTTP %d" % exc.code)
                    attempt += 1
                    time.sleep(min(wait, 60))
                    wait *= 2
                    continue
                raise ConsoleError("控制台返回 %d: %s" % (exc.code, raw[:180]))
            except (urllib.error.URLError, socket.timeout, TimeoutError) as exc:
                if attempt >= retries:
                    raise ConsoleError("无法连接控制台: %s" % exc)
                attempt += 1
                time.sleep(min(wait, 60))
                wait *= 2

    def login(self, identity, password):
        res = self._request("POST", "/api/collections/users/auth-with-password",
                            {"identity": identity, "password": password}, auth=False)
        self.token = res["token"]
        return res.get("record", {})

    def create(self, collection, body):
        return self._request("POST", "/api/collections/%s/records" % collection, body)

    def update(self, collection, record_id, body):
        return self._request("PATCH", "/api/collections/%s/records/%s" % (collection, record_id), body)

    def get(self, collection, record_id):
        return self._request("GET", "/api/collections/%s/records/%s" % (collection, record_id))

    def find(self, collection, **query):
        return self._request("GET", "/api/collections/%s/records" % collection, query=query)

    def find_one(self, collection, filter_expr, **query):
        query["filter"] = filter_expr
        query.setdefault("perPage", 1)
        res = self.find(collection, **query)
        items = res.get("items") or []
        return items[0] if items else None


# ═══════════════════════════════════════════════════════════════
# 日志
# ═══════════════════════════════════════════════════════════════

class Logger(object):
    def __init__(self, console, scan_id):
        self.console = console
        self.scan_id = scan_id
        self.lines = []
        self.lock = threading.Lock()
        self.last_push = 0.0
        self.dirty = False

    def log(self, msg, level="info"):
        stamp = time.strftime("%H:%M:%S")
        prefix = {"info": "", "ok": "[+] ", "warn": "[!] ", "err": "[-] "}.get(level, "")
        line = "%s %s%s" % (stamp, prefix, msg)
        with self.lock:
            self.lines.append(line)
            if len(self.lines) > LOG_KEEP:
                self.lines = self.lines[-LOG_KEEP:]
            self.dirty = True
        print(line, flush=True)

    def text(self):
        with self.lock:
            return "\n".join(self.lines)[-LOG_LIMIT:]

    def flush(self, force=False):
        with self.lock:
            if not self.dirty:
                return
            if not force and time.time() - self.last_push < 2.5:
                return
            payload = "\n".join(self.lines)[-LOG_LIMIT:]
            self.dirty = False
            self.last_push = time.time()
        try:
            self.console.update("scans", self.scan_id, {"log": payload})
        except ConsoleError:
            with self.lock:
                self.dirty = True


# ═══════════════════════════════════════════════════════════════
# HTTP / 网络工具
# ═══════════════════════════════════════════════════════════════

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_TLS_CTX = ssl.create_default_context()
_TLS_CTX.check_hostname = False
_TLS_CTX.verify_mode = ssl.CERT_NONE


def http_fetch(url, timeout=8, method="GET", headers=None, body=None, follow=True):
    """返回 dict(status, headers, body, url, elapsed, error)"""
    hdrs = {"User-Agent": "Mozilla/5.0 (compatible; %s)" % UA, "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
    if headers:
        hdrs.update(headers)
    data = body.encode("utf-8") if isinstance(body, str) else body
    if not follow:
        opener = urllib.request.build_opener(_NoRedirect(),
                                             urllib.request.HTTPSHandler(context=_TLS_CTX))
    else:
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_TLS_CTX))
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    started = time.time()
    result = {"status": 0, "headers": {}, "body": "", "url": url, "elapsed": 0.0, "error": None}
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read(200000)
            result["status"] = resp.status
            result["headers"] = {k: v for k, v in resp.headers.items()}
            result["url"] = resp.geturl()
            result["body"] = raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read(200000) if exc.fp else b""
        result["status"] = exc.code
        result["headers"] = {k: v for k, v in exc.headers.items()}
        result["body"] = raw.decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - 网络异常统一兜底
        result["error"] = "%s: %s" % (type(exc).__name__, exc)
    result["elapsed"] = time.time() - started
    return result


def normalize_url(value):
    if not value:
        return None
    if value.startswith(("http://", "https://")):
        return value
    return "http://" + value


def target_host(value):
    """从目标值里取出主机名（域名 / IP）"""
    value = (value or "").strip()
    if "://" in value:
        value = urllib.parse.urlsplit(value).hostname or value
    value = value.split("/")[0].split(":")[0]
    return value.strip()


def resolve(host, timeout=4):
    """解析主机名，返回去重后的 IP 列表"""
    try:
        socket.setdefaulttimeout(timeout)
        infos = socket.getaddrinfo(host, None)
        return sorted({info[4][0] for info in infos})
    except Exception:  # noqa: BLE001
        return []


def doh_query(name, rtype="A", timeout=5):
    """通过 Cloudflare DNS-over-HTTPS 查询，绕过本地解析限制"""
    url = "https://cloudflare-dns.com/dns-query?name=%s&type=%s" % (urllib.parse.quote(name), rtype)
    req = urllib.request.Request(url, headers={"Accept": "application/dns-json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        answers = data.get("Answer") or []
        return [a.get("data", "").strip('"') for a in answers if str(a.get("type")) in ("1", "5", "28")]
    except Exception:  # noqa: BLE001
        return []


def tcp_open(host, port, timeout=1.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:  # noqa: BLE001
        return False


def tls_probe(host, port=443, timeout=6):
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with _TLS_CTX.wrap_socket(sock, server_hostname=host) as ss:
                cert = ss.getpeercert() or {}
                version = ss.version()
        subject = ", ".join("%s=%s" % (k, v) for item in cert.get("subject", ()) for k, v in item)
        issuer = ", ".join("%s=%s" % (k, v) for item in cert.get("issuer", ()) for k, v in item)
        return {"version": version, "subject": subject, "issuer": issuer,
                "not_after": cert.get("notAfter", ""), "raw": cert}
    except Exception:  # noqa: BLE001
        return None


def extract_title(html):
    match = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.I | re.S)
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()[:150]


TECH_SIGNATURES = [
    ("WordPress", ["wp-content", "wp-includes", "/wp-json"]),
    ("Apache", ["Apache/"]),
    ("nginx", ["nginx"]),
    ("IIS", ["Microsoft-IIS"]),
    ("Tomcat", ["Apache-Coyote", "Tomcat"]),
    ("Jetty", ["Jetty"]),
    ("OpenResty", ["openresty"]),
    ("PHP", ["PHP/", "X-Powered-By: PHP", ".php"]),
    ("ASP.NET", ["ASP.NET", "X-AspNet-Version"]),
    ("JSP", ["JSESSIONID", ".jsp"]),
    ("Node.js", ["X-Powered-By: Express"]),
    ("Vue", ["vue.js", "__vue__", "data-v-"]),
    ("React", ["react", "__REACT"]),
    ("jQuery", ["jquery"]),
    ("Bootstrap", ["bootstrap"]),
    ("Spring Boot", ["Whitelabel Error Page", "spring"]),
    ("Shiro", ["rememberMe=deleteMe"]),
    ("Grafana", ["grafana"]),
    ("Jenkins", ["Jenkins"]),
    ("Kibana", ["kibana"]),
    ("F5 BIG-IP", ["BIG-IP", "F5"]),
    ("ThinkPHP", ["ThinkPHP"]),
    ("Django", ["csrfmiddlewaretoken"]),
    ("Laravel", ["laravel_session"]),
    ("Shopify", ["cdn.shopify.com"]),
    ("Cloudflare", ["cloudflare"]),
]


def detect_tech(headers, body):
    blob = (json.dumps(headers) + " " + (body or "")[:60000]).lower()
    found = []
    for name, needles in TECH_SIGNATURES:
        for needle in needles:
            if needle.lower() in blob:
                found.append(name)
                break
    return ",".join(found[:8])


def make_asset(host, port=None, service="", banner="", title="", tech="", status_code=None, url="", tls="", raw=None):
    asset = {"host": host, "service": service, "title": title, "tech": tech}
    if port:
        asset["port"] = port
    if banner:
        asset["banner"] = banner[:400]
    if status_code:
        asset["status_code"] = status_code
    if url:
        asset["url"] = url[:400]
    if tls:
        asset["tls"] = tls[:400]
    if raw:
        asset["raw"] = json.dumps(raw, ensure_ascii=False)[:2000]
    return asset


# ═══════════════════════════════════════════════════════════════
# 外部工具探测与调用
# ═══════════════════════════════════════════════════════════════

def which(binary):
    for path in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(path, binary)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


CAP_CACHE = {}


def caps():
    if not CAP_CACHE:
        for name in ["nmap", "subfinder", "httpx", "nuclei", "sqlmap", "whatweb", "curl", "dig"]:
            CAP_CACHE[name] = which(name)
        CAP_CACHE["builtin"] = "always"
    return CAP_CACHE


def caps_string():
    available = ["builtin"]
    for name in ["nmap", "subfinder", "httpx", "nuclei", "sqlmap", "whatweb"]:
        if CAP_CACHE.get(name) or caps().get(name):
            available.append(name)
    return ",".join(available)


def run_cmd(cmd, timeout=180):
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        return proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return "[cmd-error] %s" % exc


# ═══════════════════════════════════════════════════════════════
# 扫描器
# ═══════════════════════════════════════════════════════════════

def scan_subdomain(host, args, log):
    """子域枚举：字典 + DoH 解析，自动跳过泛解析"""
    assets = []
    level = args.get("dict", "medium")
    words = SUBDOMAIN_SMALL if level == "small" else SUBDOMAIN_MEDIUM
    if level == "large":
        words = SUBDOMAIN_MEDIUM + [p + s for p in ("dev-", "test-", "stg-", "api-", "app-", "beta-", "vpn-")
                                    for s in ("1", "2", "01", "02")] + \
            [s + v for s in ("www", "api", "app", "dev", "test") for v in ("-1", "-2", "-dev", "-test")]
    words = sorted(set(w.strip() for w in words if w.strip()))
    log.log("子域枚举开始: %s(字典 %d 条,档位 %s)" % (host, len(words), level))

    wildcard_ips = set()
    probe = "%s.%s" % ("".join(random.choices(string.ascii_lowercase, k=10)), host)
    for ip in (doh_query(probe) or resolve(probe)):
        wildcard_ips.add(ip)
    if wildcard_ips:
        log.log("检测到泛解析(随机子域可解析),将按 IP 差异过滤", "warn")

    concurrency = int(args.get("concurrency", 20) or 20)
    found = {}
    lock = threading.Lock()
    counter = {"done": 0}

    def worker_word(word):
        name = "%s.%s" % (word, host)
        ips = doh_query(name)
        if not ips:
            ips = resolve(name, timeout=3)
        with lock:
            counter["done"] += 1
        if not ips:
            return
        if wildcard_ips and set(ips).issubset(wildcard_ips):
            return
        with lock:
            found[name] = ips

    with futures.ThreadPoolExecutor(max_workers=max(4, min(concurrency, 60))) as pool:
        list(pool.map(worker_word, words))

    for name in sorted(found):
        assets.append(make_asset(name, service="dns", raw={"ips": found[name]}))
    log.log("子域枚举完成:解析成功 %d 个" % len(assets), "ok")

    # 证书透明日志补充
    try:
        ct = http_fetch("https://crt.sh/?q=%25.%s&output=json" % host, timeout=12)
        if ct["status"] == 200 and ct["body"]:
            names = set()
            for entry in json.loads(ct["body"])[:600]:
                for name in str(entry.get("name_value", "")).split("\n"):
                    name = name.strip().lower().lstrip("*.")
                    if name.endswith(host) and name != host and "*" not in name:
                        names.add(name)
            known = {a["host"] for a in assets}
            extra = sorted(names - known)[:120]
            for name in extra:
                ips = doh_query(name) or resolve(name)
                if ips and not (wildcard_ips and set(ips).issubset(wildcard_ips)):
                    assets.append(make_asset(name, service="dns", raw={"ips": ips, "source": "crt.sh"}))
            log.log("证书透明日志补充 %d 个域名" % len(extra))
    except Exception as exc:  # noqa: BLE001
        log.log("证书透明日志查询跳过: %s" % exc, "warn")
    return assets


def port_list(level):
    if level == "full":
        return list(range(1, 65536))
    if level == "top1000":
        return sorted(set(PORT_TOP + list(range(1, 1025)) + PORT_HIGH))
    return sorted(set(PORT_TOP))


PORT_SERVICE = {21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http",
                110: "pop3", 111: "rpcbind", 135: "msrpc", 139: "netbios", 143: "imap",
                161: "snmp", 389: "ldap", 443: "https", 445: "smb", 465: "smtps",
                587: "submission", 631: "ipp", 636: "ldaps", 873: "rsync", 993: "imaps",
                995: "pop3s", 1080: "socks", 1433: "mssql", 1521: "oracle", 2049: "nfs",
                2181: "zookeeper", 2375: "docker", 3000: "grafana/node", 3306: "mysql",
                3389: "rdp", 4443: "https-alt", 4848: "glassfish", 5000: "http-alt",
                5432: "postgresql", 5601: "kibana", 5672: "rabbitmq", 5900: "vnc",
                5984: "couchdb", 6379: "redis", 6443: "kubernetes", 7001: "weblogic",
                8000: "http-alt", 8009: "ajp", 8080: "http-proxy", 8081: "http-alt",
                8086: "influxdb", 8161: "activemq", 8443: "https-alt", 8500: "consul",
                8888: "http-alt", 8983: "solr", 9000: "http-alt", 9042: "cassandra",
                9090: "prometheus", 9092: "kafka", 9200: "elasticsearch", 9300: "es-transport",
                9443: "https-alt", 10000: "webmin", 11211: "memcached", 15672: "rabbitmq-mgmt",
                27017: "mongodb", 50070: "hadoop-namenode"}


def grab_banner(host, port, timeout=2.5):
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            if port in (21, 22, 25, 110, 143, 587, 993, 995, 3306, 5432, 6379, 11211, 27017):
                try:
                    data = sock.recv(256)
                    return data.decode("utf-8", "replace").strip()[:200]
                except Exception:  # noqa: BLE001
                    return ""
            if port in (80, 8000, 8080, 8081, 8888, 3000, 5000, 9000):
                sock.sendall(b"HEAD / HTTP/1.0\r\nHost: %s\r\n\r\n" % host.encode())
                data = sock.recv(512)
                return data.decode("utf-8", "replace").split("\r\n")[0].strip()[:200]
    except Exception:  # noqa: BLE001
        return ""
    return ""


def scan_port(host, args, log):
    assets = []
    level = args.get("ports", "top100")
    ports = port_list(level)
    concurrency = int(args.get("concurrency", 20) or 20)
    safe = bool(args.get("safe_mode", True))
    timeout = 1.4 if level != "full" else 1.0
    log.log("端口扫描开始: %s(共 %d 个端口,并发 %d)" % (host, len(ports), concurrency))

    open_ports = []
    lock = threading.Lock()
    counter = {"done": 0}
    total = len(ports)

    def probe(port):
        if tcp_open(host, port, timeout):
            with lock:
                open_ports.append(port)
        with lock:
            counter["done"] += 1
            if counter["done"] % 500 == 0:
                log.log("进度 %d/%d,已发现 %d 个开放端口" % (counter["done"], total, len(open_ports)))

    with futures.ThreadPoolExecutor(max_workers=max(8, min(concurrency * 4, 240))) as pool:
        list(pool.map(probe, ports))

    for port in sorted(open_ports):
        service = PORT_SERVICE.get(port, "")
        banner = grab_banner(host, port)
        if not service:
            if "SSH" in banner:
                service = "ssh"
            elif "HTTP" in banner:
                service = "http"
            elif "FTP" in banner:
                service = "ftp"
        assets.append(make_asset(host, port=port, service=service or "unknown", banner=banner))
        log.log("发现开放端口 %d/%s %s" % (port, service or "unknown", banner[:60]), "ok")
    log.log("端口扫描完成:开放 %d 个" % len(assets), "ok")
    return assets


def scan_http(host, args, log):
    assets = []
    timeout = int(args.get("timeout", 8) or 8)
    candidates = []
    if "://" in host:
        candidates.append(host)
    else:
        for port in [80, 443, 8080, 8443, 8000, 8888, 3000, 5000, 9000, 8000]:
            scheme = "https" if port in (443, 8443, 9443) else "http"
            candidates.append("%s://%s:%d/" % (scheme, host, port))
    seen = set()
    for url in candidates:
        parsed = urllib.parse.urlsplit(url)
        root = "%s://%s" % (parsed.scheme, parsed.netloc)
        if root in seen:
            continue
        seen.add(root)
        res = http_fetch(url, timeout=timeout)
        if res.get("error") or not res["status"]:
            continue
        headers = res["headers"]
        tech = detect_tech(headers, res["body"])
        title = extract_title(res["body"])
        tls_text = ""
        if parsed.scheme == "https":
            info = tls_probe(parsed.hostname, parsed.port or 443, timeout)
            if info:
                tls_text = "%s | 颁发者 %s | 到期 %s" % (info["version"], info["issuer"][:80], info["not_after"])
        assets.append(make_asset(
            parsed.hostname or host, port=parsed.port or (443 if parsed.scheme == "https" else 80),
            service=parsed.scheme, banner=headers.get("Server", ""), title=title, tech=tech,
            status_code=res["status"], url=res["url"], tls=tls_text,
            raw={"server": headers.get("Server"), "powered": headers.get("X-Powered-By"),
                 "location": headers.get("Location")},
        ))
        log.log("%s → %d %s | %s | %s" % (url, res["status"], title[:40], headers.get("Server", "-"), tech), "ok")
    if not assets:
        log.log("未探测到可访问的 HTTP 服务", "warn")
    return assets


def baseline_404(base, timeout):
    probe = base.rstrip("/") + "/" + "".join(random.choices(string.ascii_lowercase, k=12))
    res = http_fetch(probe, timeout=timeout, follow=True)
    return res["status"], len(res["body"] or "")


def scan_dir(host, args, log):
    assets = []
    base = normalize_url(host).rstrip("/")
    timeout = int(args.get("timeout", 8) or 8)
    level = args.get("dict", "medium")
    words = DIR_SMALL if level == "small" else DIR_MEDIUM
    if level == "large":
        words = DIR_MEDIUM + [w + s for w in DIR_MEDIUM[:120] for s in EXT_SUFFIX if s]
    words = sorted(set(w.strip("/") for w in words if w.strip()))
    concurrency = int(args.get("concurrency", 20) or 20)
    log.log("目录爆破开始: %s(字典 %d 条)" % (base, len(words)))

    status_404, len_404 = baseline_404(base, timeout)
    log.log("404 基线: 状态 %s / 长度 %d" % (status_404, len_404))

    hits = []
    lock = threading.Lock()

    def probe(word):
        url = "%s/%s" % (base, word)
        res = http_fetch(url, timeout=timeout, follow=False)
        status = res["status"]
        if not status:
            return
        length = len(res["body"] or "")
        interesting = False
        if status in (200, 204, 301, 302, 307, 401, 403, 405, 500):
            if status in (301, 302, 307, 401, 403, 405):
                interesting = True
            elif status == 200 and abs(length - len_404) > 24:
                interesting = True
            elif status == 500:
                interesting = True
        if interesting:
            with lock:
                hits.append((url, status, length, res["headers"].get("Location", "")))

    with futures.ThreadPoolExecutor(max_workers=max(4, min(concurrency * 2, 80))) as pool:
        list(pool.map(probe, words))

    for url, status, length, location in sorted(hits, key=lambda x: x[1])[:200]:
        assets.append(make_asset(urllib.parse.urlsplit(url).hostname or host, service="dir",
                                 title="%s → %d" % (url, status), status_code=status, url=url,
                                 raw={"length": length, "location": location}))
        log.log("[%d] %s%s" % (status, url, (" → " + location) if location else ""), "ok")
    log.log("目录爆破完成:命中 %d 条" % len(assets), "ok")
    return assets


def finding(title, severity, url, evidence, request=None, response=None, category="", parameter="",
            payload="", confidence=0.9, cve=""):
    return {
        "title": title, "severity": severity, "category": category, "url": url,
        "evidence": evidence, "request": (request or "")[:2500], "response": (response or "")[:2500],
        "parameter": parameter, "payload": payload, "confidence": confidence,
        "status": "new", "cve": cve,
    }


def req_text(url, method="GET", headers=None, body=None):
    lines = ["%s %s HTTP/1.1" % (method, url)]
    for key, value in (headers or {}).items():
        lines.append("%s: %s" % (key, value))
    if body:
        lines.append("")
        lines.append(body[:800])
    return "\n".join(lines)


def check_headers(url, res):
    out = []
    headers = {k.lower(): v for k, v in res["headers"].items()}
    missing = [k for k in SECURITY_HEADERS if k.lower() not in headers]
    if len(missing) >= 3:
        out.append(finding(
            "安全响应头缺失(%d 项)" % len(missing), "low", url,
            "响应缺少: %s。缺少这些头会降低浏览器侧防护能力。" % "、".join(missing),
            req_text(url), ("\n".join("%s: %s" % (k, v) for k, v in res["headers"].items()))[:1200],
            category="配置错误", confidence=0.95))
    server = headers.get("server", "")
    if server and re.search(r"\d+\.\d+", server):
        out.append(finding("服务端版本信息泄露", "info", url,
                           "Server 头暴露具体版本(%s),便于攻击者匹配已知漏洞。" % server,
                           req_text(url), "Server: %s" % server, category="信息泄露", confidence=0.9))
    powered = headers.get("x-powered-by", "")
    if powered:
        out.append(finding("X-Powered-By 信息泄露", "info", url,
                           "X-Powered-By 暴露技术栈(%s)。" % powered,
                           req_text(url), "X-Powered-By: %s" % powered, category="信息泄露", confidence=0.9))
    return out


def check_cors(url, res):
    origin = "https://reconlab-probe.example"
    probe = http_fetch(url, timeout=8, headers={"Origin": origin})
    acao = probe["headers"].get("Access-Control-Allow-Origin", "")
    acac = probe["headers"].get("Access-Control-Allow-Credentials", "")
    if acao == origin and acac.lower() == "true":
        return finding("CORS 配置错误(任意源 + 携带凭据)", "high", url,
                       "服务端回显任意 Origin 且允许携带凭据,任意站点可读取已登录用户的响应数据。",
                       req_text(url, headers={"Origin": origin}),
                       "Access-Control-Allow-Origin: %s\nAccess-Control-Allow-Credentials: %s" % (acao, acac),
                       category="配置错误", confidence=0.95)
    if acao == origin:
        return finding("CORS 允许任意源", "medium", url,
                       "服务端回显任意 Origin,跨域读取风险(未开启凭据时危害有限)。",
                       req_text(url, headers={"Origin": origin}),
                       "Access-Control-Allow-Origin: %s" % acao, category="配置错误", confidence=0.85)
    return None


def check_sensitive(base, base_res, timeout=8):
    out = []
    for path, needles in SENSITIVE_PATHS:
        url = base.rstrip("/") + path
        res = http_fetch(url, timeout=timeout, follow=False)
        if res["status"] != 200:
            continue
        body = res["body"] or ""
        if needles is None:
            if len(body) < 8:
                continue
            low = url.lower()
            if low.endswith((".zip", ".sql", ".tar.gz")) and not body.startswith("PK"):
                if ".sql" not in low:
                    continue
        elif not any(n.lower() in body.lower() for n in needles):
            continue
        severity = "high" if any(k in path for k in ["git", "env", "htpasswd", "id_rsa", "credential"]) else "medium"
        out.append(finding("敏感文件可未授权访问: %s" % path, severity, url,
                           "该路径可直接访问且返回了预期特征内容,可能泄露源码、凭据或配置。",
                           req_text(url), body[:1000], category="敏感文件", confidence=0.92))
    return out


def check_exposure(base, timeout=8):
    out = []
    for path, needles, title in EXPOSURE_PATHS:
        url = base.rstrip("/") + path
        res = http_fetch(url, timeout=timeout, follow=False)
        if res["status"] != 200:
            continue
        body = res["body"] or ""
        if needles and not any(n.lower() in body.lower() for n in needles):
            continue
        if not needles and len(body) < 32:
            continue
        severity = "high" if any(k in path for k in ["env", "heapdump", "druid", "jenkins"]) else "medium"
        out.append(finding("%s" % title, severity, url,
                           "该管理/文档端点在未授权状态下可访问(%s)。" % path,
                           req_text(url), body[:900], category="未授权访问", confidence=0.88))
    return out


def check_redirect(base, timeout=8):
    out = []
    marker = "https://reconlab-probe.example/redir"
    parsed = urllib.parse.urlsplit(base)
    for param in REDIRECT_PARAMS[:6]:
        for path in ["/", "/login", "/redirect", "/api/redirect"]:
            url = "%s%s?%s=%s" % (base.rstrip("/"), path, param, urllib.parse.quote(marker, safe=""))
            res = http_fetch(url, timeout=timeout, follow=False)
            location = res["headers"].get("Location", "")
            if res["status"] in (301, 302, 303, 307, 308) and "reconlab-probe.example" in location:
                out.append(finding("开放重定向", "medium", url,
                                   "参数 %s 可控制跳转目标到任意外部域名,可用于钓鱼跳转。" % param,
                                   req_text(url), "HTTP %d\nLocation: %s" % (res["status"], location),
                                   category="逻辑缺陷", parameter=param, payload=marker, confidence=0.9))
                return out
    return out


def check_traversal(base, timeout=8):
    payloads = [("../../../../etc/passwd", "root:x:0:0"), ("..%2f..%2f..%2f..%2fetc%2fpasswd", "root:x:0:0"),
                ("../../../../windows/win.ini", "[fonts]")]
    parsed = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parsed.query)
    params = list(query.keys()) or ["file", "path", "page", "download"]
    for param in params[:4]:
        for payload, needle in payloads:
            url = "%s://%s%s?%s=%s" % (parsed.scheme, parsed.netloc, parsed.path or "/", param,
                                       urllib.parse.quote(payload, safe=""))
            res = http_fetch(url, timeout=timeout, follow=False)
            if needle in (res["body"] or ""):
                return [finding("目录遍历 / 任意文件读取", "high", url,
                                "参数 %s 传入路径穿越 payload 后返回了系统文件内容(%s)。" % (param, needle),
                                req_text(url), res["body"][:900], category="文件读取",
                                parameter=param, payload=payload, confidence=0.95)]
    return []


def check_methods(url, res, timeout=8):
    out = []
    probe = http_fetch(url, timeout=timeout, method="OPTIONS")
    allow = probe["headers"].get("Allow", "") or probe["headers"].get("allow", "")
    dangerous = [m for m in ["PUT", "DELETE", "TRACE", "CONNECT"] if m in allow.upper()]
    if dangerous:
        out.append(finding("危险 HTTP 方法开启", "low", url,
                           "服务端 Allow 头声明支持 %s,可能允许未授权的文件写入/删除。" % ", ".join(dangerous),
                           req_text(url, method="OPTIONS"), "Allow: %s" % allow,
                           category="配置错误", confidence=0.8))
    return out


def check_sqli(base, timeout=8, safe=True):
    parsed = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if not query:
        return []
    params = [p for p in query if p.lower() in INJECT_PARAMS] or list(query.keys())
    for param in params[:3]:
        original = query[param][0] if query[param] else "1"
        if not re.match(r"^[0-9A-Za-z_\-]*$", original or "1"):
            continue
        def url_with(value):
            q = dict(query)
            q[param] = [value]
            return "%s://%s%s?%s" % (parsed.scheme, parsed.netloc, parsed.path or "/",
                                     urllib.parse.urlencode({k: v[0] for k, v in q.items()}))
        base_url = url_with(original)
        t0 = time.time()
        http_fetch(base_url, timeout=timeout)
        normal = time.time() - t0
        payload = "%s AND SLEEP(3)" % original
        injected_url = url_with(payload)
        t1 = time.time()
        res = http_fetch(injected_url, timeout=max(timeout, 12))
        delayed = time.time() - t1
        if delayed - normal > 2.2 and delayed > 2.5:
            # 第二轮复核，压制网络抖动造成的假阳性
            t2 = time.time()
            http_fetch(injected_url, timeout=max(timeout, 12))
            again = time.time() - t2
            if again - normal > 2.0:
                return [finding("SQL 注入(时间盲注,多轮复核)", "critical", injected_url,
                                "参数 %s 注入延时语句后响应稳定延迟 %.1fs(正常 %.1fs,复核 %.1fs),两轮一致。"
                                % (param, delayed, normal, again),
                                req_text(injected_url), "正常响应耗时 %.2fs / 注入后 %.2fs / 复核 %.2fs" % (normal, delayed, again),
                                category="注入", parameter=param, payload=payload, confidence=0.85)]
    return []


def check_xss(base, timeout=8):
    parsed = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if not query:
        return []
    params = [p for p in query if p.lower() in INJECT_PARAMS] or list(query.keys())
    marker = "rl" + "".join(random.choices(string.digits, k=5))
    payload = '"><svg/onload=alert(%s)>' % marker
    for param in params[:3]:
        q = dict(query)
        q[param] = [payload]
        url = "%s://%s%s?%s" % (parsed.scheme, parsed.netloc, parsed.path or "/",
                                urllib.parse.urlencode({k: v[0] for k, v in q.items()}))
        res = http_fetch(url, timeout=timeout)
        body = res["body"] or ""
        if payload in body or ("<svg/onload=alert(%s)>" % marker) in body:
            return [finding("反射型 XSS", "high", url,
                            "参数 %s 的值被原样输出到响应 HTML 中且未做转义,浏览器会执行注入脚本。" % param,
                            req_text(url), body[max(0, body.find(marker) - 200):body.find(marker) + 300],
                            category="XSS", parameter=param, payload=payload, confidence=0.85)]
    return []


VULN_CHECKERS = {
    "headers": "安全响应头缺失",
    "cors": "CORS 配置错误",
    "sensitive": "敏感文件泄露",
    "exposure": "后台/接口未授权暴露",
    "sqli": "SQL 注入",
    "xss": "反射型 XSS",
    "redirect": "开放重定向",
    "traversal": "目录遍历",
    "methods": "危险 HTTP 方法",
}


def scan_vuln(host, args, log):
    findings = []
    base = normalize_url(host).rstrip("/")
    timeout = int(args.get("timeout", 8) or 8)
    checks = args.get("checks") or list(VULN_CHECKERS.keys())
    safe = bool(args.get("safe_mode", True))
    log.log("漏洞扫描开始: %s(检测项 %d)" % (base, len(checks)))
    root = http_fetch(base, timeout=timeout)
    if root.get("error") or not root["status"]:
        log.log("目标不可访问: %s" % (root.get("error") or "无响应"), "err")
        return findings
    log.log("基线响应: HTTP %d / 长度 %d" % (root["status"], len(root["body"] or "")))

    steps = []
    if "headers" in checks:
        steps.append(("安全响应头", lambda: check_headers(base, root)))
    if "cors" in checks:
        steps.append(("CORS", lambda: [check_cors(base, root)] if check_cors(base, root) else []))
    if "sensitive" in checks:
        steps.append(("敏感文件", lambda: check_sensitive(base, root, timeout)))
    if "exposure" in checks:
        steps.append(("未授权暴露", lambda: check_exposure(base, timeout)))
    if "redirect" in checks:
        steps.append(("开放重定向", lambda: check_redirect(base, timeout)))
    if "traversal" in checks:
        steps.append(("目录遍历", lambda: check_traversal(base, timeout)))
    if "sqli" in checks:
        steps.append(("SQL 注入", lambda: check_sqli(base, timeout, safe)))
    if "xss" in checks:
        steps.append(("反射型 XSS", lambda: check_xss(base, timeout)))
    if "methods" in checks:
        steps.append(("HTTP 方法", lambda: check_methods(base, root, timeout)))

    for name, fn in steps:
        try:
            result = [f for f in (fn() or []) if f]
        except Exception as exc:  # noqa: BLE001
            log.log("检测项 %s 执行异常: %s" % (name, exc), "warn")
            continue
        if result:
            findings.extend(result)
            for f in result:
                log.log("[%s] %s" % (f["severity"].upper(), f["title"]), "ok")
        else:
            log.log("检测项 %s: 未命中" % name)
    log.log("漏洞扫描完成:发现 %d 条" % len(findings), "ok")
    return findings


def parse_json_field(raw):
    if not raw:
        return {}
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:  # noqa: BLE001
        return {}


def match_poc(res, matchers):
    if not matchers:
        return True, "未定义匹配规则,按状态码判定"
    statuses = matchers.get("status")
    if statuses and res["status"] not in statuses:
        return False, ""
    for needle in matchers.get("contains", []) or []:
        if needle and needle not in (res["body"] or ""):
            return False, ""
    for needle in matchers.get("regex", []) or []:
        try:
            if not re.search(needle, res["body"] or "", re.I | re.S):
                return False, ""
        except re.error:
            continue
    for needle in matchers.get("not_contains", []) or []:
        if needle and needle in (res["body"] or ""):
            return False, ""
    for key, pattern in (matchers.get("header") or {}).items():
        actual = ""
        for hk, hv in res["headers"].items():
            if hk.lower() == key.lower():
                actual = hv
                break
        if not actual:
            return False, ""
        try:
            if not re.search(pattern, actual, re.I):
                return False, ""
        except re.error:
            if pattern not in actual:
                return False, ""
    return True, "匹配规则全部命中"


def scan_poc(host, args, log, console):
    findings = []
    base = normalize_url(host).rstrip("/")
    timeout = int(args.get("timeout", 8) or 8)
    poc_ids = args.get("poc_ids") or []
    if not poc_ids:
        all_pocs = console.find("pocs", perPage=100, filter="enabled=true")
        poc_ids = [item["id"] for item in all_pocs.get("items", [])]
    if not poc_ids:
        log.log("POC 库为空,无可验证内容", "warn")
        return findings
    log.log("开始 POC 批量验证:%d 条" % len(poc_ids))

    for index, poc_id in enumerate(poc_ids, start=1):
        try:
            poc = console.get("pocs", poc_id)
        except ConsoleError as exc:
            log.log("读取 POC %s 失败: %s" % (poc_id, exc), "warn")
            continue
        name = poc.get("name") or poc_id
        path = poc.get("path") or "/"
        method = (poc.get("method") or "GET").upper()
        url = base + path if path.startswith("/") else "%s/%s" % (base, path)
        headers = parse_json_field(poc.get("headers"))
        matchers = parse_json_field(poc.get("matchers"))
        body = poc.get("body") or None
        res = http_fetch(url, timeout=timeout, method=method, headers=headers, body=body, follow=False)
        if res.get("error"):
            log.log("[%d/%d] %s → 请求失败(%s)" % (index, len(poc_ids), name, res["error"]))
            continue
        hit, reason = match_poc(res, matchers)
        if not hit:
            log.log("[%d/%d] %s → 未命中(HTTP %d)" % (index, len(poc_ids), name, res["status"]))
            continue
        # 第二轮复核
        second = http_fetch(url, timeout=timeout, method=method, headers=headers, body=body, follow=False)
        hit2, _ = match_poc(second, matchers)
        if not hit2:
            log.log("[%d/%d] %s → 首轮命中但复核未复现,判为不稳定结果" % (index, len(poc_ids), name), "warn")
            continue
        findings.append(finding(
            name, poc.get("severity") or "medium", url,
            "%s(两轮复核一致)。%s" % (reason, poc.get("description") or ""),
            req_text(url, method, headers, body), res["body"][:1000],
            category=poc.get("category") or "POC 验证", confidence=0.9,
        ))
        log.log("[%d/%d] %s → 命中并复核成功" % (index, len(poc_ids), name), "ok")
    log.log("POC 验证完成:命中 %d 条" % len(findings), "ok")
    return findings


# ═══════════════════════════════════════════════════════════════
# 任务执行
# ═══════════════════════════════════════════════════════════════

def flush_records(console, collection, records, log, start=0, step=50):
    """分批写入，批次之间留间隔，避免把后端压垮"""
    written = []
    for index in range(0, len(records), step):
        chunk = records[index:index + step]
        for record in chunk:
            try:
                written.append(console.create(collection, record))
            except ConsoleError as exc:
                log.log("写入 %s 失败: %s" % (collection, exc), "warn")
        if index + step < len(records):
            time.sleep(1.0)
    return written


def execute_scan(console, worker_id, scan, log):
    kind = scan.get("kind")
    target_id = scan.get("target")
    args = parse_json_field(scan.get("args"))
    target = {}
    try:
        target = console.get("targets", target_id) if target_id else {}
    except ConsoleError:
        target = {}
    raw_value = target.get("value") or ""
    host = target_host(raw_value)
    if not host:
        raise RuntimeError("目标值为空,无法执行")

    log.log("=" * 56)
    log.log("任务类型: %s" % kind)
    log.log("目标: %s (%s)" % (target.get("name") or raw_value, host))
    log.log("参数: %s" % json.dumps(args, ensure_ascii=False))
    log.log("=" * 56)

    stats = {}
    assets = []
    findings = []

    if kind == "subdomain":
        assets = scan_subdomain(host, args, log)
        stats = {"子域数量": len(assets)}
    elif kind == "port":
        assets = scan_port(host, args, log)
        stats = {"开放端口": len(assets)}
    elif kind == "http":
        assets = scan_http(raw_value or host, args, log)
        stats = {"HTTP 服务": len(assets)}
    elif kind == "dir":
        assets = scan_dir(raw_value or host, args, log)
        stats = {"命中路径": len(assets)}
    elif kind == "vuln":
        findings = scan_vuln(raw_value or host, args, log)
        by_sev = {}
        for item in findings:
            by_sev[item["severity"]] = by_sev.get(item["severity"], 0) + 1
        stats = {"发现总数": len(findings)}
        for sev, count in by_sev.items():
            stats[sev] = count
    elif kind == "poc":
        findings = scan_poc(raw_value or host, args, log, console)
        stats = {"POC 命中": len(findings)}
    else:
        raise RuntimeError("不支持的任务类型: %s" % kind)

    console.update("scans", scan["id"], {"progress": 80, "message": "结果回传中"})
    log.flush(force=True)

    if assets:
        for item in assets:
            item["scan"] = scan["id"]
            if target_id:
                item["target"] = target_id
        flush_records(console, "assets", assets, log)
        log.log("资产已回传 %d 条" % len(assets), "ok")

    if findings:
        for item in findings:
            item["scan"] = scan["id"]
            if target_id:
                item["target"] = target_id
        flush_records(console, "findings", findings, log)
        log.log("发现已回传 %d 条" % len(findings), "ok")

    return stats


# ═══════════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════════

def upsert_worker(console, name):
    hostname = socket.gethostname()
    caps_str = caps_string()
    payload = {
        "name": name or hostname,
        "hostname": hostname,
        "os": ("%s %s" % (platform.system(), platform.release()))[:80],
        "version": VERSION,
        "caps": caps_str,
        "status": "online",
        "last_seen": time.strftime("%Y-%m-%d %H:%M:%S.000Z", time.gmtime()),
    }
    existing = console.find_one("workers", "hostname=\"%s\"" % hostname, fields="id,name")
    if existing:
        console.update("workers", existing["id"], payload)
        return existing["id"]
    created = console.create("workers", payload)
    return created["id"]


def heartbeat(console, worker_id):
    console.update("workers", worker_id, {
        "status": "online",
        "last_seen": time.strftime("%Y-%m-%d %H:%M:%S.000Z", time.gmtime()),
        "caps": caps_string(),
    })


def claim_task(console, worker_id):
    pool = console.find("scans", filter="status='queued'", sort="created", perPage=5,
                        fields="id,name,kind,target,args,status,created")
    for candidate in pool.get("items", []):
        try:
            console.update("scans", candidate["id"], {
                "status": "running",
                "worker": worker_id,
                "progress": 3,
                "message": "执行器已领取任务",
                "started": time.strftime("%Y-%m-%d %H:%M:%S.000Z", time.gmtime()),
                "log": "[%s] 任务已被执行器 %s 领取\n" % (time.strftime("%H:%M:%S"), socket.gethostname()),
            })
        except ConsoleError:
            continue
        # 乐观锁复核：确认这个任务确实归我
        check = console.get("scans", candidate["id"])
        if check.get("worker") == worker_id:
            return check
    return None


def run_once(console, worker_id, log_prefix=""):
    scan = claim_task(console, worker_id)
    if not scan:
        return False
    log = Logger(console, scan["id"])
    started = time.time()
    try:
        stats = execute_scan(console, worker_id, scan, log)
        duration = time.time() - started
        payload = dict(stats or {})
        payload["耗时(秒)"] = round(duration, 1)
        console.update("scans", scan["id"], {
            "status": "done", "progress": 100, "message": "执行完成",
            "stats": json.dumps(payload, ensure_ascii=False),
            "log": log.text() + "\n[%s] 任务完成,耗时 %.1fs\n" % (time.strftime("%H:%M:%S"), duration),
            "finished": time.strftime("%Y-%m-%d %H:%M:%S.000Z", time.gmtime()),
        })
        print("任务 %s 执行完成(%.1fs)" % (scan.get("name"), duration), flush=True)
    except Exception as exc:  # noqa: BLE001
        log.log("任务失败: %s" % exc, "err")
        try:
            console.update("scans", scan["id"], {
                "status": "failed", "message": "执行失败: %s" % str(exc)[:180],
                "log": log.text(),
                "finished": time.strftime("%Y-%m-%d %H:%M:%S.000Z", time.gmtime()),
            })
        except ConsoleError:
            pass
        print("任务执行失败: %s" % exc, flush=True)
    return True


def main():
    parser = argparse.ArgumentParser(description="ReconLab 执行器 v%s" % VERSION)
    parser.add_argument("--server", required=True, help="控制台地址,例如 https://xxx.web.zaka.live")
    parser.add_argument("--email", required=True, help="控制台账号邮箱")
    parser.add_argument("--password", required=True, help="控制台账号密码")
    parser.add_argument("--name", default="", help="执行器显示名称")
    parser.add_argument("--once", action="store_true", help="只执行一个任务就退出")
    parser.add_argument("--interval", type=float, default=6.0, help="空闲轮询间隔(秒)")
    args = parser.parse_args()

    console = Console(args.server)
    try:
        user = console.login(args.email, args.password)
    except ConsoleError as exc:
        print("登录失败: %s" % exc)
        return 2
    print("已登录控制台: %s" % user.get("email", args.email))

    worker_id = upsert_worker(console, args.name)
    print("执行器已注册: %s (能力: %s)" % (worker_id, caps_string()))

    if args.once:
        run_once(console, worker_id)
        heartbeat(console, worker_id)
        return 0

    print("开始轮询任务，Ctrl+C 退出")
    last_beat = 0.0
    try:
        while True:
            if time.time() - last_beat > 20:
                try:
                    heartbeat(console, worker_id)
                    last_beat = time.time()
                except ConsoleError as exc:
                    print("心跳失败: %s" % exc)
            did_work = run_once(console, worker_id)
            if not did_work:
                time.sleep(max(2.0, args.interval))
    except KeyboardInterrupt:
        print("\n退出中…")
        try:
            console.update("workers", worker_id, {"status": "offline"})
        except ConsoleError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
