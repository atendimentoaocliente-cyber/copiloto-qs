#!/usr/bin/env bash
# Remove uma máquina do Fly SEM derrubar call ativa.
#
#   1. POST /internal/drain na máquina (health → 503, para de aceitar sessão nova)
#   2. espera active_sessions == 0 (até 45 min)
#   3. fly machine stop + destroy
#
# Uso: scripts/drenar-maquina.sh <machine-id>
# Requer: INTERNAL_TOKEN, FLY_API_TOKEN, flyctl, curl, jq
set -euo pipefail
MAQUINA="${1:?informe o id da máquina}"
APP="${FLY_APP:-inovvatur-copiloto-api}"
URL="https://${APP}.fly.dev"
PRAZO_S="${PRAZO_S:-2700}"   # 45 min

echo "→ drenando ${MAQUINA}"
curl -sf -X POST "${URL}/internal/drain" \
  -H "Authorization: Bearer ${INTERNAL_TOKEN}" \
  -H "fly-force-instance-id: ${MAQUINA}" | jq .

INICIO=$(date +%s)
while :; do
  ATIVAS=$(curl -sf "${URL}/internal/sessoes" \
    -H "Authorization: Bearer ${INTERNAL_TOKEN}" \
    -H "fly-force-instance-id: ${MAQUINA}" | jq -r '.active_sessions' || echo "?")
  AGORA=$(date +%s)
  echo "  sessões ativas: ${ATIVAS}  (${((AGORA-INICIO))}s)"
  if [ "${ATIVAS}" = "0" ]; then break; fi
  if [ $((AGORA-INICIO)) -ge "${PRAZO_S}" ]; then
    echo "✗ prazo de ${PRAZO_S}s estourou com ${ATIVAS} sessão(ões). NÃO removendo. Decida manualmente."
    exit 1
  fi
  sleep 15
done

echo "→ zero sessões; removendo máquina"
flyctl machine stop "${MAQUINA}" -a "${APP}"
flyctl machine destroy "${MAQUINA}" -a "${APP}" --force
echo "✓ ${MAQUINA} removida"
