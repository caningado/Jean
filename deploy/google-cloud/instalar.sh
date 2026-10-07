#!/usr/bin/env bash
# Instala (ou atualiza) o sistema do guincho num servidor do Google Cloud (e2-micro, Debian 12).
# Uso, no botão "SSH" do servidor:
#   curl -fsSL https://raw.githubusercontent.com/caningado/Jean/master/deploy/google-cloud/instalar.sh | sudo bash
#
# O que ele faz: instala o Docker, baixa o sistema, guarda banco e fotos em /opt/towing/dados,
# liga o https sozinho (endereço grátis <ip>.sslip.io), faz cópia diária do banco e
# busca atualizações do GitHub toda madrugada. Pode rodar de novo sem perder nada.
set -euo pipefail

REPO="${REPO:-https://github.com/caningado/Jean.git}"
BRANCH="${BRANCH:-master}"
BASE=/opt/towing

if [ "$(id -u)" -ne 0 ]; then echo "Rode com sudo."; exit 1; fi
echo "==> Instalando o sistema do guincho em $BASE"

# 1 GB de memória é pouco para montar o sistema: cria 2 GB de memória extra no disco.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null || ! command -v git >/dev/null || ! command -v sqlite3 >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io git curl sqlite3 >/dev/null
fi
systemctl enable --now docker >/dev/null

mkdir -p "$BASE/dados" "$BASE/caddy" "$BASE/backups"
if [ -d "$BASE/app/.git" ]; then
  git -C "$BASE/app" fetch -q origin "$BRANCH" && git -C "$BASE/app" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$BASE/app"
fi

# Configuração: criada uma vez a partir do exemplo; depois edite com: sudo towing-config
if [ ! -f "$BASE/.env" ]; then
  grep -v '^PORT=' "$BASE/app/.env.example" | sed 's/^MODULES=.*/# MODULES= (vazio = todos os módulos)/' > "$BASE/.env"
  chmod 600 "$BASE/.env"
fi

# Endereço público: IP do servidor (Google) -> 34-12-56-78.sslip.io (grátis, com https).
IP=$(curl -fs -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
[ -n "$IP" ] || IP=$(curl -fs https://api.ipify.org)
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
echo "$DOMAIN" > "$BASE/endereco"

echo "==> Montando o sistema (pode levar alguns minutos na primeira vez)"
docker network inspect towing >/dev/null 2>&1 || docker network create towing >/dev/null
docker build -q -t towing "$BASE/app" >/dev/null
docker rm -f towing >/dev/null 2>&1 || true
docker run -d --name towing --restart unless-stopped --network towing \
  -v "$BASE/dados:/data" --env-file "$BASE/.env" towing >/dev/null

# Caddy: recebe o https e repassa para o sistema. Pega o certificado sozinho.
docker rm -f caddy >/dev/null 2>&1 || true
docker run -d --name caddy --restart unless-stopped --network towing -p 80:80 -p 443:443 \
  -v "$BASE/caddy:/data" caddy:2 caddy reverse-proxy --from "$DOMAIN" --to towing:3000 >/dev/null

# Atalhos
cat > /usr/local/bin/towing-config <<'SH'
#!/usr/bin/env bash
# Edita a configuração (Zelle, WhatsApp, preços...) e reinicia o sistema.
set -e
nano /opt/towing/.env
docker rm -f towing >/dev/null
docker run -d --name towing --restart unless-stopped --network towing -v /opt/towing/dados:/data --env-file /opt/towing/.env towing >/dev/null
echo "Pronto, configuração aplicada."
SH
cat > /usr/local/bin/towing-atualizar <<SH
#!/usr/bin/env bash
# Busca a versão nova no GitHub; só reinstala se mudou alguma coisa.
set -e
cd $BASE/app
git fetch -q origin $BRANCH
if [ "\$(git rev-parse HEAD)" != "\$(git rev-parse origin/$BRANCH)" ] || [ "\${1:-}" = "--forcar" ]; then
  curl -fsSL https://raw.githubusercontent.com/caningado/Jean/$BRANCH/deploy/google-cloud/instalar.sh | REPO=$REPO BRANCH=$BRANCH DOMAIN=\$(cat $BASE/endereco) bash
else
  echo "Já está na versão mais nova."
fi
SH
cat > /usr/local/bin/towing-backup <<'SH'
#!/usr/bin/env bash
# Cópia do banco (guarda 30 dias). As fotos ficam em /opt/towing/dados/uploads.
set -e
DB=/opt/towing/dados/guincho.db
[ -f "$DB" ] || exit 0
sqlite3 "$DB" ".backup '/opt/towing/backups/guincho-$(date +%F).db'"
find /opt/towing/backups -name 'guincho-*.db' -mtime +30 -delete
SH
chmod +x /usr/local/bin/towing-config /usr/local/bin/towing-atualizar /usr/local/bin/towing-backup

# Toda madrugada (horário de Nova York): cópia do banco às 3h e atualização às 4h.
cat > /etc/cron.d/towing <<'CRON'
CRON_TZ=America/New_York
0 3 * * * root /usr/local/bin/towing-backup >> /var/log/towing.log 2>&1
0 4 * * * root /usr/local/bin/towing-atualizar >> /var/log/towing.log 2>&1
CRON

sleep 5
if docker ps --filter name=towing --filter status=running | grep -q towing; then
  echo
  echo "✅ Pronto! Abra no celular:  https://$DOMAIN"
  echo "   (o https pode levar 1 minuto para ligar na primeira vez)"
  echo "   Configurar Zelle, WhatsApp e preços:  sudo towing-config"
else
  echo "⚠️  O sistema não ligou. Veja o erro com:  sudo docker logs towing"
  exit 1
fi
