"""Gera index.html a partir de src/app.html (a mesma página da app no Claude).

Uso:  python3 build.py
"""
from pathlib import Path
import hashlib
import base64
import re

ROOT = Path(__file__).parent
src = (ROOT / "src" / "app.html").read_text(encoding="utf-8")

# textos que só faziam sentido dentro do Claude
PATCHES = [
    ("Volte a ligá-lo em claude.ai → Definições → Conectores.", "Entre outra vez com a sua conta Google."),
    ("Adicione-o em claude.ai → Definições → Conectores.", "Entre com a sua conta Google."),
    ("Tem mais de um Google Calendar ligado. Escolha qual usar no aviso do Claude.", "Não foi possível escolher a agenda."),
    ("Carregue outra vez em Adicionar e aceite o pedido do Claude.", "Saia e entre outra vez, aceitando o acesso à agenda."),
    ("A agenda só funciona com a página aberta no Claude, com sessão iniciada.", "Entre com a sua conta Google para ver a agenda."),
    ("Só é possível adicionar com a página aberta no Claude, com sessão iniciada.", "Entre com a sua conta Google para adicionar."),
    ("Abra a página no Claude com sessão iniciada para descarregar ficheiros.", "Não foi possível descarregar o ficheiro."),
    (" registos guardados na nuvem", " registos no seu Google Drive"),
    (" com a página aberta no Claude, com sessão iniciada.", " depois de entrar com a sua conta Google."),
    ("Tente outra vez e aceite o pedido do Claude.", "Saia, entre outra vez e aceite o acesso à agenda."),
]
for old, new in PATCHES:
    src = src.replace(old, new)

# versão desta compilação: o site compara-a com a do servidor e recarrega se houver nova
BUILD = hashlib.sha1((src + (ROOT / "standalone.js").read_text(encoding="utf-8")).encode("utf-8")).hexdigest()[:12]

head = """<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#1d1c1a">
<meta http-equiv="Cache-Control" content="no-cache">
<meta name="bezerra-build" content="__BUILD__">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="HEROS.">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="icons/favicon.png?v=7">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png?v=7">
<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="config.js?v=__BUILD__"></script>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script src="standalone.js?v=__BUILD__"></script>
</head>
<body>
"""
page = head.replace("__BUILD__", BUILD) + src + "\n</body>\n</html>\n"
(ROOT / "index.html").write_text(page, encoding="utf-8")

# cabeçalhos de segurança para o Cloudflare (_headers): só corre o código do próprio site,
# do Google (login, Drive, Calendar) e do jsPDF; o script da página é autorizado pelo seu hash
inline = re.findall(r"<script>(.*?)</script>", page, re.S)
hashes = " ".join("'sha256-" + base64.b64encode(hashlib.sha256(b.encode("utf-8")).digest()).decode() + "'" for b in inline)
csp = "; ".join([
    "default-src 'self'",
    "script-src 'self' " + hashes + " https://accounts.google.com/gsi/client https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "connect-src 'self' https://www.googleapis.com https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
])
headers = """/*
  Content-Security-Policy: %s
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin-allow-popups
""" % csp
(ROOT / "_headers").write_text(headers, encoding="utf-8")
print("index.html gerado")
