#!/usr/bin/env bash
# Registra o PapaToken como serviço de usuário do systemd (Linux).
# Rode uma vez:  bash scripts/install-autostart.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NPM="$(command -v npm)"

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/papatoken.service <<EOF
[Unit]
Description=PapaToken - aproveitador de tokens ociosos
After=network.target

[Service]
WorkingDirectory=${REPO}
ExecStart=${NPM} run start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now papatoken.service

echo "Serviço 'papatoken' ativo — http://127.0.0.1:3333"
echo "Logs:    journalctl --user -u papatoken -f"
echo "Remover: systemctl --user disable --now papatoken"
echo ""
echo "Para o serviço rodar sem você estar logado (servidor headless):"
echo "  sudo loginctl enable-linger $USER"
