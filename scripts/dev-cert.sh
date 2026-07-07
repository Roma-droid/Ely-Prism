#!/usr/bin/env bash
#
# dev-cert.sh — generate a TLS certificate for the Figura Ely backend and import
# it into the JVM truststore that a launcher uses to run Minecraft.
#
# Why: Figura ALWAYS talks to its backend over https:// and wss:// — there is no
# plain-HTTP mode. So every client needs a certificate its game JVM trusts.
# Figura trusts `<java.home>/lib/security/cacerts` (plus its own bundled
# keystore), so we import our self-signed cert straight into that file. No public
# domain and no FIGURA_DOMAIN are required.
#
# The certificate covers localhost + this machine's LAN IP automatically, so the
# SAME backend works both locally and for friends on your local network.
#
# Usage:
#   ./scripts/dev-cert.sh [PATH_TO_cacerts | PATH_TO_java_home]
#
#   No argument  -> auto-detect the ElyPrismLauncher Java 21 runtime
#                   (java-runtime-delta), which MC 1.21.x uses.
#   CERT_SAN=... -> extra comma-separated hostnames/IPs to add to the cert
#                   (e.g. CERT_SAN=192.168.0.108,myhost.lan ./scripts/dev-cert.sh)
#   REGEN=1      -> force regenerating the cert even if one already exists.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$HERE/certs"
CRT="$CERT_DIR/figura-ely.crt"
KEY="$CERT_DIR/figura-ely.key"
ALIAS="figura-ely"
STOREPASS="changeit"

# --- detect this machine's primary LAN IPv4 -------------------------------
# Prefer a real NIC (skip VPN/virtual interfaces like tun/tap/wg/docker/veth),
# because those often own the default route and would hide the true LAN address.
detect_lan_ip() {
  local ip
  ip="$(ip -4 -o addr show scope global 2>/dev/null \
        | awk '$2 !~ /^(tun|tap|wg|docker|veth|br-|virbr)/ {print $4; exit}' \
        | cut -d/ -f1)"
  [[ -z "$ip" ]] && ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  [[ -z "$ip" ]] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "$ip"
}
LAN_IP="$(detect_lan_ip)"

# --- build the SAN list ----------------------------------------------------
# Always cover localhost; add the LAN IP; add anything from $CERT_SAN.
declare -A seen=()
SAN_ENTRIES=()
add_san() {
  local tok="$1"
  [[ -z "$tok" ]] && return
  [[ -n "${seen[$tok]:-}" ]] && return
  seen[$tok]=1
  if [[ "$tok" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    SAN_ENTRIES+=("IP:$tok")
  else
    SAN_ENTRIES+=("DNS:$tok")
  fi
}
add_san "localhost"
add_san "127.0.0.1"
add_san "$LAN_IP"
IFS=',' read -ra EXTRA <<< "${CERT_SAN:-}"
for h in "${EXTRA[@]}"; do add_san "$(echo "$h" | xargs)"; done
SAN_STR="$(IFS=,; echo "${SAN_ENTRIES[*]}")"

# --- resolve the target cacerts -------------------------------------------
resolve_cacerts() {
  local arg="${1:-}"
  if [[ -n "$arg" ]]; then
    if [[ "$arg" == *cacerts ]]; then echo "$arg"; return; fi
    if [[ -f "$arg/lib/security/cacerts" ]]; then echo "$arg/lib/security/cacerts"; return; fi
    echo "!! Not a cacerts file or java home: $arg" >&2; exit 1
  fi
  for c in \
    "$HOME/.local/share/ElyPrismLauncher/java/java-runtime-delta/lib/security/cacerts" \
    "$HOME/.local/share/PrismLauncher/java/java-runtime-delta/lib/security/cacerts" \
    "${JAVA_HOME:-/nonexistent}/lib/security/cacerts"; do
    [[ -f "$c" ]] && { echo "$c"; return; }
  done
  echo "!! Could not auto-detect a cacerts file. Pass the path explicitly:" >&2
  echo "   ./scripts/dev-cert.sh /path/to/java/lib/security/cacerts" >&2
  exit 1
}
CACERTS="$(resolve_cacerts "${1:-}")"

# --- generate the self-signed cert ----------------------------------------
mkdir -p "$CERT_DIR"
if [[ -f "$CRT" && -f "$KEY" && "${REGEN:-0}" != "1" ]]; then
  echo "== reusing existing cert: $CRT"
  echo "   (run with REGEN=1 to rebuild it, e.g. if your LAN IP changed)"
else
  echo "== generating self-signed cert"
  echo "   SAN = $SAN_STR"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY" -out "$CRT" \
    -days 3650 -subj "/CN=figura-ely" \
    -addext "subjectAltName=$SAN_STR"
fi

# --- bundle the cert into the mod so it ships inside the jar ---------------
MOD_RES="$HERE/../mod/src/main/resources"
if [[ -d "$MOD_RES" ]]; then
  cp "$CRT" "$MOD_RES/figura-ely.crt"
  echo "== copied cert into mod resources ($MOD_RES/figura-ely.crt)"
  echo "   -> rebuild the mod (./gradlew build) so the jar ships this cert"
fi

# --- import into the JVM truststore (for THIS machine / the host) ----------
echo "== importing cert into JVM truststore:"
echo "   $CACERTS"
if [[ ! -w "$CACERTS" ]]; then
  echo "!! No write permission for that cacerts — re-run with sudo, or point at a" >&2
  echo "   user-owned launcher JRE cacerts." >&2
fi
# Idempotent: drop previous imports (both current and legacy alias).
for a in "$ALIAS" figura-ely-localhost; do
  keytool -delete -alias "$a" -keystore "$CACERTS" -storepass "$STOREPASS" >/dev/null 2>&1 || true
done
keytool -importcert -noprompt -alias "$ALIAS" \
  -file "$CRT" -keystore "$CACERTS" -storepass "$STOREPASS"

# --- summary ---------------------------------------------------------------
# The address friends connect to: an explicit CERT_SAN wins over auto-detection.
PRIMARY="$LAN_IP"
[[ -n "${EXTRA[0]:-}" ]] && PRIMARY="$(echo "${EXTRA[0]}" | xargs)"
ADDR="${PRIMARY:-<this-machine-ip>}:4000"
cat <<EOF

======================================================================
Done. Certificate covers: $SAN_STR

ON THIS MACHINE (the host):
  1) Start the backend, listening on all interfaces:
       cd "$HERE"
       HOST=0.0.0.0 TLS_CERT="$CRT" TLS_KEY="$KEY" npm start
  2) In the game, config/figura-ely.json:
       "backendHost": "$ADDR"
  3) Make sure TCP port 4000 is open in the host firewall (see README).

FOR EACH FRIEND on the LAN:
  Just send them the rebuilt figura-ely-*.jar (+ Figura + Fabric API). The mod
  now bundles this certificate and trusts it automatically on launch (preLaunch),
  and the backend address ($ADDR) is baked in — NO keytool, NO config editing.
  They only need to be logged in through Ely.by.

  If auto-trust ever fails (read-only Java), the manual fallback still works:
       keytool -importcert -noprompt -alias figura-ely \\
         -file figura-ely.crt \\
         -keystore <their-java>/lib/security/cacerts -storepass changeit

Everyone must be logged in through Ely.by (ElyPrismLauncher / authlib-injector)
so their join is validated against Ely.by.
======================================================================
EOF
