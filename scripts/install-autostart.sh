#!/usr/bin/env bash
# Registra o PacmanToken como serviço de usuário do systemd (Linux).
# Rode uma vez:  bash scripts/install-autostart.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NPM="$(command -v npm)"

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/pacmantoken.service <<EOF
[Unit]
Description=PacmanToken - aproveitador de tokens ociosos
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
systemctl --user enable --now pacmantoken.service

echo "Serviço 'pacmantoken' ativo — http://127.0.0.1:3333"
echo "Logs:    journalctl --user -u pacmantoken -f"
echo "Remover: systemctl --user disable --now pacmantoken"
echo ""
echo "Para o serviço rodar sem você estar logado (servidor headless):"
echo "  sudo loginctl enable-linger $USER"
